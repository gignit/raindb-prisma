import { describe, expect, it } from 'vitest';
import { driftMerge } from '../src/read/freshness.js';
import { resolveConfig } from '../src/config.js';
import type { RainDBClient } from '../src/raindb/client.js';
import type { RainDBDroplet, RainDBKeyPage } from '../src/raindb/types.js';

/**
 * A fake RainDBClient that serves listKeys + readLatest from in-memory
 * fixtures, so the merge logic is tested deterministically with no network.
 */
function fakeClient(opts: {
  keys: string[];
  droplets: Record<string, Record<string, unknown>>;
}): RainDBClient {
  return {
    async listKeys(): Promise<RainDBKeyPage> {
      return {
        keys: opts.keys.map((key) => ({ key })),
        hasMore: false,
        nextCursor: null,
      };
    },
    async readLatest(
      _formationId: string,
      _indexId: string,
      scopeValue: string,
    ): Promise<RainDBDroplet | null> {
      const payload = opts.droplets[scopeValue];
      return payload ? { dropletId: scopeValue, payload } : null;
    },
  } as unknown as RainDBClient;
}

const cfg = resolveConfig({ endpoint: 'http://x', apiKey: 'k' });

describe('driftMerge', () => {
  it('returns snapshot rows unchanged when there is no drift', async () => {
    const client = fakeClient({ keys: [], droplets: {} });
    const out = await driftMerge(client, cfg, {
      columns: ['id', 'name'],
      rows: [{ id: 'a', name: 'A' }],
      latest: [
        {
          formationId: 'f',
          snapshotDropletId: 'x',
          currentDropletId: 'x', // equal -> no drift
          snapshotKey: 'k1',
          currentKey: 'k1',
          indexPrefix: 'indexes/f/by-update/',
        },
      ],
    });
    expect(out.rows).toEqual([{ id: 'a', name: 'A' }]);
  });

  it('merges newer droplets into the result on drift (newest wins)', async () => {
    const client = fakeClient({
      keys: [
        'indexes/f/by-update/b/latest.json',
        'indexes/f/by-update/c/latest.json',
      ],
      droplets: {
        b: { id: 'b', name: 'B-updated' }, // already in snapshot, updated
        c: { id: 'c', name: 'C-new' }, // brand new
      },
    });

    const out = await driftMerge(client, cfg, {
      columns: ['id', 'name'],
      rows: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B-stale' },
      ],
      latest: [
        {
          formationId: 'f',
          snapshotDropletId: 'snap',
          currentDropletId: 'curr', // != -> drift
          snapshotKey: 'indexes/f/by-update/a/latest.json',
          currentKey: 'indexes/f/by-update/c/latest.json',
          indexPrefix: 'indexes/f/by-update/',
        },
      ],
    });

    const byId = Object.fromEntries(out.rows.map((r) => [r.id, r.name]));
    expect(byId).toEqual({
      a: 'A', // untouched
      b: 'B-updated', // newer droplet wins over stale snapshot row
      c: 'C-new', // injected
    });
  });

  it('does not merge multi-formation drift (joins), returns snapshot', async () => {
    const client = fakeClient({ keys: ['indexes/f/by-update/z/latest.json'], droplets: {} });
    const out = await driftMerge(client, cfg, {
      columns: ['id'],
      rows: [{ id: 'a' }],
      latest: [
        {
          formationId: 'f1',
          snapshotDropletId: 's',
          currentDropletId: 'c',
          snapshotKey: 'k',
          currentKey: 'k2',
          indexPrefix: 'indexes/f1/by-update/',
        },
        {
          formationId: 'f2',
          snapshotDropletId: 's',
          currentDropletId: 'c',
          snapshotKey: 'k',
          currentKey: 'k2',
          indexPrefix: 'indexes/f2/by-update/',
        },
      ],
    });
    expect(out.rows).toEqual([{ id: 'a' }]);
  });

  it('degrades to signal when the page budget is exceeded', async () => {
    // maxPages = 0 forces immediate budget exhaustion -> no merge.
    const tightCfg = resolveConfig({
      endpoint: 'http://x',
      apiKey: 'k',
      driftMergeMaxPages: 0,
    });
    const client = fakeClient({
      keys: ['indexes/f/by-update/c/latest.json'],
      droplets: { c: { id: 'c', name: 'C-new' } },
    });
    const out = await driftMerge(client, tightCfg, {
      columns: ['id', 'name'],
      rows: [{ id: 'a', name: 'A' }],
      latest: [
        {
          formationId: 'f',
          snapshotDropletId: 's',
          currentDropletId: 'c',
          snapshotKey: 'k',
          currentKey: 'k2',
          indexPrefix: 'indexes/f/by-update/',
        },
      ],
    });
    // budget exceeded -> snapshot rows unchanged
    expect(out.rows).toEqual([{ id: 'a', name: 'A' }]);
  });
});
