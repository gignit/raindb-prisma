/**
 * Wire types for the RainDB GraphQL surface that the adapter speaks to.
 *
 * These mirror the RainDB GraphQL schema. Only the fields the adapter
 * consumes are modeled; the server may return more.
 */

/** A single periscope SQL result, as returned by the `executeSQL` query. */
export interface RainDBSQLResult {
  columns: string[];
  /** Each row is a JSON object keyed by column name (GraphQL `JSON` scalar). */
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  durationMs: number;
  truncated: boolean;
  /**
   * Per-formation freshness bookmark. Present when the query referenced a
   * formation with a `by-update` index. Drives the read-your-writes
   * "drift merge" (see src/read/freshness.ts).
   *
   * Returned by RainDB's executeSQL for formations with a by-update index.
   */
  latest?: RainDBFormationLatest[];
}

/**
 * The server-computed drift verdict for one formation's Periscope SQL snapshot
 * versus its live writes. RainDB distills the two cursors into this single
 * verdict, so the adapter reads it directly rather than comparing
 * snapshotDropletId vs currentDropletId itself (re-deriving is how a client
 * gets the cold-current guard wrong and reports false drift):
 *
 *   - CURRENT     -- snapshot covers the newest write; no merge needed.
 *   - BEHIND      -- live writes exist past the snapshot; drift-merge the tail.
 *   - UNKNOWN     -- the current-side pointer could not be observed; drift is
 *                    undetermined (NOT a false CURRENT). Do not merge on this
 *                    verdict alone -- the snapshot rows are authoritative.
 *   - UNAVAILABLE -- the formation declares no by-update index; no bookmark.
 *
 * Mirrors the RainDB GraphQL FreshnessStatus enum.
 */
export type FreshnessStatus = 'CURRENT' | 'BEHIND' | 'UNKNOWN' | 'UNAVAILABLE';

/**
 * Freshness bookmark for one formation referenced by a SQL query.
 *
 * `snapshotDropletId` is the cursor the Periscope columnar snapshot was
 * built up to; `currentDropletId` is the live newest write (the formation-wide
 * meta latest.json pointer). The server distills these into
 * {@link RainDBFormationLatest.freshnessStatus}; when it is `BEHIND` the missing
 * droplets are harvested forward from `snapshotDropletId` under `indexPrefix`.
 *
 * Mirrors the RainDB GraphQL FormationLatest type.
 */
export interface RainDBFormationLatest {
  formationId: string;
  snapshotDropletId: string;
  snapshotKey: string;
  snapshotAt?: string;
  currentDropletId: string;
  currentKey: string;
  indexPrefix: string;
  /**
   * Server-computed drift verdict -- read THIS to decide whether to
   * drift-merge, rather than comparing snapshotDropletId vs currentDropletId.
   */
  freshnessStatus: FreshnessStatus;
}

/** A droplet envelope as returned by readLatest / readCurrent / listDroplets. */
export interface RainDBDroplet<T = Record<string, unknown>> {
  dropletId: string;
  payload: T;
  ts?: number;
  floatMeta?: unknown;
}

/** Result of a writeDroplet mutation. */
export interface RainDBWriteResult {
  dropletId: string;
  /** Stable entity id; nullable on the wire (auto-gen formations populate it). */
  scopeValue?: string | null;
  /** Public URLs for floated fields (list, in field order). */
  publicUrls?: string[] | null;
}

/** One key entry from listKeys. */
export interface RainDBKeyEntry {
  key: string;
  size?: number;
}

/** A page of keys from listKeys. */
export interface RainDBKeyPage {
  keys: RainDBKeyEntry[];
  nextCursor?: string | null;
  hasMore: boolean;
}
