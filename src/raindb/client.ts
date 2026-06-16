/**
 * RainDB GraphQL transport.
 *
 * A thin, dependency-free client over the RainDB GraphQL surface
 * over the RainDB GraphQL API. It exposes exactly the operations the Prisma
 * adapter needs:
 *
 *   - executeSQL   -> the periscope analytical/list plane (reads)
 *   - readLatest   -> the resolution plane (O(1) by-id/by-index reads)
 *   - writeDroplet -> the immutable append write
 *   - listKeys     -> index walks for the freshness drift merge
 *
 * Auth uses `Authorization: Bearer rdb_...` (pkg/auth/middleware.go accepts
 * both Bearer and X-API-Key; Bearer is the canonical shape).
 */
import type { ResolvedConfig } from '../config.js';
import { RainDBError, RainDBNotFoundError } from '../errors.js';
import type {
  RainDBDroplet,
  RainDBKeyPage,
  RainDBSQLResult,
  RainDBWriteResult,
} from './types.js';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

const EXECUTE_SQL = /* GraphQL */ `
  query AdapterExecuteSQL($input: SQLInput!) {
    executeSQL(input: $input) {
      columns
      rows
      rowCount
      durationMs
      truncated
      latest {
        formationId
        snapshotDropletId
        snapshotKey
        snapshotAt
        currentDropletId
        currentKey
        indexPrefix
      }
    }
  }
`;

const READ_LATEST = /* GraphQL */ `
  query AdapterReadLatest($input: ReadLatestInput!) {
    readLatest(input: $input) {
      dropletId
      payload
      ts
    }
  }
`;

const WRITE_DROPLET = /* GraphQL */ `
  mutation AdapterWriteDroplet($input: WriteDropletInput!) {
    writeDroplet(input: $input) {
      dropletId
      scopeValue
    }
  }
`;

const LIST_KEYS = /* GraphQL */ `
  query AdapterListKeys($input: ListKeysInput!) {
    listKeys(input: $input) {
      keys {
        key
        size
      }
      nextCursor
      hasMore
    }
  }
`;

export interface WriteDropletArgs {
  formationId: string;
  payload: Record<string, unknown>;
  author?: string;
  triggerFlows?: boolean;
  /** Optional idempotency key to dedupe retried writes. */
  idempotencyKey?: string;
}

export class RainDBClient {
  readonly #cfg: ResolvedConfig;

  constructor(cfg: ResolvedConfig) {
    this.#cfg = cfg;
  }

  /**
   * Run a read-only SQL query against the Periscope plane.
   *
   * The freshness bookmark (`latest`) is returned UNCONDITIONALLY by the
   * server whenever the formation has a `by-update` index -- there is no
   * request flag for it (SQLInput is { sql, formationId?, timeoutMs? }). The
   * adapter decides whether to ACT on the bookmark via cfg.freshness, not by
   * asking the server for it.
   */
  async executeSQL(
    sql: string,
    opts: { formationId?: string; timeoutMs?: number } = {},
  ): Promise<RainDBSQLResult> {
    const input: Record<string, unknown> = { sql };
    if (opts.formationId) input.formationId = opts.formationId;
    if (opts.timeoutMs !== undefined) input.timeoutMs = opts.timeoutMs;
    const data = await this.#request<{ executeSQL: RainDBSQLResult }>(EXECUTE_SQL, {
      input,
    });
    return data.executeSQL;
  }

  async readLatest(
    formationId: string,
    indexId: string,
    scopeValue: string,
  ): Promise<RainDBDroplet | null> {
    try {
      const data = await this.#request<{ readLatest: RainDBDroplet | null }>(READ_LATEST, {
        input: { formationId, indexId, scopeValue },
      });
      return data.readLatest ?? null;
    } catch (err) {
      if (err instanceof RainDBNotFoundError) return null;
      throw err;
    }
  }

  async writeDroplet(args: WriteDropletArgs): Promise<RainDBWriteResult> {
    const input: Record<string, unknown> = {
      formationId: args.formationId,
      payload: args.payload,
    };
    if (args.author !== undefined) input.author = args.author;
    if (args.triggerFlows !== undefined) input.triggerFlows = args.triggerFlows;
    if (args.idempotencyKey !== undefined) input.idempotencyKey = args.idempotencyKey;

    const data = await this.#request<{ writeDroplet: RainDBWriteResult }>(WRITE_DROPLET, {
      input,
    });
    return data.writeDroplet;
  }

  async listKeys(
    prefix: string,
    opts: { pageSize?: number; cursor?: string; after?: string } = {},
  ): Promise<RainDBKeyPage> {
    const input: Record<string, unknown> = { prefix };
    if (opts.pageSize !== undefined) input.pageSize = opts.pageSize;
    if (opts.cursor !== undefined) input.cursor = opts.cursor;
    if (opts.after !== undefined) input.after = opts.after;
    const data = await this.#request<{ listKeys: RainDBKeyPage }>(LIST_KEYS, { input });
    return data.listKeys;
  }

  async #request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#cfg.timeoutMs);

    let res: Response;
    try {
      res = await this.#cfg.fetch(this.#cfg.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#cfg.apiKey}`,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new RainDBError(`RainDB request timed out after ${this.#cfg.timeoutMs}ms`, {
          cause: err,
        });
      }
      const detail = extractCauseMessage(err);
      throw new RainDBError(`RainDB transport error: ${detail}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await safeText(res);
      throw new RainDBError(`RainDB HTTP ${res.status}: ${body}`, { status: res.status });
    }

    const json = (await res.json()) as GraphQLResponse<T>;
    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map((e) => e.message).join('; ');
      if (/not found|no such key/i.test(msg)) {
        throw new RainDBNotFoundError(msg);
      }
      const ext = json.errors[0]?.extensions;
      throw new RainDBError(
        `RainDB GraphQL error: ${msg}`,
        ext ? { extensions: ext } : {},
      );
    }
    if (!json.data) {
      throw new RainDBError('RainDB GraphQL response missing data');
    }
    return json.data;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<unreadable body>';
  }
}

/**
 * Pull a useful message out of a fetch failure, including the nested
 * AggregateError causes Node throws on connect failures (ETIMEDOUT etc.),
 * so the surfaced RainDBError is diagnosable instead of a bare
 * "fetch failed".
 */
function extractCauseMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      const code = (cause as { code?: string }).code;
      const msg = (cause as { message?: string }).message;
      if (code || msg) return [code, msg].filter(Boolean).join(' ');
    }
    return err.message || err.name;
  }
  return String(err);
}
