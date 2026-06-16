# @raindb/prisma-adapter

Run the **Prisma ORM** against **RainDB**.

You keep writing standard Prisma -- `findMany`, `findUnique`, `create`,
`update`, `count`, `aggregate`, relations -- and the adapter routes each
call to the right RainDB access plane. The only change to your application
is the adapter you pass to `PrismaClient`.

```ts
import { PrismaClient } from '@prisma/client';
import { PrismaRainDB } from '@raindb/prisma-adapter';

const adapter = new PrismaRainDB({
  endpoint: process.env.RAINDB_ENDPOINT!, // https://api.raindb.io/graphql
  apiKey:   process.env.RAINDB_API_KEY!,  // rdb_... or rgr1.... grant token
});

const prisma = new PrismaClient({ adapter });

// ...everything below is unchanged, standard Prisma:
const users  = await prisma.user.findMany({ where: { active: true }, orderBy: { createdAt: 'desc' } });
const one    = await prisma.user.findUnique({ where: { id } });
const made   = await prisma.user.create({ data: { email, name } });
```

That is the whole integration. Swap the adapter line; the rest of your
Prisma code is untouched.

---

## Why this exists (for SQL people)

You already know SQL. Here is the one idea that makes RainDB worth the
switch, stated in SQL terms:

RainDB gives you **one schema** that is, at the same time:

- a **transactional row store** (every write is an immutable, append-only
  record),
- a **columnar analytical engine** -- **RainDB Periscope** -- that runs your
  `findMany` / joins / aggregates with **no ETL and no second copy of the
  data** (the analytical view is the same data, materialized in place), and
- (optionally, via schema directives) a **cache tier**, a **stream/event
  log**, and **object/file + document pipelines** -- all on the same data.

A normal stack needs Postgres + a warehouse + an ETL pipeline + Redis +
Kafka to cover that surface. RainDB collapses it into one dataplane. This
adapter is how your existing Prisma codebase reaches it.

You do **not** need to learn any of RainDB's internals to use this adapter.
The sections below are here when you want to understand *why* a query is
fast or *what* a particular Prisma feature maps to -- not because you have
to configure any of it.

---

## How it works (two access planes)

Prisma 7 compiles each query to SQL in the client and hands it to the
adapter. The adapter looks at the statement and routes it:

| Your Prisma call | RainDB plane | What happens |
|---|---|---|
| `findMany`, `count`, `aggregate`, `groupBy`, filtered lists, relations | **Periscope** (columnar SQL) | The compiled `SELECT` runs against RainDB's analytical plane. Fast over very large datasets; no per-row fetches. |
| `findUnique` / `findFirst` by id or unique key | **Resolution plane** | A direct key lookup -- single-digit-ms, strongly consistent, served from RainDB's cluster cache after first touch. |
| `create` | append a record | Translated to an immutable write. |
| `update` | read-current + write-new | RainDB records are immutable; an "update" writes a new version (the latest version wins on read). |
| `delete` | soft delete | Marks the record deleted (the RainDB convention); hard expiry is a separate lifecycle concern. |

This split is deliberate and it is the RainDB design: **find a set with SQL,
then resolve individual records by id.** It is why "N+1" -- the thing a
traditional ORM fights -- is actually the *fast path* here: a known-id read
is a direct, parallelizable lookup, not a query against a contended planner.
Prisma's own runtime already resolves relations as separate queries stitched
in memory, which fits this model exactly.

---

## Consistency (read-your-writes)

This is the one place RainDB differs from a single-node SQL database, and
the adapter handles it for you.

- **Reads by id / unique key are strongly consistent.** A `findUnique` after
  a `create`/`update` always sees the latest data.
- **List/analytical reads (`findMany`, aggregates) are eventually
  consistent** against the columnar plane -- it can lag live writes by a
  short window.

