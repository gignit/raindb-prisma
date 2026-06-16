/**
 * Rewrite Prisma-compiled SQL to target the RainDB Periscope schema.
 *
 * Prisma (postgres provider) compiles table references schema-qualified
 * against the datasource's default schema, e.g. `"public"."vizzda__events"`.
 * RainDB exposes formation views under the `entity` schema:
 * `entity."vizzda__events"`. So the adapter rewrites the qualifying schema
 * of every table reference to `entity`.
 *
 * We only rewrite the SCHEMA segment of a `"<schema>"."<table>"` (or
 * `<schema>.<table>`) pair; the table identifier is left exactly as Prisma
 * emitted it (already the Periscope `__` name via the model's @@map). Column
 * references like `"t"."col"` are not affected because we only rewrite a
 * schema segment that is immediately followed by a quoted table in a table
 * position -- in practice Prisma qualifies tables with the datasource schema
 * and aliases columns with table aliases, so a conservative schema-name
 * swap is safe.
 *
 * Strategy: replace occurrences of `"<schema>".` and `<schema>.` where the
 * schema equals the configured source schema (default 'public') with
 * `entity.`. This is the minimal, predictable transform.
 */

const DEFAULT_SOURCE_SCHEMA = 'public';
const TARGET_SCHEMA = 'entity';

export interface RewriteOptions {
  /** The schema Prisma qualifies tables with (datasource default). */
  sourceSchema?: string;
}

export function rewriteToEntitySchema(sql: string, opts: RewriteOptions = {}): string {
  const source = opts.sourceSchema ?? DEFAULT_SOURCE_SCHEMA;

  // Quoted schema:   "public".   -> entity.
  // Bare schema:      public.    -> entity.
  // We match the schema token only when followed by a dot (qualifier
  // position), preserving the quoted table that follows.
  const quoted = new RegExp(`"${escapeRegExp(source)}"\\s*\\.`, 'g');
  const bare = new RegExp(`\\b${escapeRegExp(source)}\\s*\\.(?=\\s*")`, 'g');

  return sql.replace(quoted, `${TARGET_SCHEMA}.`).replace(bare, `${TARGET_SCHEMA}.`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
