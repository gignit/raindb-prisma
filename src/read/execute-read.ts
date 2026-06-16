/**
 * Read path: queryRaw -> RainDB Periscope executeSQL (+ optional freshness
 * drift merge).
 *
 * Prisma hands the adapter parameterized SQL with positional `$N` args. The
 * RainDB Periscope SQL surface (executeSQL) takes a SQL string, so the
 * adapter inlines the parameters as safe SQL literals before sending. This
 * is the analytical/list plane.
 *
 * When freshness === 'merge', the read also requests the per-formation
 * freshness bookmark and, if the columnar snapshot is behind live writes,
 * fetches + injects the missing droplets so the result is read-your-writes
 * consistent (see ./freshness.ts).
 */
import type { SqlQuery, SqlResultSet } from '@prisma/driver-adapter-utils';
import type { ResolvedConfig } from '../config.js';
import type { RainDBClient } from '../raindb/client.js';
import type { FormationNameMap } from '../sql/identifiers.js';
import { toSqlResultSet } from './column-types.js';
import { inlineParams } from './inline-params.js';
import { driftMerge } from './freshness.js';
import { formationHintFromSQL } from './formation-hint.js';
import { rewriteToEntitySchema } from './rewrite-sql.js';
import { tryResolveById } from './by-id.js';

export interface ReadDeps {
  client: RainDBClient;
  cfg: ResolvedConfig;
  nameMap: FormationNameMap;
  scopeKeyOf: (formationId: string) => string;
}

export async function executeRead(deps: ReadDeps, query: SqlQuery): Promise<SqlResultSet> {
  const { client, cfg } = deps;
  const inlined = inlineParams(query.sql, query.args, query.argTypes);
  const sql = rewriteToEntitySchema(inlined);

  // Route single-record-by-id reads to the resolution plane (readLatest):
  // strongly consistent + 0ms on the wire cache, so a just-written record is
  // visible immediately (Periscope SQL is eventually consistent).
  const byId = await tryResolveById(
    { client, cfg, nameMap: deps.nameMap, scopeKeyOf: deps.scopeKeyOf },
    sql,
    query.args,
  );
  if (byId) return byId;

  const formationId = formationHintFromSQL(sql);

  // The server returns the freshness bookmark unconditionally when the
  // formation has a by-update index; cfg.freshness decides whether we act on
  // it (merge / signal / off), not whether we request it.
  let result;
  try {
    result = await client.executeSQL(sql, {
      ...(formationId ? { formationId } : {}),
    });
  } catch (err) {
    // A periscope-enabled formation that has not yet been pooled has no
    // columnar snapshot/view registered, and executeSQL errors instead of
    // returning empty. For a fresh formation (or one between writes and its
    // first pool) the correct Prisma semantics is an empty result, not a
    // hard failure. Detect that class of error and degrade to no rows.
    if (isNoSnapshotError(err)) {
      cfg.logger.debug('raindb.read: no snapshot yet, returning empty result', {
        formationId,
      });
      return toSqlResultSet([], []);
    }
    throw err;
  }

  let rows = result.rows;
  let columns = result.columns;

  if (cfg.freshness === 'merge' && result.latest && result.latest.length > 0) {
    const merged = await driftMerge(client, cfg, {
      columns,
      rows,
      latest: result.latest,
    });
    rows = merged.rows;
    columns = merged.columns;
  } else if (cfg.freshness === 'signal' && result.latest) {
    for (const b of result.latest) {
      if (b.snapshotDropletId !== b.currentDropletId) {
        cfg.logger.debug('raindb.read: drift detected (signal-only)', {
          formationId: b.formationId,
          snapshot: b.snapshotDropletId,
          current: b.currentDropletId,
        });
      }
    }
  }

  return toSqlResultSet(columns, rows);
}

/**
 * Detect the "periscope-enabled formation has no snapshot/view yet" class of
 * executeSQL error. Such a formation (freshly published, or written-to but
 * not yet pooled) has no columnar catalog to attach, so the server fails the
 * query instead of returning empty. We map that to an empty result so a fresh
 * formation behaves like an empty table.
 *
 * Matched against the error wrapping RainDB returns when the columnar view
 * cannot yet be attached: "register view for formation", "build formation
 * view SQL", plus the catalog/snapshot not-found phrasings.
 */
function isNoSnapshotError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('register view for formation') ||
    msg.includes('build formation view sql') ||
    msg.includes('no snapshot') ||
    msg.includes('no current snapshot') ||
    msg.includes('catalog not found') ||
    msg.includes('no metadata') ||
    (msg.includes('table') && msg.includes('does not exist') && msg.includes('entity'))
  );
}