The adapter closes that gap automatically with a **freshness merge**
(default `freshness: 'merge'`). On every list read, RainDB returns a
freshness bookmark telling the adapter whether the columnar view is behind
live writes; if it is, the adapter fetches the missing newest records
directly and merges them into the result -- so your `findMany` reflects your
own just-written data without you doing anything.

Tune it via the adapter config:

| `freshness` | Behavior |
|---|---|
| `'merge'` (default) | Detect drift and merge in the missing newest records. Read-your-writes on lists. |
| `'signal'` | Detect drift, log it, but don't merge. Lowest overhead; accept eventual consistency. |
| `'off'` | Don't request freshness at all. Pure analytics posture. |

---

## What works, and the honest edges

**Works transparently:**

- `findUnique`, `findFirst`, `findMany` with `where` / `orderBy` / `skip` /
  `take`
- `count`, `aggregate`, `groupBy`
- relations / `include` (resolved as separate queries + in-memory join --
  the RainDB-native pattern)
- `create`, `update`, `delete`, single-record `upsert`
- nested `create` of one aggregate (parent + children in one record)

**The edges to know about (and why):**

1. **Cross-model transactions.** RainDB has no multi-record ACID transaction
   across different models -- writes are immutable single-record appends. A
   `$transaction([...])` spanning unrelated models will apply each write as
   it arrives and cannot roll the group back. **Model a transaction as one
   aggregate** (one record with embedded children) and it is atomic. The
   adapter is honest about this rather than faking durability it cannot
   deliver.
2. **Bulk `updateMany` / `deleteMany` by a filter.** Supported only when the
   filter targets a single record by id/unique key. A broad predicate is
   rejected with a clear error rather than guessing which records it touches;
   resolve the ids with a read first, then update per id.
3. **Migrations.** RainDB has no destructive DDL. Schema changes are
   **formation publishes with a compatibility check** -- which is RainDB's
   "no traditional migrations" model. Use the companion generator (below)
   instead of `prisma migrate`.

When the adapter cannot faithfully execute something, it throws a clear
`UnsupportedOperationError` with a `feature` tag -- never a silent wrong
result.

---

## Configuration

```ts
new PrismaRainDB({
  endpoint: 'https://api.raindb.io/graphql', // required
  apiKey:   'rdb_...',                        // required (Bearer)
  freshness: 'merge',          // 'merge' | 'signal' | 'off'  (default 'merge')
  timeoutMs: 30000,            // per-request timeout
  maxDriftMerge: 500,          // cap on records merged per list read
  author: 'user-123',          // stamped on writes (writes require an author)
  models: {                    // recommended: emitted by @raindb/prisma generator
    formations: ['vizzda-events', 'vizzda-contact'],
    scopeKeys: { 'vizzda-events': 'eventId' },
  },
  logger,                      // optional structured logger
});
```

The `models` map lets the adapter translate hyphenated RainDB formation
names and per-model primary keys precisely. It is optional but recommended;
without it the adapter assumes the table name maps to the formation id and
the primary key is `id`.

---

## Errors

RainDB failures surface as standard Prisma errors:

| RainDB condition | Prisma error |
|---|---|
| CAS / create-only / idempotency conflict | unique constraint violation (`P2002`) |
| schema validation / required field | invalid input value |
| unknown formation | table does not exist |
| 401 | authentication failed |
| timeout | socket timeout |

Adapter-specific failures are thrown as `UnsupportedOperationError` (exported
from the package) with a stable `feature` tag.

---

## Companion: schema + "migrations"

`@raindb/prisma-adapter` is the runtime. Schema management uses the
companion generator (in this repo): it turns your `schema.prisma` into RainDB
formation definitions and publishes new compatible schema versions instead of
running destructive migrations. (See the generator package docs.)

---

## Status

Early release. The read path (Periscope SQL + freshness merge), the write
path (create/update/delete translation), error mapping, and the RainDB
transport are implemented and tested -- including live integration tests
against a production RainDB tenant. See `CHANGELOG.md`.

## License

Apache-2.0.
