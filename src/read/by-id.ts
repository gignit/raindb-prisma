/**
 * Resolution-plane routing for single-record-by-id reads.
 *
 * A `findUnique({ where: { id } })` compiles to a SELECT against one table
 * with a single primary-key equality. RainDB serves that far better from the
 * RESOLUTION plane (readLatest by the by-id index): it is O(1), strongly
 * consistent, and 0ms on the wire cache -- whereas Periscope SQL is
 * eventually consistent and would miss a just-written record.
 *
 * This module detects that shape and, when it matches, resolves the record
 * via readLatest and returns it as a SqlResultSet. When it does not match
 * (joins, ranges, multi-row, projections we can't satisfy from the droplet),
 * it returns null and the caller falls back to the Periscope SQL path.
 */
import type { SqlQuery, SqlResultSet } from '@prisma/driver-adapter-utils';
import type { ResolvedConfig } from '../config.js';
import type { RainDBClient } from '../raindb/client.js';
import type { FormationNameMap } from '../sql/identifiers.js';
import { bareTableName, resolveFormation } from '../sql/identifiers.js';
import { toSqlResultSet } from './column-types.js';

export interface ByIdContext {
  client: RainDBClient;
  cfg: ResolvedConfig;
  nameMap: FormationNameMap;
  scopeKeyOf: (formationId: string) => string;
}

/**
 * Try to satisfy a SELECT as a by-id resolution-plane read. Returns the
 * result set on success, or null to signal "not a by-id read, use SQL".
 *
 * `sql` here is the param-inlined, entity-schema-rewritten SQL (so table
 * refs are `entity."t"` and `$N` are already substituted).
 */
export async function tryResolveById(
  ctx: ByIdContext,
  sql: string,
  inlinedArgs: ReadonlyArray<unknown>,
): Promise<SqlResultSet | null> {
  void inlinedArgs;
  const parsed = parseByIdSelect(sql);
  if (!parsed) return null;

  const formationId = resolveFormation(parsed.table, ctx.nameMap);
  const scopeKey = ctx.scopeKeyOf(formationId);

  // Only route when the equality is on the scope key (the by-id index).
  if (parsed.whereColumn !== scopeKey && parsed.whereColumn !== 'id') {
    return null;
  }

  const droplet = await ctx.client.readLatest(formationId, 'by-id-latest', parsed.whereValue);
  if (!droplet || !droplet.payload || typeof droplet.payload !== 'object') {
    // Not found -> empty result set (Prisma maps to null / []).
    return emptyResultFor(parsed.columns);
  }

  const payload = droplet.payload as Record<string, unknown>;
  const columns = parsed.columns ?? Object.keys(payload);
  const row: Record<string, unknown> = {};
  for (const col of columns) row[col] = col in payload ? payload[col] : null;

  return toSqlResultSet(columns, [row]);
}

interface ParsedByIdSelect {
  table: string;
  /** Projected columns, or null for SELECT * . */
  columns: string[] | null;
  whereColumn: string;
  whereValue: string;
}

/**
 * Recognize a single-record-by-id SELECT. Prisma 7's findUnique compiles to:
 *
 *   SELECT <cols> FROM <schema>."t"
 *   WHERE (<qualcol> = '<lit>' AND 1=1) LIMIT 1 OFFSET 0
 *
 * so the detector must tolerate: a parenthesized WHERE, trailing `AND 1=1`
 * (and similar always-true noise), fully-qualified columns, and
 * LIMIT/OFFSET (already param-inlined to literals). Returns null when the
 * shape implies a multi-row or relational intent.
 */
