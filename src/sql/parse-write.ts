/**
 * Write-statement parser.
 *
 * Translates the constrained INSERT / UPDATE / DELETE shapes that the Prisma
 * query compiler emits into a structured WriteIntent the adapter executes
 * against RainDB (writeDroplet + read-modify-write).
 *
 * DESIGN STANCE (deterministic success or explicit failure):
 * We deliberately parse ONLY the regular shapes Prisma generates for
 * single-model create/update/delete. We do NOT attempt to be a general SQL
 * engine. Anything outside the recognized envelope (CTE writes, writes with
 * subqueries in VALUES, multi-table UPDATE, etc.) throws a clear
 * UnsupportedOperationError so the failure is loud and diagnosable rather
 * than silently wrong.
 *
 * Param model: compiled SQL uses positional placeholders `$1..$n` (postgres
 * provider). The actual values arrive separately in SqlQuery.args. The
 * parser records, for each value position, which placeholder index it maps
 * to, so the executor can substitute real args.
 */
import { UnsupportedOperationError } from '../errors.js';
import { bareTableName, unquoteIdent } from './identifiers.js';

/** A value slot in a parsed statement: a literal, or a $N placeholder ref. */
export type ValueSlot =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'param'; index: number } // 1-based $N
  | { kind: 'default' };

export interface InsertIntent {
  kind: 'insert';
  table: string;
  columns: string[];
  /** One entry per VALUES tuple (Prisma createMany emits multiple). */
  rows: ValueSlot[][];
  /** Columns named in RETURNING, if any (we ignore values, just track). */
  returning: string[];
  /** True when the statement carried ON CONFLICT (upsert-ish). */
  hasOnConflict: boolean;
}

export interface UpdateIntent {
  kind: 'update';
  table: string;
  /** column -> new value slot */
  set: Array<{ column: string; value: ValueSlot }>;
  where: WhereClause | null;
  returning: string[];
}

export interface DeleteIntent {
  kind: 'delete';
  table: string;
  where: WhereClause | null;
  returning: string[];
}

export type WriteIntent = InsertIntent | UpdateIntent | DeleteIntent;

/**
 * A minimal WHERE representation: a conjunction of `column = slot` equalities.
 * This is the shape Prisma emits for by-id / by-unique single-record
 * update/delete. Anything more complex (OR, ranges, IN, subqueries) is not
 * representable here and is reported via `unsupported`.
 */
export interface WhereClause {
  equalities: Array<{ column: string; value: ValueSlot }>;
  /** Non-null when the WHERE had clauses we could not reduce to equalities. */
  unsupported?: string;
}

// --- tokenizer-lite helpers -------------------------------------------------

/** Parse a $N placeholder, a numeric/boolean/null literal, or a quoted string. */
function parseValueSlot(raw: string): ValueSlot {
  const s = raw.trim();
  if (s === '') return { kind: 'default' };
  if (/^DEFAULT$/i.test(s)) return { kind: 'default' };
  const param = /^\$(\d+)$/.exec(s);
  if (param) return { kind: 'param', index: Number(param[1]) };
  if (/^NULL$/i.test(s)) return { kind: 'literal', value: null };
  if (/^TRUE$/i.test(s)) return { kind: 'literal', value: true };
  if (/^FALSE$/i.test(s)) return { kind: 'literal', value: false };
  if (/^-?\d+(\.\d+)?$/.test(s)) return { kind: 'literal', value: Number(s) };
  // single-quoted string literal with '' escapes
  if (s.startsWith("'") && s.endsWith("'")) {
    return { kind: 'literal', value: s.slice(1, -1).replace(/''/g, "'") };
  }
  // Unknown expression (function call, cast, etc.) -> treat as unsupported by
  // returning a sentinel the caller detects. We encode it as a literal string
  // prefixed so the executor can reject it.
  throw new UnsupportedOperationError(
    'write.value-expression',
    `Unsupported value expression in write SQL: ${s.slice(0, 60)}`,
  );
}

