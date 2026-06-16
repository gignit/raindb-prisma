/**
 * Parameter inlining.
 *
 * Prisma emits SQL with positional `$N` placeholders plus a separate args
 * array. RainDB's executeSQL takes a single SQL string, so the adapter
 * substitutes each `$N` with a safely-quoted SQL literal.
 *
 * Safety: string values are single-quoted with `'` doubled; numbers/booleans
 * are rendered bare; null becomes NULL; dates/json are quoted strings/JSON.
 * Placeholders inside string/identifier literals are NOT substituted (the
 * scanner tracks quote state), so a literal like `'$1'` in user data is
 * never mistaken for a placeholder.
 */
import type { ArgType } from '@prisma/driver-adapter-utils';

export function inlineParams(sql: string, args: unknown[], argTypes: ArgType[]): string {
  if (args.length === 0) return sql;

  let out = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;

    if (inSingle) {
      out += c;
      if (c === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      out += c;
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      out += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      out += c;
      continue;
    }

    if (c === '$' && /\d/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      let num = '';
      while (j < sql.length && /\d/.test(sql[j]!)) {
        num += sql[j]!;
        j++;
      }
      const idx = Number(num) - 1;
      const arg = args[idx];
      const argType = argTypes[idx];
      out += renderLiteral(arg, argType);
      i = j - 1;
      continue;
    }

    out += c;
  }

  return out;
}

function renderLiteral(value: unknown, argType: ArgType | undefined): string {
  if (value === null || value === undefined) return 'NULL';

  const scalar = argType?.scalarType;

  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? String(value) : 'NULL';
    case 'bigint':
      return value.toString();
    case 'boolean':
      return value ? 'TRUE' : 'FALSE';
    case 'string':
      return quote(value);
    case 'object': {
      if (value instanceof Date) return quote(value.toISOString());
      if (value instanceof Uint8Array) return quote(bytesToHex(value));
      // json / array
      return quote(JSON.stringify(value));
    }
    default:
      if (scalar === 'json') return quote(JSON.stringify(value));
      return quote(String(value));
  }
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '\\x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
