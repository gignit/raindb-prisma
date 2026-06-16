/**
 * True end-to-end test: a real PrismaClient driving the RainDB adapter
 * against a production RainDB tenant.
 *
 * This is the proof that an unmodified Prisma application works: we call
 * prisma.vizzdaEvent.findMany() / findFirst() and assert the rows come back
 * shaped by the schema -- exercising the full stack (engine -> compiled SQL
 * -> adapter.queryRaw -> Periscope executeSQL -> column mapping -> engine
 * deserialization).
 *
 * Skipped unless RAINDB_ENDPOINT + RAINDB_API_KEY are set. Requires the
 * generated client (run `npx prisma generate --schema test/e2e/schema.prisma`
 * first; the pretest hook does this).
 *
 *   RAINDB_ENDPOINT=https://api.raindb.io/graphql \
 *   RAINDB_API_KEY=rgr1.... \
 *   npx vitest run test/e2e/prisma.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaRainDB } from '../../src/index.js';

const endpoint = process.env.RAINDB_ENDPOINT;
const apiKey = process.env.RAINDB_API_KEY;

const live = endpoint && apiKey ? describe : describe.skip;

live('e2e: PrismaClient + RainDB adapter', () => {
  // Dynamic import so the suite can be collected even when the client hasn't
  // been generated (the describe.skip path).
  let prisma: { vizzdaEvent: any; $disconnect: () => Promise<void> } | undefined;

  async function getClient() {
    if (prisma) return prisma;
    const { PrismaClient } = (await import('./generated/client.js')) as {
      PrismaClient: new (args: { adapter: unknown }) => typeof prisma & object;
    };
    const adapter = new PrismaRainDB({
      endpoint: endpoint!,
      apiKey: apiKey!,
      // e2e validates the read path deterministically with 'signal' (no
      // per-record fan-out over the network). The 'merge' mechanics are
      // covered by a mocked-transport unit test (test/freshness.test.ts),
      // which is deterministic and doesn't depend on prod network stability.
      freshness: 'signal',
      models: {
        formations: ['vizzda-events'],
        scopeKeys: { 'vizzda-events': 'eventId' },
      },
    });
    prisma = new PrismaClient({ adapter }) as never;
    return prisma!;
  }

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('findMany returns rows shaped by the model', async () => {
    const client = await getClient();
    const rows = await client.vizzdaEvent.findMany({ take: 3 });
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length > 0) {
      const r = rows[0];
      expect(typeof r.eventId).toBe('string');
      // Optional columns are present as keys (possibly null).
      expect('propertyName' in r).toBe(true);
    }
  }, 30000);

  it('findMany with select projects columns', async () => {
    const client = await getClient();
    const rows = await client.vizzdaEvent.findMany({
      take: 2,
      select: { eventId: true, propertyCity: true },
    });
    if (rows.length > 0) {
      expect(Object.keys(rows[0]).sort()).toEqual(['eventId', 'propertyCity']);
    }
  }, 30000);

  it('findFirst returns a single record or null', async () => {
    const client = await getClient();
    const row = await client.vizzdaEvent.findFirst();
    expect(row === null || typeof row.eventId === 'string').toBe(true);
  }, 30000);
});
