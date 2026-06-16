import { describe, expect, it } from 'vitest';
import { tryResolveById } from '../src/read/by-id.js';
import { rewriteToEntitySchema } from '../src/read/rewrite-sql.js';
import { resolveConfig } from '../src/config.js';
import { nameMapFromFormations } from '../src/sql/identifiers.js';
import type { RainDBClient } from '../src/raindb/client.js';
import type { RainDBDroplet } from '../src/raindb/types.js';

function fakeClient(payload: Record<string, unknown> | null): {
  client: RainDBClient;
  calls: Array<{ formationId: string; indexId: string; scopeValue: string }>;
} {
  const calls: Array<{ formationId: string; indexId: string; scopeValue: string }> = [];
  const client = {
    async readLatest(
      formationId: string,
      indexId: string,
      scopeValue: string,
    ): Promise<RainDBDroplet | null> {
      calls.push({ formationId, indexId, scopeValue });
      return payload ? { dropletId: 'd', payload } : null;
    },
  } as unknown as RainDBClient;
  return { client, calls };
}

const cfg = resolveConfig({ endpoint: 'http://x', apiKey: 'k' });
const nameMap = nameMapFromFormations(['prisma-adapter-test']);
const scopeKeyOf = (f: string) => (f === 'prisma-adapter-test' ? 'id' : 'id');

// The exact Prisma 7 findUnique shape (params already inlined), post
// schema-rewrite to the entity schema.
const FIND_UNIQUE_SQL = rewriteToEntitySchema(
  `SELECT "public"."prisma__adapter__test"."id", "public"."prisma__adapter__test"."name" ` +
    `FROM "public"."prisma__adapter__test" ` +
    `WHERE ("public"."prisma__adapter__test"."id" = 'abc-123' AND 1=1) LIMIT 1 OFFSET 0`,
);

describe('tryResolveById', () => {
  it('routes a Prisma findUnique-by-id SELECT to readLatest', async () => {
    const { client, calls } = fakeClient({ id: 'abc-123', name: 'hello' });
    const res = await tryResolveById({ client, cfg, nameMap, scopeKeyOf }, FIND_UNIQUE_SQL, []);

    expect(res).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      formationId: 'prisma-adapter-test',
      indexId: 'by-id-latest',
      scopeValue: 'abc-123',
    });
    // result carries the projected columns
    expect(res!.columnNames).toEqual(['id', 'name']);
    expect(res!.rows).toHaveLength(1);
  });

  it('returns an empty result (not null) when the record is absent', async () => {
    const { client } = fakeClient(null);
    const res = await tryResolveById({ client, cfg, nameMap, scopeKeyOf }, FIND_UNIQUE_SQL, []);
    expect(res).not.toBeNull();
    expect(res!.rows).toHaveLength(0);
  });

  it('does NOT route a multi-row list (LIMIT > 1)', async () => {
    const sql = rewriteToEntitySchema(
      `SELECT "public"."prisma__adapter__test"."id" FROM "public"."prisma__adapter__test" ` +
        `WHERE ("public"."prisma__adapter__test"."active" = 'true') LIMIT 50 OFFSET 0`,
    );
    const { client } = fakeClient({ id: 'x' });
    const res = await tryResolveById({ client, cfg, nameMap, scopeKeyOf }, sql, []);
    expect(res).toBeNull();
  });

  it('does NOT route a join', async () => {
    const sql =
      'SELECT a."id" FROM entity."a" JOIN entity."b" ON a."id" = b."aid" WHERE a."id" = \'1\' LIMIT 1';
    const { client } = fakeClient({ id: '1' });
    const res = await tryResolveById({ client, cfg, nameMap, scopeKeyOf }, sql, []);
    expect(res).toBeNull();
  });

  it('routes when LIMIT/OFFSET are quoted numeric literals (live Prisma shape)', async () => {
    // Prisma types LIMIT/OFFSET params as strings; the adapter inlines them
    // as quoted literals ' 1' / '0'. The detector must still recognize it.
    const sql = rewriteToEntitySchema(
      `SELECT "public"."prisma__adapter__test"."id", "public"."prisma__adapter__test"."name" ` +
        `FROM "public"."prisma__adapter__test" ` +
        `WHERE ("public"."prisma__adapter__test"."id" = 'abc-123' AND 1=1) LIMIT '1' OFFSET '0'`,
    );
    const { client, calls } = fakeClient({ id: 'abc-123', name: 'hello' });
    const res = await tryResolveById({ client, cfg, nameMap, scopeKeyOf }, sql, []);
    expect(res).not.toBeNull();
    expect(calls[0]?.scopeValue).toBe('abc-123');
  });

  it('does NOT route when the equality is not on the scope key', async () => {
    const sql = rewriteToEntitySchema(
      `SELECT "public"."prisma__adapter__test"."id" FROM "public"."prisma__adapter__test" ` +
        `WHERE ("public"."prisma__adapter__test"."name" = 'bob' AND 1=1) LIMIT 1 OFFSET 0`,
    );
    const { client } = fakeClient({ id: 'x' });
    const res = await tryResolveById({ client, cfg, nameMap, scopeKeyOf }, sql, []);
    expect(res).toBeNull();
  });
});
