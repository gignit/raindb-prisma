/**
 * Live integration smoke test against a real RainDB tenant.
 *
 * Skipped unless RAINDB_ENDPOINT and RAINDB_API_KEY are set, so it never
 * runs in CI without credentials. Run locally with:
 *
 *   RAINDB_ENDPOINT=https://api.raindb.io/graphql \
 *   RAINDB_API_KEY=rgr1.... \
 *   RAINDB_TEST_FORMATION=vizzda-events \
 *   npx vitest run test/integration/live.test.ts
 *
 * It exercises the read path through the real transport: executeSQL against
 * the Periscope plane, column-type inference, and the freshness bookmark.
 */
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.js';
import { RainDBClient } from '../../src/raindb/client.js';
import { formationToPeriscopeTable } from '../../src/sql/identifiers.js';

const endpoint = process.env.RAINDB_ENDPOINT;
const apiKey = process.env.RAINDB_API_KEY;
const formation = process.env.RAINDB_TEST_FORMATION ?? 'vizzda-events';

const live = endpoint && apiKey ? describe : describe.skip;

live('live: RainDB transport', () => {
  const client = new RainDBClient(
    resolveConfig({ endpoint: endpoint!, apiKey: apiKey! }),
  );

  it('executeSQL returns columns + rows from the Periscope plane', async () => {
    const table = formationToPeriscopeTable(formation);
    const result = await client.executeSQL(
      `SELECT * FROM entity."${table}" LIMIT 2`,
      { formationId: formation },
    );
    expect(Array.isArray(result.columns)).toBe(true);
    expect(result.columns.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeGreaterThanOrEqual(0);
  });

  it('executeSQL returns a freshness bookmark for the formation', async () => {
    const table = formationToPeriscopeTable(formation);
    const result = await client.executeSQL(
      `SELECT * FROM entity."${table}" LIMIT 1`,
      { formationId: formation },
    );
    expect(result.latest).toBeDefined();
    const bookmark = result.latest?.find((b) => b.formationId === formation);
    expect(bookmark).toBeDefined();
    // snapshot and current are both strings (may be equal when fully fresh).
    expect(typeof bookmark!.snapshotDropletId).toBe('string');
    expect(typeof bookmark!.currentDropletId).toBe('string');
  });
});
