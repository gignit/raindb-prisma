/**
 * Column-type inference + row shaping for `queryRaw` results.
 *
 * RainDB Periscope returns rows as JSON objects (column -> value). Prisma's
 * query engine wants a column-oriented `SqlResultSet` with an explicit
 * `ColumnType` per column so it can convert JS values back into engine
 * values. RainDB has no static column-type catalog exposed to the adapter,
 * so we INFER the column type from the values in the result set (first
 * non-null wins), matching how the Rust quaint layer treats dynamic results.
 */
import { ColumnTypeEnum } from '@prisma/driver-adapter-utils';
import type { ColumnType, SqlResultSet } from '@prisma/driver-adapter-utils';

/**
 * Infer a single column's Prisma ColumnType from a sampled value.
 * Conservative: anything we can't classify becomes Text/Json, which the
 * engine can still coerce against the schema-declared field type.
 */
function inferColumnType(value: unknown): ColumnType | null {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case 'boolean':
      return ColumnTypeEnum.Boolean;
    case 'number':
      return Number.isInteger(value) ? ColumnTypeEnum.Int64 : ColumnTypeEnum.Double;
    case 'bigint':
      return ColumnTypeEnum.Int64;
    case 'string':
      // Periscope returns timestamps and UUIDs as strings; we keep them Text
      // and let the engine coerce by declared field type. Detecting them here
      // risks mis-tagging arbitrary text, which is worse than Text.
      return ColumnTypeEnum.Text;
    case 'object':
      if (Array.isArray(value)) return ColumnTypeEnum.Json;
      return ColumnTypeEnum.Json;
    default:
      return ColumnTypeEnum.Text;
  }
}

/**
 * Build the ColumnType[] for a result, sampling down each column until a
 * non-null value is found. Columns that are entirely null default to Text.
 */
function inferColumnTypes(
  columns: string[],
  rows: Array<Record<string, unknown>>,
): ColumnType[] {
  return columns.map((col) => {
    for (const row of rows) {
      const t = inferColumnType(row[col]);
      if (t !== null) return t;
    }
    return ColumnTypeEnum.Text;
  });
}

/**
 * Normalize a single value for the engine given its inferred column type.
 * The engine expects scalars as primitives and Json columns as JSON strings.
 */
function normalizeValue(value: unknown, columnType: ColumnType): unknown {
  if (value === null || value === undefined) return null;

  if (columnType === ColumnTypeEnum.Json) {
    // Engine wants Json columns as serialized strings.
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  if (columnType === ColumnTypeEnum.Int64) {
    // Keep integers as numbers; the engine handles BigInt coercion. Strings
    // that are integer-shaped (Periscope may stringify large ints) pass
    // through as-is for the engine to parse.
    return value;
  }

  return value;
}

/**
 * Convert a RainDB Periscope result (JSON-object rows) into Prisma's
 * column-oriented SqlResultSet.
 */
export function toSqlResultSet(
  columns: string[],
  rows: Array<Record<string, unknown>>,
): SqlResultSet {
  const columnTypes = inferColumnTypes(columns, rows);

  const mappedRows = rows.map((row) =>
    columns.map((col, i) => normalizeValue(row[col], columnTypes[i]!)),
  );

  return {
    columnNames: columns,
    columnTypes,
    rows: mappedRows,
  };
}
