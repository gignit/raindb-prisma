import { describe, expect, it } from 'vitest';
import { formationHintFromSQL } from '../src/read/formation-hint.js';
import { rewriteToEntitySchema } from '../src/read/rewrite-sql.js';

describe('formationHintFromSQL', () => {
  it('extracts the table from an entity-qualified ref', () => {
    expect(formationHintFromSQL('SELECT * FROM entity."vizzda__events"')).toBe(
      'vizzda-events',
    );
  });

  it('skips a schema qualifier (public) and takes the table', () => {
    expect(
      formationHintFromSQL('SELECT * FROM "public"."vizzda__events" LIMIT 1'),
    ).toBe('vizzda-events');
  });

  it('handles a bare quoted table', () => {
    expect(formationHintFromSQL('SELECT * FROM "fdn__documents"')).toBe('fdn-documents');
  });

  it('handles JOIN sources', () => {
    expect(
      formationHintFromSQL('SELECT * FROM "public"."a__b" JOIN "public"."c__d" ON 1=1'),
    ).toBe('a-b');
  });

  it('returns undefined when no table ref', () => {
    expect(formationHintFromSQL('SELECT 1')).toBeUndefined();
  });
});

describe('rewriteToEntitySchema', () => {
  it('rewrites the public schema qualifier to entity', () => {
    expect(rewriteToEntitySchema('SELECT * FROM "public"."vizzda__events"')).toBe(
      'SELECT * FROM entity."vizzda__events"',
    );
  });

  it('leaves the table identifier untouched', () => {
    const out = rewriteToEntitySchema(
      'SELECT "t"."eventId" FROM "public"."vizzda__events" AS "t"',
    );
    expect(out).toContain('entity."vizzda__events"');
    // column/table-alias references must be preserved
    expect(out).toContain('"t"."eventId"');
  });

  it('is a no-op when already entity-qualified', () => {
    const sql = 'SELECT * FROM entity."x"';
    expect(rewriteToEntitySchema(sql)).toBe(sql);
  });
});
