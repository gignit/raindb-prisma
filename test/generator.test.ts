import { describe, expect, it } from 'vitest';
import { buildFormationConfig } from '../src/generator/formation-template.js';
import { buildFromDatamodel, formationIdForModel } from '../src/generator/build.js';
import { buildModelSchema } from '../src/generator/schema-mapper.js';
import type { DMMF } from '@prisma/generator-helper';

// Minimal DMMF model factory for tests.
function model(over: Partial<DMMF.Model> & { name: string }): DMMF.Model {
  return {
    name: over.name,
    dbName: over.dbName ?? null,
    schema: null,
    fields: over.fields ?? [],
    primaryKey: over.primaryKey ?? null,
    uniqueFields: [],
    uniqueIndexes: [],
    documentation: over.documentation,
  } as unknown as DMMF.Model;
}

function field(over: Partial<DMMF.Field> & { name: string }): DMMF.Field {
  return {
    name: over.name,
    kind: over.kind ?? 'scalar',
    isList: over.isList ?? false,
    isRequired: over.isRequired ?? true,
    isUnique: false,
    isId: over.isId ?? false,
    isReadOnly: false,
    hasDefaultValue: over.hasDefaultValue ?? false,
    type: over.type ?? 'String',
    dbName: over.dbName ?? null,
    documentation: over.documentation,
  } as unknown as DMMF.Field;
}

describe('buildFormationConfig: snapshot-critical shape', () => {
  const cfg = buildFormationConfig({
    formationId: 'blog-post',
    scopeKey: 'postId',
    autoGenId: false,
    schemaVersion: 1,
  }) as any;

  it('has the periscope-pool onDroplet action (fires the cascade)', () => {
    expect(cfg.actions).toEqual([
      { action: 'periscope-pool', trigger: 'onDroplet', metadata: { tier: 'stream' } },
    ]);
  });

  it('has a by-update pointer index with descIndex enabled, keyed by dropletId', () => {
    const byUpdate = cfg.indexes.find((i: any) => i.name === 'by-update');
    expect(byUpdate).toBeTruthy();
    expect(byUpdate.type).toBe('pointer');
    expect(byUpdate.template).toContain('{{.dropletId}}');
    expect(byUpdate.descIndex.enabled).toBe(true);
  });

  it('has a by-id-latest pointer index keyed by the scope key', () => {
    const byId = cfg.indexes.find((i: any) => i.name === 'by-id-latest');
    expect(byId).toBeTruthy();
    expect(byId.template).toContain('{{.postId}}');
  });

  it('stream tier sources droplets through the by-update index', () => {
    expect(cfg.tierPolicy.tiers.stream.source).toEqual({
      type: 'droplets',
      index: 'by-update',
    });
  });

  it('river/lake tiers roll up from the tier below', () => {
    expect(cfg.tierPolicy.tiers.river.source).toEqual({ type: 'tier', tier: 'stream' });
    expect(cfg.tierPolicy.tiers.lake.source).toEqual({ type: 'tier', tier: 'river' });
  });

  it('has catalog location, partition, and expiration', () => {
    expect(cfg.tierPolicy.catalog.location).toContain('catalog');
    expect(cfg.tierPolicy.partition.strategy).toBe('formation');
    expect(cfg.tierPolicy.expiration).toBeTruthy();
  });

  it('enables dedup + autoPool views', () => {
    expect(cfg.views.defaultBehavior.dedup).toBe(true);
    expect(cfg.views.queryDefaults.autoPool).toBe(true);
  });

  it('queryConfig is enabled', () => {
    expect(cfg.queryConfig.enabled).toBe(true);
  });
});

describe('formationIdForModel: applies the __ table rule inverse', () => {
  it('uses @@map and converts __ back to -', () => {
    expect(formationIdForModel(model({ name: 'BlogPost', dbName: 'blog__post' }))).toBe(
      'blog-post',
    );
  });
  it('falls back to lowercased model name without @@map', () => {
    expect(formationIdForModel(model({ name: 'User' }))).toBe('user');
  });
});

describe('buildFromDatamodel', () => {
  it('emits a formation + model-map entry per model and warns on autoGenId without default', () => {
    const m = model({
      name: 'Post',
      dbName: 'post',
      fields: [
        field({ name: 'id', isId: true, hasDefaultValue: false, dbName: 'id' }),
        field({ name: 'title', isRequired: false }),
      ],
    });
    const result = buildFromDatamodel([m]);
    expect(result.modelMap.formations).toEqual(['post']);
    expect(result.modelMap.scopeKeys).toEqual({ post: 'id' });
    // autoGenId (no default) -> warning about needing @default
    expect(result.formations[0]!.warnings.join(' ')).toMatch(/@default/);
    expect(result.formations[0]!.config.autoGenId).toBe(true);
  });

  it('does not warn when the @id has a default', () => {
    const m = model({
      name: 'Post',
      dbName: 'post',
      fields: [field({ name: 'id', isId: true, hasDefaultValue: true })],
    });
    const result = buildFromDatamodel([m]);
    expect(result.formations[0]!.warnings).toHaveLength(0);
    expect(result.formations[0]!.config.autoGenId).toBe(false);
  });
});

describe('buildModelSchema', () => {
  it('maps scalar types and marks the scope key required', () => {
    const m = model({
      name: 'Post',
      fields: [
        field({ name: 'id', isId: true, dbName: 'postId' }),
        field({ name: 'views', type: 'Int', isRequired: false }),
        field({ name: 'author', kind: 'object' }), // relation -> skipped
      ],
    });
    const { schema, scopeKey } = buildModelSchema(m);
    expect(scopeKey).toBe('postId');
    expect((schema as any).required).toEqual(['postId']);
    expect((schema as any).properties.views.type).toEqual(['integer', 'null']);
    expect((schema as any).properties.author).toBeUndefined();
  });
});
