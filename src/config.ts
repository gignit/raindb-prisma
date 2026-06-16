/**
 * Public configuration for the RainDB Prisma adapter.
 *
 * This is the object an application passes to
 * `new PrismaRainDB({ ... })`. It is the ONLY RainDB-specific surface a
 * Prisma user touches -- everything else is standard PrismaClient.
 */
export interface RainDBAdapterConfig {
  /**
   * RainDB GraphQL endpoint, e.g. `https://api.<env>.raindb.gignit.com/graphql`
   * or `http://localhost:8080/graphql` for local dev.
   */
  endpoint: string;

  /**
   * RainDB API key (the `rdb_...` token). Sent as
   * `Authorization: Bearer rdb_...` (the canonical OpenAI-spec shape that
   * also routes to RainDB's API-key validator).
   *
   * Optional for the GATEWAY pattern: when `endpoint` points at a trusted
   * proxy (e.g. a Lightning Bolt that injects the real key server-side), omit
   * the key here so it never reaches the browser. When omitted, the adapter
   * sends no Authorization header and the gateway is responsible for auth.
   */
  apiKey?: string;

  /**
   * Freshness policy for list/analytical reads (findMany/aggregate/joins).
   *
   * RainDB's periscope SQL plane is eventually consistent; the adapter can
   * close the read-your-writes gap using the freshness-bookmark drift merge
   * (see README "Consistency"). Choose how aggressively to do that:
   *
   *  - 'merge'  (default): request the freshness bookmark on every SQL read;
   *             when the columnar snapshot is behind live writes, list the
   *             missing droplets and merge them into the result. Gives
   *             read-your-writes on lists without waiting for a pool.
   *  - 'signal': request the bookmark but do NOT merge; surface drift via
   *             logging only. Cheapest; accept eventual consistency.
   *  - 'off':    do not request the bookmark at all. Pure analytics posture.
   */
  freshness?: 'merge' | 'signal' | 'off';

  /**
   * Per-request timeout in milliseconds for GraphQL calls. Default 30000.
   */
  timeoutMs?: number;

  /**
   * Optional custom fetch implementation (for non-standard runtimes,
   * proxies, or test injection). Defaults to the global `fetch`.
   */
  fetch?: typeof fetch;

  /**
   * Extra headers to send on every request, as a value or a function called
   * per request (so a session token can be read fresh). This is how the
   * GATEWAY pattern carries the caller's identity: after the app authenticates
   * (e.g. password -> the bolt mints a session token / scoped IAM grant), the
   * browser-side adapter sends that token here and the gateway validates it
   * before injecting the real tenant key. The tenant key NEVER lives in the
   * browser.
   *
   * Example (browser, cookie-less bearer session):
   *   headers: () => ({ authorization: `Bearer ${sessionToken}` })
   */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

  /**
   * Fetch credentials mode (e.g. 'include') so cookie-based sessions issued
   * by the gateway are sent with each request. Default 'same-origin'.
   */
  credentials?: RequestCredentials;

  /**
   * Optional structured logger. When omitted, the adapter is silent except
   * for thrown errors.
   */
  logger?: AdapterLogger;

  /**
   * Maximum number of newer droplets the drift-merge will fetch+inject per
   * query before giving up and returning the (slightly stale) SQL result.
   * Protects against an unbounded merge on a hot formation. Default 500.
   */
  maxDriftMerge?: number;

  /**
   * Wall-clock budget (ms) for the drift-merge index walk. If exceeded, the
   * read degrades to 'signal' (returns the snapshot rows + logs) rather than
   * walking a far-behind index forever. Default 2000.
   */
  driftMergeBudgetMs?: number;

  /**
   * Max index pages the drift-merge walk will request before degrading to
   * 'signal'. Bounds the work on a large formation. Default 5.
   */
  driftMergeMaxPages?: number;
}

export interface AdapterLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Internal resolved config with defaults applied. */
export interface ResolvedConfig {
  endpoint: string;
  /** Empty string when using the gateway pattern (proxy injects the key). */
  apiKey: string;
  freshness: 'merge' | 'signal' | 'off';
  timeoutMs: number;
  fetch: typeof fetch;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  credentials: RequestCredentials;
  logger: AdapterLogger;
  maxDriftMerge: number;
  driftMergeBudgetMs: number;
  driftMergeMaxPages: number;
}

const noopLogger: AdapterLogger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

export function resolveConfig(config: RainDBAdapterConfig): ResolvedConfig {
  if (!config.endpoint) {
    throw new Error('RainDBAdapterConfig.endpoint is required');
  }
  // apiKey is optional: omit it for the gateway pattern (a trusted proxy such
  // as a Lightning Bolt injects the real key). When present it is sent as a
  // Bearer header; when absent the adapter sends no Authorization header.

  const rawFetch = config.fetch ?? globalThis.fetch;
  if (typeof rawFetch !== 'function') {
    throw new Error(
      'No fetch implementation available. Provide RainDBAdapterConfig.fetch or run on a runtime with global fetch (Node >=18).',
    );
  }
  // Bind to globalThis so calling it as a stored property doesn't trigger
  // "Illegal invocation" in browsers (window.fetch must keep its receiver).
  const fetchImpl = config.fetch ? rawFetch : rawFetch.bind(globalThis);

  return {
    endpoint: config.endpoint,
    apiKey: config.apiKey ?? '',
    freshness: config.freshness ?? 'merge',
    timeoutMs: config.timeoutMs ?? 30000,
    fetch: fetchImpl,
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    credentials: config.credentials ?? 'same-origin',
    logger: config.logger ?? noopLogger,
    maxDriftMerge: config.maxDriftMerge ?? 500,
    driftMergeBudgetMs: config.driftMergeBudgetMs ?? 2000,
    driftMergeMaxPages: config.driftMergeMaxPages ?? 5,
  };
}
