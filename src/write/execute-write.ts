/**
 * Write path: executeRaw -> droplet operations.
 *
 * RainDB's SQL plane is read-only, so Prisma's
 * compiled INSERT/UPDATE/DELETE never reach Periscope. The adapter parses
 * them (src/sql/parse-write.ts) and re-expresses them as droplet writes:
 *
 *   INSERT -> writeDroplet(payload from columns/values)
 *   UPDATE -> read-current droplet by id, spread payload, apply SET, write a
 *             new droplet (immutable, append-only "update")
 *   DELETE -> read-current, write a soft-delete droplet (deleted=true), per
 *             the RainDB soft-delete convention. (Hard delete is a separate
 *             lifecycle concern -- expireDroplet -- not the SQL DELETE path.)
 *
 * Returns the number of affected rows (Prisma's executeRaw contract).
 *
 * Determinism: anything the parser flagged unsupported (non-equality WHERE,
 * value expressions, multi-formation writes) throws UnsupportedOperationError
 * -- explicit failure, never a silent wrong result.
 */
import type { SqlQuery } from '@prisma/driver-adapter-utils';
import type { ResolvedConfig } from '../config.js';
import { UnsupportedOperationError } from '../errors.js';
import type { RainDBClient } from '../raindb/client.js';
import type { FormationNameMap } from '../sql/identifiers.js';
import { resolveFormation } from '../sql/identifiers.js';
import {
  parseWrite,
  resolveSlot,
  type DeleteIntent,
  type InsertIntent,
  type UpdateIntent,
  type WhereClause,
} from '../sql/parse-write.js';

/** Field name used for the RainDB soft-delete convention. */
const SOFT_DELETE_FIELD = 'deleted';
const SOFT_DELETE_AT_FIELD = 'deletedAt';

export interface WriteContext {
  client: RainDBClient;
  cfg: ResolvedConfig;
  nameMap: FormationNameMap;
  /**
   * Per-formation scopeKey lookup (the payload field that is the entity id).
   * Supplied by the generator-emitted model map; falls back to 'id'.
   */
  scopeKeyOf: (formationId: string) => string;
  /** Author to stamp on writes (writes require an author). */
  author: string;
}

/**
 * Result of a write. `affected` is the executeRaw contract; `rows` +
 * `returning` carry the written record(s) so a RETURNING write (which arrives
 * via queryRaw) can hand Prisma the row it expects -- without this, Prisma
 * sees 0 returned rows and reports "no record was found".
 */
export interface WriteOutcome {
  affected: number;
  /** The written payloads (full droplet payload per affected record). */
  rows: Array<Record<string, unknown>>;
  /** RETURNING column names, if the statement had a RETURNING clause. */
  returning: string[];
}

export async function executeWrite(ctx: WriteContext, query: SqlQuery): Promise<WriteOutcome> {
  const intent = parseWrite(query.sql);
  switch (intent.kind) {
    case 'insert':
      return executeInsert(ctx, intent, query.args);
    case 'update':
      return executeUpdate(ctx, intent, query.args);
    case 'delete':
      return executeDelete(ctx, intent, query.args);
  }
}

async function executeInsert(
  ctx: WriteContext,
  intent: InsertIntent,
  args: unknown[],
): Promise<WriteOutcome> {
  const formationId = resolveFormation(intent.table, ctx.nameMap);
  const scopeKey = ctx.scopeKeyOf(formationId);

  if (intent.hasOnConflict) {
    // ON CONFLICT (upsert) needs read-modify-write semantics we cannot infer
    // safely from the compiled INSERT alone. Prisma's upsert typically issues
    // a SELECT-then-INSERT/UPDATE via the engine, so a bare ON CONFLICT here
    // is rare; reject loudly rather than half-apply.
    throw new UnsupportedOperationError(
      'write.on-conflict',
      'INSERT ... ON CONFLICT is not supported directly; model upserts as ' +
        'read-then-write at the application layer or via the engine upsert flow.',
    );
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const row of intent.rows) {
    const payload: Record<string, unknown> = {};
    intent.columns.forEach((col, i) => {
      const slot = row[i];
      if (!slot) return;
      const value = resolveSlot(slot, args);
      if (value !== undefined) payload[col] = value;
    });
    const result = await ctx.client.writeDroplet({
      formationId,
      payload,
      author: ctx.author,
    });
    // The server returns the canonical primary key in scopeValue (the id it
    // actually persisted). Trust it as authoritative -- this is essential for
    // auto-generated ids (the caller omitted the key and Prisma needs the
    // generated value back via RETURNING), and harmless when the caller
    // supplied it (the values match).
    if (result.scopeValue) {
      payload[scopeKey] = result.scopeValue;
    }
    rows.push(payload);
  }
  return { affected: rows.length, rows, returning: intent.returning };
}

