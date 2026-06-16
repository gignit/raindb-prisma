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
   */
  apiKey: string;

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
  apiKey: string;
  freshness: 'merge' | 'signal' | 'off';
  timeoutMs: number;
  fetch: typeof fetch;
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
  if (!config.apiKey) {
    throw new Error('RainDBAdapterConfig.apiKey is required');
  }

  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'No fetch implementation available. Provide RainDBAdapterConfig.fetch or run on a runtime with global fetch (Node >=18).',
    );
  }

  return {
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    freshness: config.freshness ?? 'merge',
    timeoutMs: config.timeoutMs ?? 30000,
    fetch: fetchImpl,
    logger: config.logger ?? noopLogger,
    maxDriftMerge: config.maxDriftMerge ?? 500,
    driftMergeBudgetMs: config.driftMergeBudgetMs ?? 2000,
    driftMergeMaxPages: config.driftMergeMaxPages ?? 5,
  };
}
