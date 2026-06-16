/**
 * Map a Prisma model's fields to a JSON Schema for the formation's
 * schemas/vN.json. The schema is permissive (additionalProperties: true) so
 * RainDB's envelope fields and denormalized extras don't fail validation;
 * it pins types for the declared scalar fields and marks the scope key
 * required.
 */
import type { DMMF } from '@prisma/generator-helper';

type JSONSchemaProp = {
  type?: string | string[];
  description?: string;
  format?: string;
};

const SCALAR_TO_JSON: Record<string, string> = {
  String: 'string',
  Boolean: 'boolean',
  Int: 'integer',
  BigInt: 'integer',
  Float: 'number',
  Decimal: 'number',
  DateTime: 'string',
  Json: 'object',
  Bytes: 'string',
};

export interface ModelSchema {
  schema: Record<string, unknown>;
  scopeKey: string;
}

/**
 * Resolve the payload field name for a Prisma field: the @map name when
 * present, else the field name. (The adapter and formation both key on the
 * payload field name, which is what lands in the droplet.)
 */
export function payloadName(field: DMMF.Field): string {
  return field.dbName ?? field.name;
}

export function buildModelSchema(model: DMMF.Model): ModelSchema {
  const properties: Record<string, JSONSchemaProp> = {};
  let scopeKey = 'id';

  for (const field of model.fields) {
    if (field.kind === 'object') continue; // relation field, not a column
    const name = payloadName(field);

    if (field.isId) scopeKey = name;

    const prop: JSONSchemaProp = {};
    const jsonType = SCALAR_TO_JSON[field.type] ?? 'string';

    if (field.isList) {
      prop.type = 'array';
    } else if (!field.isRequired) {
      // optional -> allow null alongside the base type
      prop.type = [jsonType, 'null'];
    } else {
      prop.type = jsonType;
    }

    if (field.type === 'DateTime') prop.format = 'date-time';
    if (field.documentation) prop.description = field.documentation;

    properties[name] = prop;
  }

  const schema: Record<string, unknown> = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: model.name,
    type: 'object',
    // Permissive: RainDB envelope fields (dropletId, ts, author, tenantId,
    // ...) and denormalized extras must not fail validation.
    additionalProperties: true,
    properties,
    required: [scopeKey],
  };

  if (model.documentation) schema['description'] = model.documentation;

  return { schema, scopeKey };
}