async function executeUpdate(
  ctx: WriteContext,
  intent: UpdateIntent,
  args: unknown[],
): Promise<WriteOutcome> {
  const formationId = resolveFormation(intent.table, ctx.nameMap);
  const scopeKey = ctx.scopeKeyOf(formationId);
  const scopeValue = requireScopeValue(intent.where, scopeKey, args, 'UPDATE');

  const current = await ctx.client.readLatest(formationId, 'by-id-latest', scopeValue);
  if (!current || !current.payload) {
    // Nothing to update -> 0 rows affected (matches SQL semantics).
    return { affected: 0, rows: [], returning: intent.returning };
  }

  const next: Record<string, unknown> = { ...(current.payload as Record<string, unknown>) };
  for (const assignment of intent.set) {
    const value = resolveSlot(assignment.value, args);
    next[assignment.column] = value === undefined ? null : value;
  }
  // Never let SET rewrite the scope key.
  next[scopeKey] = scopeValue;

  await ctx.client.writeDroplet({
    formationId,
    payload: next,
    author: ctx.author,
  });
  return { affected: 1, rows: [next], returning: intent.returning };
}

async function executeDelete(
  ctx: WriteContext,
  intent: DeleteIntent,
  args: unknown[],
): Promise<WriteOutcome> {
  const formationId = resolveFormation(intent.table, ctx.nameMap);
  const scopeKey = ctx.scopeKeyOf(formationId);
  const scopeValue = requireScopeValue(intent.where, scopeKey, args, 'DELETE');

  const current = await ctx.client.readLatest(formationId, 'by-id-latest', scopeValue);
  if (!current || !current.payload) {
    return { affected: 0, rows: [], returning: intent.returning };
  }

  const next: Record<string, unknown> = {
    ...(current.payload as Record<string, unknown>),
    [SOFT_DELETE_FIELD]: true,
    [SOFT_DELETE_AT_FIELD]: new Date().toISOString(),
  };
  next[scopeKey] = scopeValue;

  await ctx.client.writeDroplet({
    formationId,
    payload: next,
    author: ctx.author,
  });
  return { affected: 1, rows: [next], returning: intent.returning };
}

/**
 * Extract the single scope-key equality from a WHERE clause. Single-record
 * update/delete (Prisma's by-id / by-unique path) carries exactly this.
 * Anything else (no WHERE, non-equality, multi-key not including scopeKey)
 * is rejected -- we will not guess which droplets a broad predicate touches.
 */
function requireScopeValue(
  where: WhereClause | null,
  scopeKey: string,
  args: unknown[],
  op: string,
): string {
  if (!where) {
    throw new UnsupportedOperationError(
      'write.unbounded',
      `${op} without a WHERE clause is not supported (would touch all droplets). ` +
        `Scope ${op} to a single entity by its id.`,
    );
  }
  if (where.unsupported) {
    throw new UnsupportedOperationError(
      'write.where',
      `${op} WHERE is not reducible to a single-entity match: ${where.unsupported}. ` +
        `Filtered bulk ${op} should be resolved to ids via a read, then applied per-id.`,
    );
  }
  // Prefer an equality on the scope key; else accept a sole equality.
  const onScope = where.equalities.find((e) => e.column === scopeKey);
  const chosen = onScope ?? (where.equalities.length === 1 ? where.equalities[0] : undefined);
  if (!chosen) {
    throw new UnsupportedOperationError(
      'write.multi-key',
      `${op} WHERE does not target the scope key '${scopeKey}'. ` +
        `Single-entity ${op} by id/unique key is required.`,
    );
  }
  const value = resolveSlot(chosen.value, args);
  if (value === undefined || value === null) {
    throw new UnsupportedOperationError(
      'write.null-key',
      `${op} scope value resolved to null.`,
    );
  }
  return String(value);
}