/** Split a comma-separated list, respecting quotes and parentheses depth. */
function splitTopLevel(input: string, sep = ','): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (inSingle) {
      buf += c;
      if (c === "'") {
        // handle '' escape
        if (input[i + 1] === "'") {
          buf += "'";
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      buf += c;
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      buf += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      buf += c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === sep && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

/** Remove trailing sqlcommenter / trace comments. */
function stripTrailingComment(sql: string): string {
  // remove a single trailing /* ... */ run and surrounding whitespace
  return sql.replace(/\s*\/\*[\s\S]*?\*\/\s*$/g, '').trim();
}

// --- INSERT -----------------------------------------------------------------

const INSERT_RE =
  /^INSERT\s+INTO\s+([^\s(]+)\s*\(([^)]*)\)\s*VALUES\s*(.+?)(?:\s+ON\s+CONFLICT\s+(.+?))?(?:\s+RETURNING\s+(.+))?$/is;

const INSERT_DEFAULT_RE =
  /^INSERT\s+INTO\s+([^\s(]+)\s+DEFAULT\s+VALUES(?:\s+RETURNING\s+(.+))?$/is;

function parseInsert(sql: string): InsertIntent {
  const s = stripTrailingComment(sql);

  const def = INSERT_DEFAULT_RE.exec(s);
  if (def) {
    return {
      kind: 'insert',
      table: bareTableName(def[1]!),
      columns: [],
      rows: [[]],
      returning: parseReturning(def[2]),
      hasOnConflict: false,
    };
  }

  const m = INSERT_RE.exec(s);
  if (!m) {
    throw new UnsupportedOperationError(
      'write.insert-shape',
      `Unsupported INSERT shape: ${s.slice(0, 120)}`,
    );
  }
  const table = bareTableName(m[1]!);
  const columns = splitTopLevel(m[2]!).map((c) => unquoteIdent(c.trim()));
  const valuesPart = m[3]!.trim();
  const hasOnConflict = m[4] !== undefined;
  const returning = parseReturning(m[5]);

  // valuesPart is like "($1,$2),($3,$4)" -- split into tuples.
  const tuples = splitTopLevel(valuesPart).map((t) => t.trim());
  const rows: ValueSlot[][] = [];
  for (const tuple of tuples) {
    const inner = tuple.replace(/^\(/, '').replace(/\)$/, '');
    const slots = splitTopLevel(inner).map((v) => parseValueSlot(v));
    rows.push(slots);
  }

  return { kind: 'insert', table, columns, rows, returning, hasOnConflict };
}

// --- UPDATE -----------------------------------------------------------------

const UPDATE_RE =
  /^UPDATE\s+([^\s]+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+?))?(?:\s+RETURNING\s+(.+))?$/is;

function parseUpdate(sql: string): UpdateIntent {
  const s = stripTrailingComment(sql);
  const m = UPDATE_RE.exec(s);
  if (!m) {
    throw new UnsupportedOperationError(
      'write.update-shape',
      `Unsupported UPDATE shape: ${s.slice(0, 120)}`,
    );
  }
  const table = bareTableName(m[1]!);
  const setPart = m[2]!;
  const wherePart = m[3];
  const returning = parseReturning(m[4]);

  const set = splitTopLevel(setPart).map((assignment) => {
    const eq = splitAssignment(assignment);
    return { column: unquoteIdent(eq.column), value: parseValueSlot(eq.value) };
  });

  const where = wherePart ? parseWhere(wherePart) : null;
  return { kind: 'update', table, set, where, returning };
}

// --- DELETE -----------------------------------------------------------------

const DELETE_RE = /^DELETE\s+FROM\s+([^\s]+)(?:\s+WHERE\s+(.+?))?(?:\s+RETURNING\s+(.+))?$/is;

function parseDelete(sql: string): DeleteIntent {
  const s = stripTrailingComment(sql);
  const m = DELETE_RE.exec(s);
  if (!m) {
    throw new UnsupportedOperationError(
      'write.delete-shape',
      `Unsupported DELETE shape: ${s.slice(0, 120)}`,
    );
  }
  const table = bareTableName(m[1]!);
  const where = m[2] ? parseWhere(m[2]) : null;
  const returning = parseReturning(m[3]);
  return { kind: 'delete', table, where, returning };
}

// --- shared -----------------------------------------------------------------

function splitAssignment(assignment: string): { column: string; value: string } {
  const idx = indexOfTopLevel(assignment, '=');
  if (idx === -1) {
    throw new UnsupportedOperationError(
      'write.assignment',
      `Unsupported SET assignment: ${assignment.slice(0, 60)}`,
    );
  }
  return {
    column: assignment.slice(0, idx).trim(),
    value: assignment.slice(idx + 1).trim(),
  };
}

/** Find the first top-level occurrence of a single char (not in quotes/parens). */
function indexOfTopLevel(input: string, ch: string): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

function parseReturning(raw: string | undefined): string[] {
  if (!raw) return [];
  return splitTopLevel(stripTrailingComment(raw)).map((c) => {
    const col = c.trim();
    // RETURNING may qualify like "users"."id"; take the last segment.
    return bareTableName(col);
  });
}

/**
 * Strip one or more layers of balanced surrounding parentheses.
 * `(("t"."id" = $1))` -> `"t"."id" = $1`. Only strips when the outermost
 * parens are actually balanced around the whole expression.
 */
function stripOuterParens(s: string): string {
  let cur = s.trim();
  for (;;) {
    if (!cur.startsWith('(') || !cur.endsWith(')')) return cur;
    // verify the opening paren matches the closing one (balanced wrapper)
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let wraps = true;
    for (let i = 0; i < cur.length; i++) {
      const c = cur[i]!;
      if (inSingle) {
        if (c === "'") inSingle = false;
        continue;
      }
      if (inDouble) {
        if (c === '"') inDouble = false;
        continue;
      }
      if (c === "'") inSingle = true;
      else if (c === '"') inDouble = true;
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

/** Split a WHERE on top-level ` AND ` (respecting parens and quotes). */
function splitTopLevelAnd(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inSingle) {
      buf += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      buf += c;
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      buf += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      buf += c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (
      depth === 0 &&
      (c === 'A' || c === 'a') &&
      /^\s/.test(s[i - 1] ?? ' ') &&
      /^and\s/i.test(s.slice(i, i + 4))
    ) {
      out.push(buf);
      buf = '';
      i += 2; // skip "ND"
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

/**
 * Parse a WHERE clause into a conjunction of equalities. Supports the
 * `col = slot [AND col = slot]*` shape Prisma uses for single-record
 * update/delete by id or unique key. Anything else is flagged unsupported.
 */
function parseWhere(raw: string): WhereClause {
  const s = stripOuterParens(stripTrailingComment(raw.trim()));
  // reject obvious non-equality predicates early
  if (/\b(OR|IN|LIKE|IS\s+NULL|BETWEEN)\b/i.test(s) || /(<|>|!=|<>)/.test(s)) {
    return { equalities: [], unsupported: `non-equality WHERE: ${s.slice(0, 80)}` };
  }
  const parts = splitTopLevelAnd(s);
  const equalities: WhereClause['equalities'] = [];
  for (const rawPart of parts) {
    const part = stripOuterParens(rawPart.trim());
    const idx = indexOfTopLevel(part, '=');
    if (idx === -1) {
      return { equalities: [], unsupported: `unparsable WHERE term: ${part.slice(0, 60)}` };
    }
    const column = bareTableName(part.slice(0, idx).trim());
    let value: ValueSlot;
    try {
      value = parseValueSlot(part.slice(idx + 1).trim());
    } catch {
      return { equalities: [], unsupported: `unsupported WHERE value: ${part.slice(0, 60)}` };
    }
    equalities.push({ column, value });
  }
  return { equalities };
}

/** Top-level entry: parse a write statement into a WriteIntent. */
export function parseWrite(sql: string): WriteIntent {
  const trimmed = sql.trimStart();
  if (/^INSERT/i.test(trimmed)) return parseInsert(sql);
  if (/^UPDATE/i.test(trimmed)) return parseUpdate(sql);
  if (/^DELETE/i.test(trimmed)) return parseDelete(sql);
  throw new UnsupportedOperationError(
    'write.unknown',
    `Not a recognized write statement: ${trimmed.slice(0, 60)}`,
  );
}

/** Resolve a ValueSlot against the positional args array (1-based $N). */
export function resolveSlot(slot: ValueSlot, args: unknown[]): unknown {
  switch (slot.kind) {
    case 'literal':
      return slot.value;
    case 'param':
      return args[slot.index - 1] ?? null;
    case 'default':
      return undefined; // caller decides (auto-gen / omit)
  }
}
