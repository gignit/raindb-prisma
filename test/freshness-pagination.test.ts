import { describe, expect, it, vi } from 'vitest';
import { RainDBClient } from '../src/raindb/client.js';
import { resolveConfig } from '../src/config.js';
import { driftMerge } from '../src/read/freshness.js';

const prefix = 'indexes/f/by-update/';
const input = {
  columns: ['id'],
  rows: [{ id: 'snapshot' }],
  latest: [{
    formationId: 'f', snapshotDropletId: 'snapshot', currentDropletId: 'current',
    snapshotKey: `${prefix}snapshot/latest.json`, currentKey: `${prefix}current/latest.json`,
    indexPrefix: prefix, freshnessStatus: 'BEHIND' as const,
  }],
};

// Model the wire contract, including after taking precedence over cursor.
function fixture(total: number, options: Parameters<typeof resolveConfig>[0] = { endpoint: 'http://x' }) {
  const requests: Array<Record<string, unknown>> = [];
  const fetch = vi.fn(async (_url, init) => {
    const { query, variables: { input: args } } = JSON.parse(String(init?.body));
    if (query.includes('AdapterListKeys')) {
      requests.push(args);
      const start = args.after ? 0 : Number(args.cursor ?? 0);
      const count = Math.min(args.maxKeys ?? args.pageSize ?? 100, total - start);
      const end = start + count;
      return Response.json({ data: { listKeys: {
        keys: Array.from({ length: count }, (_, i) => ({ key: `${prefix}${start + i}/latest.json` })),
        hasMore: end < total,
        nextCursor: end < total ? String(end) : null,
      } } });
    }
    return Response.json({ data: { readLatest: { dropletId: args.scopeValue, payload: { id: args.scopeValue } } } });
  }) as unknown as typeof globalThis.fetch;
  const cfg = resolveConfig({ ...options, fetch });
  return { client: new RainDBClient(cfg), cfg, requests };
}

describe('freshness accumulation over GraphQL', () => {
  it('harvests more than an S3 page in one round trip, bounded by maxDriftMerge', async () => {
    const { client, cfg, requests } = fixture(3000, { endpoint: 'http://x', maxDriftMerge: 2500 });
    const result = await driftMerge(client, cfg, input);
    expect(requests).toEqual([{
      prefix, pageSize: 1000, maxKeys: 2500, after: input.latest[0]!.snapshotKey,
    }]);
    expect(result.rows).toHaveLength(2501);
    expect(result.rows.at(-1)).toEqual({ id: '2499' });
  });

  it('continues from the returned cursor with the remaining allowance', async () => {
    const { client, cfg, requests } = fixture(12000, { endpoint: 'http://x', maxDriftMerge: 10002, driftMergeBudgetMs: 60000 });
    const result = await driftMerge(client, cfg, input);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.maxKeys).toBe(10000);
    expect(requests[1]).toEqual({ prefix, pageSize: 2, maxKeys: 2, cursor: '10000' });
    expect(result.rows).toHaveLength(10003);
    expect(result.rows.at(-1)).toEqual({ id: '10001' });
  });

  it.each([
    { maxDriftMerge: 0 },
    { driftMergeMaxPages: 0 },
    { driftMergeBudgetMs: -1 },
  ])('does not fetch when a guard is exhausted: %j', async (limits) => {
    const { client, cfg, requests } = fixture(10, { endpoint: 'http://x', ...limits });
    expect((await driftMerge(client, cfg, input)).rows).toEqual(input.rows);
    expect(requests).toHaveLength(0);
  });

  it('discards collected IDs when the continuation exceeds the page budget', async () => {
    const { client, cfg, requests } = fixture(12000, {
      endpoint: 'http://x', maxDriftMerge: 12000, driftMergeMaxPages: 1,
    });
    expect((await driftMerge(client, cfg, input)).rows).toEqual(input.rows);
    expect(requests).toHaveLength(1);
  });

  it('propagates an accumulation error instead of merging partial data', async () => {
    const { client, cfg } = fixture(10);
    vi.spyOn(client, 'listKeys').mockRejectedValue(new Error('list accumulation failed'));
    await expect(driftMerge(client, cfg, input)).rejects.toThrow('list accumulation failed');
  });
});