function parseByIdSelect(sqlRaw: string): ParsedByIdSelect | null {
  let sql = sqlRaw.replace(/\s+/g, ' ').trim().replace(/;+\s*$/, '');

  // No joins / unions / grouping / subqueries / ordering.
  if (/\b(JOIN|UNION|GROUP\s+BY|HAVING|ORDER\s+BY)\b/i.test(sql)) return null;
  if ((sql.match(/\bFROM\b/gi) ?? []).length !== 1) return null;
  if ((sql.match(/\bSELECT\b/gi) ?? []).length !== 1) return null; // no subselect

  // Strip a trailing LIMIT [n] OFFSET [m]; only route when LIMIT resolves to 1
  // (or absent) and OFFSET is 0 (or absent) -- otherwise it's a list page.
  // The values may be bare digits OR quoted numeric literals ('1'/'0'),
  // because Prisma sometimes types LIMIT/OFFSET params as strings and the
  // adapter inlines them as quoted literals.
  const numLit = `'?\\d+'?`;
  const limitMatch = new RegExp(
    `\\bLIMIT\\s+(${numLit})(?:\\s+OFFSET\\s+(${numLit}))?\\s*$`,
    'i',
  ).exec(sql);
  if (limitMatch) {
    if (unquoteNum(limitMatch[1]!) !== 1) return null;
    if (limitMatch[2] !== undefined && unquoteNum(limitMatch[2]) !== 0) return null;
    sql = sql.slice(0, limitMatch.index).trim();
  }

  const m = /^SELECT\s+(?<cols>.+?)\s+FROM\s+(?<rest>.+)$/i.exec(sql);
  if (!m || !m.groups) return null;

  const rest = m.groups['rest']!;
  const whereIdx = rest.search(/\bWHERE\b/i);
  if (whereIdx === -1) return null;
  const tableRef = rest.slice(0, whereIdx).trim();
  let where = rest.slice(whereIdx + 5).trim();

  // table ref: `entity."t"` or `"schema"."t"` possibly with an alias.
  const tableMatch =
    /^((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))*)(?:\s+(?:AS\s+)?"?[A-Za-z_][\w$]*"?)?$/i.exec(
      tableRef,
    );
  if (!tableMatch) return null;
  const table = tableMatch[1]!;

  // Strip balanced outer parens, then drop always-true noise like `AND 1=1`.
  where = stripBalancedParens(where);
  where = where.replace(/\s+AND\s+1\s*=\s*1\b/gi, '').trim();
  where = stripBalancedParens(where);

  // Must now be exactly one equality `col = 'literal'`. The column may be
  // qualified with bare and/or quoted segments (e.g. entity."t"."id").
  if (/\b(AND|OR|IN|LIKE|IS\s+NULL|BETWEEN)\b/i.test(where)) return null;
  if (/(<|>|!=|<>)/.test(where)) return null;
  const seg = `(?:"[^"]+"|[A-Za-z_][\\w$]*)`;
  const eq = new RegExp(`^(?<col>${seg}(?:\\s*\\.\\s*${seg})*)\\s*=\\s*'(?<val>(?:[^']|'')*)'$`).exec(
    where,
  );
  if (!eq || !eq.groups) return null;

  const colsRaw = m.groups['cols']!.trim();
  const columns =
    colsRaw === '*'
      ? null
      : colsRaw.split(',').map((c) => bareTableName(c.trim().replace(/\s+AS\s+.*$/i, '')));

  return {
    table,
    columns,
    whereColumn: bareTableName(eq.groups['col']!),
    whereValue: eq.groups['val']!.replace(/''/g, "'"),
  };
}

/** Strip one layer of balanced surrounding parens if they wrap the whole expr. */
function stripBalancedParens(s: string): string {
  let cur = s.trim();
  for (;;) {
    if (!cur.startsWith('(') || !cur.endsWith(')')) return cur;
    let depth = 0;
    let wraps = true;
    let inS = false;
    let inD = false;
    for (let i = 0; i < cur.length; i++) {
      const c = cur[i]!;
      if (inS) {
        if (c === "'") inS = false;
        continue;
      }
      if (inD) {
        if (c === '"') inD = false;
        continue;
      }
      if (c === "'") inS = true;
      else if (c === '"') inD = true;
      else if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0 && i !== cur.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (!wraps) return cur;
    cur = cur.slice(1, -1).trim();
  }
}

function unquoteNum(s: string): number {
  return Number(s.replace(/'/g, ''));
}

function emptyResultFor(columns: string[] | null): SqlResultSet {
  const names = columns ?? [];
  return {
    columnNames: names,
    columnTypes: names.map(() => 7 /* Text */),
    rows: [],
  };
}
