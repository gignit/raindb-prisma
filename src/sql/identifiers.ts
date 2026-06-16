/**
 * Identifier helpers: SQL table/column names <-> RainDB formation/field
 * names.
 *
 * Naming contract (RainDB Periscope table-name rule):
 *   - A Prisma model maps to a RainDB formation. The Periscope SQL view for
 *     a formation is exposed as `entity."<formation-with-hyphens-as-__>"`.
 *     Periscope rewrites EVERY hyphen in a formation id to a DOUBLE
 *     underscore (`__`), system-wide. So a formation `my-entity` is queried
 *     as `entity."my__entity"`, and `vizzda-events` as `entity."vizzda__events"`.
 *     (Double underscore -- not single -- is deliberate: it round-trips
 *     cleanly back to a hyphen and avoids colliding with formation ids that
 *     legitimately contain single underscores.)
 *   - The adapter therefore cannot blindly assume table name == formation
 *     id. It uses a FormationNameMap built from the Prisma datamodel (the
 *     generator emits it) to translate both directions. When no map entry
 *     exists, it falls back to the `__`->`-` inverse, which is correct for
 *     formations whose ids contain no single underscores.
 */

/** Periscope rewrites every hyphen in a formation id to a double underscore. */
export function formationToPeriscopeTable(formationId: string): string {
  return formationId.replace(/-/g, '__');
}

/** Inverse of the Periscope table rule: `__` -> `-`. */
export function periscopeTableToFormation(table: string): string {
  return table.replace(/__/g, '-');
}

/** Bidirectional model/table <-> formation name mapping. */
export interface FormationNameMap {
  /** SQL table name (unquoted, as it appears in compiled SQL) -> formation id. */
  tableToFormation: Record<string, string>;
  /** formation id -> SQL table name. */
  formationToTable: Record<string, string>;
}

export function emptyNameMap(): FormationNameMap {
  return { tableToFormation: {}, formationToTable: {} };
}

/**
 * Build a name map from a list of formation ids. The SQL table name is the
 * formation id with hyphens replaced by double underscores (the Periscope
 * table-name rule).
 */
export function nameMapFromFormations(formationIds: string[]): FormationNameMap {
  const map = emptyNameMap();
  for (const fid of formationIds) {
    const table = formationToPeriscopeTable(fid);
    map.tableToFormation[table] = fid;
    map.formationToTable[fid] = table;
  }
  return map;
}

/** Strip surrounding double-quotes and unescape `""` -> `"`. */
export function unquoteIdent(ident: string): string {
  const s = ident.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}

/**
 * Given a raw table reference from compiled SQL (possibly schema-qualified
 * and/or quoted, e.g. `entity."my_model"`, `"my_model"`, `public."User"`),
 * return the bare table name (the last path segment, unquoted).
 */
export function bareTableName(ref: string): string {
  const trimmed = ref.trim();
  // Split on '.' but not inside quotes.
  const segments: string[] = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (c === '"') {
      inQuote = !inQuote;
      buf += c;
    } else if (c === '.' && !inQuote) {
      segments.push(buf);
      buf = '';
    } else {
      buf += c;
    }
  }
  segments.push(buf);
  const last = segments[segments.length - 1] ?? trimmed;
  return unquoteIdent(last);
}

/**
 * Resolve a compiled-SQL table reference to a RainDB formation id using the
 * name map, with an identity fallback when unmapped.
 */
export function resolveFormation(ref: string, map: FormationNameMap): string {
  const table = bareTableName(ref);
  const mapped = map.tableToFormation[table];
  if (mapped) return mapped;
  // Fallback when unmapped: apply the inverse Periscope rule (`__` -> `-`).
  // Correct for formation ids that contain no single underscores; the
  // generator-emitted map covers the ambiguous cases.
  return periscopeTableToFormation(table);
}
