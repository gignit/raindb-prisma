/**
 * Orchestrator: DMMF datamodel -> RainDB formation artifacts.
 *
 * For each Prisma model it produces:
 *   - the formation config (snapshot-capable; see formation-template.ts)
 *   - the JSON Schema (schemas/vN.json)
 *   - an entry for the adapter model-map (formation id + scope key)
 *   - validation warnings (e.g. auto-gen-id formations whose @id lacks a
 *     Prisma @default, which Prisma would reject before reaching the adapter)
 *
 * The formation id is taken from the model's @@map (recommended: the
 * Periscope `__` table name) or derived from the model name. The scope key is
 * the @id field's payload name.
 */
import type { DMMF } from '@prisma/generator-helper';
import { buildFormationConfig } from './formation-template.js';
import { buildModelSchema, payloadName } from './schema-mapper.js';
import { periscopeTableToFormation } from '../sql/identifiers.js';

export interface GeneratedFormation {
  formationId: string;
  scopeKey: string;
  schemaVersion: number;
  config: Record<string, unknown>;
  schema: Record<string, unknown>;
  warnings: string[];
}

export interface BuildResult {
  formations: GeneratedFormation[];
  /** Adapter model-map: { formations, scopeKeys }. */
  modelMap: { formations: string[]; scopeKeys: Record<string, string> };
}

/**
 * Resolve the RainDB formation id for a model. Prefers the @@map table name,
 * converted from the Periscope `__` form back to a hyphenated formation id
 * (so `@@map("blog__post")` -> formation `blog-post`). Falls back to the
 * model name lowercased when there's no @@map.
 */
export function formationIdForModel(model: DMMF.Model): string {
  if (model.dbName) return periscopeTableToFormation(model.dbName);
  return model.name.toLowerCase();
}

function findIdField(model: DMMF.Model): DMMF.Field | undefined {
  const byFlag = model.fields.find((f) => f.isId);
  if (byFlag) return byFlag;
  // composite primary key is unsupported (RainDB has a single scope key)
  return undefined;
}

export function buildFromDatamodel(
  models: readonly DMMF.Model[],
  opts: { schemaVersion?: number } = {},
): BuildResult {
  const schemaVersion = opts.schemaVersion ?? 1;
  const formations: GeneratedFormation[] = [];
  const modelFormations: string[] = [];
  const scopeKeys: Record<string, string> = {};

  for (const model of models) {
    const warnings: string[] = [];
    const idField = findIdField(model);

    if (model.primaryKey && model.primaryKey.fields.length > 1) {
      warnings.push(
        `Model "${model.name}" has a composite primary key, which RainDB does ` +
          `not support (a formation has a single scope key). Use a single @id ` +
          `field (optionally a denormalized composite string).`,
      );
    }

    if (!idField) {
      warnings.push(
        `Model "${model.name}" has no single @id field; skipping. RainDB ` +
          `formations require exactly one scope key.`,
      );
      // still emit nothing actionable
      continue;
    }

    const scopeKey = payloadName(idField);
    const formationId = formationIdForModel(model);

    // Auto-gen id requires a Prisma @default, or Prisma rejects create()
    // before it reaches the adapter.
    const autoGenId = !idField.hasDefaultValue;
    if (autoGenId) {
      warnings.push(
        `Model "${model.name}": @id field "${idField.name}" has no @default. ` +
          `The formation will auto-generate ids, but Prisma requires a ` +
          `@default(uuid(7)) on the @id field so create() can omit it. Add ` +
          `@default(uuid(7)) to "${idField.name}".`,
      );
    }

    const { schema } = buildModelSchema(model);
    const config = buildFormationConfig({
      formationId,
      scopeKey,
      // When the @id has a Prisma default, the CLIENT generates the id and
      // sends it, so the formation does NOT auto-gen. When it lacks a
      // default, fall back to formation-side auto-gen.
      autoGenId,
      schemaVersion,
    });

    formations.push({ formationId, scopeKey, schemaVersion, config, schema, warnings });
    modelFormations.push(formationId);
    scopeKeys[formationId] = scopeKey;
  }

  return {
    formations,
    modelMap: { formations: modelFormations, scopeKeys },
  };
}
