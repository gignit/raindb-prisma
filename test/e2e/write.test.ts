/**
 * Write-path end-to-end test against a live RainDB tenant's scratch
 * formation (`prisma-adapter-test`).
 *
 * Exercises create -> findUnique -> update -> findUnique -> delete, proving
 * the adapter's SQL-write translation (INSERT/UPDATE/DELETE -> droplet ops)
 * works through a real PrismaClient end to end.
 *
 * findUnique by id is strongly consistent (resolution plane / readLatest),
 * so the read-back after each write reflects it immediately -- no periscope
 * lag involved.
 *
 * Skipped unless RAINDB_ENDPOINT + RAINDB_API_KEY are set.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaRainDB } from '../../src/index.js';

const endpoint = process.env.RAINDB_ENDPOINT;
const apiKey = process.env.RAINDB_API_KEY;

const live = endpoint && apiKey ? describe : describe.skip;

live('e2e write-path: create / update / delete', () => {
  let prisma: any;

  async function getClient() {
    if (prisma) return prisma;
    const { PrismaClient } = (await import('./generated/client.js')) as {
      PrismaClient: new (args: { adapter: unknown }) => any;
    };
    const adapter = new PrismaRainDB({
      endpoint: endpoint!,
      apiKey: apiKey!,
      author: 'prisma-adapter-e2e',
      freshness: 'signal',
      models: {
        formations: ['prisma-adapter-test'],
        scopeKeys: { 'prisma-adapter-test': 'id' },
      },
    });
    prisma = new PrismaClient({ adapter });
    return prisma;
  }

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('create then findUnique round-trips', async () => {
    const client = await getClient();
    const id = randomUUID();

    await client.prismaTest.create({
      data: { id, name: 'hello', count: 1, active: true },
    });

    const found = await client.prismaTest.findUnique({ where: { id } });
    expect(found).not.toBeNull();
    expect(found.id).toBe(id);
    expect(found.name).toBe('hello');
    expect(found.count).toBe(1);
  }, 30000);

  it('update writes a new version (read-modify-write)', async () => {
    const client = await getClient();
    const id = randomUUID();

    await client.prismaTest.create({ data: { id, name: 'before', count: 1 } });
    await client.prismaTest.update({
      where: { id },
      data: { name: 'after', count: 2 },
    });

    const found = await client.prismaTest.findUnique({ where: { id } });
    expect(found.name).toBe('after');
    expect(found.count).toBe(2);
  }, 30000);

  it('create with auto-generated id returns the server-assigned id', async () => {
    const client = await getClient();
    // Omit the id -> RainDB auto-generates the scopeValue (UUIDv7) and
    // returns it via writeDroplet.scopeValue. The adapter must surface that
    // through RETURNING so Prisma hands back the generated primary key.
    const created = await client.prismaTest.create({ data: { name: 'autogen' } });
    expect(created.id).toBeTruthy();
    expect(typeof created.id).toBe('string');

    // And it must be findable by that id.
    const found = await client.prismaTest.findUnique({ where: { id: created.id } });
    expect(found).not.toBeNull();
    expect(found.name).toBe('autogen');
  }, 30000);

  it('delete soft-deletes (findUnique still resolves the marked record)', async () => {
    const client = await getClient();
    const id = randomUUID();

    await client.prismaTest.create({ data: { id, name: 'doomed' } });
    await client.prismaTest.delete({ where: { id } });

    // Soft delete writes a new version with deleted=true; the record still
    // exists in RainDB (immutable), now flagged. The adapter models DELETE as
    // a soft delete, so the latest version carries the marker.
    const found = await client.prismaTest.findUnique({ where: { id } });
    expect(found).not.toBeNull();
    expect(found.deleted).toBe(true);
  }, 30000);
});
