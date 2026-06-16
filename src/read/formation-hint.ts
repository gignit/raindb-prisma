/**
 * Formation hint extraction.
 *
 * RainDB's executeSQL needs a `formationId` hint to attach the per-tenant
 * Periscope view into the session search path before running the query
 * (otherwise the entity table isn't resolvable). A RainDB client passes this
 * explicitly per query; the adapter derives it from the SQL by finding the
 * first `entity."<name>"` (or `"<name>"`) table reference and converting the
 * Periscope table name back to a formation id via the `__`->`-` rule.
 *
 * Returns undefined when no entity reference is found (e.g. SELECT 1), in
 * which case executeSQL runs without a hint.
 */

import { bareTableName, periscopeTableToFormation } from '../sql/identifiers.js';

/**
 * Match the first table reference after FROM / JOIN / INTO / UPDATE. The
 * reference may be schema-qualified (`entity."t"`, `"public"."t"`) and the
 * table segment is always the LAST quoted segment, so we capture the whole
 * dotted reference and reduce it with bareTableName.
 */
const TABLE_REF_RE =
  /\b(?:from|join|into|update)\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))*)/i;

export function formationHintFromSQL(sql: string): string | undefined {
  const m = TABLE_REF_RE.exec(sql);
  if (!m) return undefined;
  const table = bareTableName(m[1]!);
  return periscopeTableToFormation(table);
}
