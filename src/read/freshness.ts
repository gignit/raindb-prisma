/**
 * Freshness drift merge -- the read-your-writes closer for list queries.
 *
 * RainDB's Periscope SQL plane is eventually consistent: the columnar
 * snapshot lags live droplet writes. The executeSQL response carries a
 * per-formation freshness bookmark (snapshotDropletId vs currentDropletId).
 * When they differ, the snapshot is missing the droplets written after the
 * snapshot cursor.
 *
 * This module closes that gap WITHOUT waiting for a server-side pool:
 *   1. Detect drift (snapshot != current) per formation in the query.
 *   2. List the missing droplet ids in the `by-update.desc` span
 *      (snapshotKey, currentKey] via listKeys on the index prefix.
 *   3. Parallel-fetch those droplets (resolution plane, readLatest by id).
 *   4. Merge their payloads into the SQL result rows (newest version wins),
 *      so the returned set reflects live data.
 *
 * The bookmark is returned by RainDB's executeSQL response for any formation
 * with a by-update index.
 *
 * NOTE: this is a best-effort, bounded merge. It only enriches results for
 * single-formation queries whose row shape matches the droplet payload
 * (the common findMany case). For multi-formation joins, drift is surfaced
 * but rows are not rewritten (the join semantics aren't reconstructable
 * client-side); callers needing strict freshness there should use
 * window:0 server-side or route the hot edge through a by-id read.
 */
import type { ResolvedConfig } from '../config.js';
import type { RainDBClient } from '../raindb/client.js';
import type { RainDBFormationLatest } from '../raindb/types.js';

export interface DriftMergeInput {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  latest: RainDBFormationLatest[];
}

export interface DriftMergeOutput {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export async function driftMerge(
  client: RainDBClient,
  cfg: ResolvedConfig,
  input: DriftMergeInput,
): Promise<DriftMergeOutput> {
  const drifted = input.latest.filter(
    (b) => b.snapshotDropletId !== b.currentDropletId && b.indexPrefix,
  );
  if (drifted.length === 0) {
    return { columns: input.columns, rows: input.rows };
  }

  // Single-formation merge only (see module note). For multi-formation
  // queries we surface drift via logging and return the snapshot rows.
  if (drifted.length > 1) {
    cfg.logger.debug('raindb.freshness: multi-formation drift, not merging rows', {
      formations: drifted.map((d) => d.formationId),
    });
    return { columns: input.columns, rows: input.rows };
  }

  const bookmark = drifted[0]!;
  cfg.logger.debug('raindb.freshness: drift detected, merging', {
    formationId: bookmark.formationId,
    snapshot: bookmark.snapshotDropletId,
    current: bookmark.currentDropletId,
  });

  const newerIds = await listNewerDropletIds(client, cfg, bookmark);
  if (newerIds.length === 0) {
    return { columns: input.columns, rows: input.rows };
  }

  const droplets = await fetchDroplets(client, bookmark.formationId, newerIds);

  return mergeRows(input, droplets);
}

/**
 * List droplet ids written after the snapshot cursor by walking the
 * `by-update` index prefix. The bookmark's indexPrefix points at the
 * by-update index root; we list keys after the snapshot key up to current.
 */
async function listNewerDropletIds(
  client: RainDBClient,
  cfg: ResolvedConfig,
  bookmark: RainDBFormationLatest,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  // `after` filters keys lexicographically greater than the snapshot key,
  // which (UUIDv7 chronological) yields exactly the droplets newer than the
  // snapshot cursor.
  const after = bookmark.snapshotKey || undefined;

  // Hard budgets so a far-behind snapshot on a large formation can never
  // make a read hang: cap pages AND wall-clock. When we blow the budget we
  // degrade to signal (return what we have / none) rather than walk forever.
  const deadline = Date.now() + cfg.driftMergeBudgetMs;
  let pages = 0;

  do {
    if (Date.now() > deadline || pages >= cfg.driftMergeMaxPages) {
      cfg.logger.warn('raindb.freshness: drift merge budget exceeded, degrading to signal', {
        formationId: bookmark.formationId,
        pages,
        collected: ids.length,
      });
      return [];
    }
    pages++;
    const page = await client.listKeys(bookmark.indexPrefix, {
      pageSize: Math.min(1000, cfg.maxDriftMerge - ids.length),
      ...(cursor ? { cursor } : {}),
      ...(after ? { after } : {}),
    });
    for (const entry of page.keys) {
      const id = dropletIdFromIndexKey(entry.key);
      if (id) ids.push(id);
      if (ids.length >= cfg.maxDriftMerge) break;
    }
    cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
  } while (cursor && ids.length < cfg.maxDriftMerge);

  if (ids.length >= cfg.maxDriftMerge) {
    cfg.logger.warn('raindb.freshness: drift merge hit maxDriftMerge cap', {
      formationId: bookmark.formationId,
      cap: cfg.maxDriftMerge,
    });
  }
  return ids;
}

/**
 * Extract a droplet/scope id from a by-update index key.
 * by-update template: indexes/<f>/by-update/<scope>/latest.json
 * The id is the segment before the trailing `latest.json`.
 */
function dropletIdFromIndexKey(key: string): string | null {
  const parts = key.split('/');
  const last = parts[parts.length - 1];
  if (last === 'latest.json') {
    return parts[parts.length - 2] ?? null;
  }
  // full-index leaf: <dropletId>.json
  if (last?.endsWith('.json')) {
    return last.replace(/\.json$/, '');
  }
  return null;
}

async function fetchDroplets(
  client: RainDBClient,
  formationId: string,
  scopeValues: string[],
): Promise<Array<Record<string, unknown>>> {
  const results = await Promise.all(
    scopeValues.map((sv) =>
      client.readLatest(formationId, 'by-id-latest', sv).catch(() => null),
    ),
  );
  const out: Array<Record<string, unknown>> = [];
  for (const d of results) {
    if (d && d.payload && typeof d.payload === 'object') {
      out.push(d.payload as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * Merge newer droplet payloads into the SQL rows. Newer droplets replace any
 * snapshot row with the same primary identifier and are appended when new.
 * The primary identifier is inferred from the columns present in both the
 * row and the droplet (we prefer a column literally named like an id; else
 * fall back to the first column).
 */
function mergeRows(
  input: DriftMergeInput,
  droplets: Array<Record<string, unknown>>,
): DriftMergeOutput {
  if (droplets.length === 0) {
    return { columns: input.columns, rows: input.rows };
  }

  const idCol = inferIdColumn(input.columns);
  const projected = droplets.map((d) => projectToColumns(d, input.columns));

  if (!idCol) {
    // No id column to dedupe on; append projected droplets.
    return { columns: input.columns, rows: [...projected, ...input.rows] };
  }

  const byId = new Map<unknown, Record<string, unknown>>();
  for (const row of input.rows) byId.set(row[idCol], row);
  for (const row of projected) byId.set(row[idCol], row); // newer wins

  return { columns: input.columns, rows: Array.from(byId.values()) };
}

function inferIdColumn(columns: string[]): string | undefined {
  const lower = columns.map((c) => c.toLowerCase());
  const exact = lower.indexOf('id');
  if (exact !== -1) return columns[exact];
  const endsWithId = lower.findIndex((c) => c.endsWith('id'));
  if (endsWithId !== -1) return columns[endsWithId];
  return columns[0];
}

function projectToColumns(
  droplet: Record<string, unknown>,
  columns: string[],
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const col of columns) {
    row[col] = col in droplet ? droplet[col] : null;
  }
  return row;
}
