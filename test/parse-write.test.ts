import { describe, expect, it } from 'vitest';
import { parseWrite, resolveSlot } from '../src/sql/parse-write.js';
import { UnsupportedOperationError } from '../src/errors.js';

describe('parseWrite: INSERT', () => {
  it('parses a single-row insert with positional params', () => {
    const intent = parseWrite('INSERT INTO "user" ("id","name") VALUES ($1,$2)');
    expect(intent.kind).toBe('insert');
    if (intent.kind !== 'insert') return;
    expect(intent.table).toBe('user');
    expect(intent.columns).toEqual(['id', 'name']);
    expect(intent.rows).toHaveLength(1);
    expect(intent.rows[0]).toEqual([
      { kind: 'param', index: 1 },
      { kind: 'param', index: 2 },
    ]);
  });

  it('parses multi-row insert (createMany)', () => {
    const intent = parseWrite('INSERT INTO "post" ("id") VALUES ($1),($2),($3)');
    if (intent.kind !== 'insert') throw new Error('expected insert');
    expect(intent.rows).toHaveLength(3);
  });

  it('parses RETURNING columns', () => {
    const intent = parseWrite('INSERT INTO "user" ("id") VALUES ($1) RETURNING "id"');
    if (intent.kind !== 'insert') throw new Error('expected insert');
    expect(intent.returning).toEqual(['id']);
  });

  it('flags ON CONFLICT', () => {
    const intent = parseWrite(
      'INSERT INTO "user" ("id") VALUES ($1) ON CONFLICT ("id") DO NOTHING',
    );
    if (intent.kind !== 'insert') throw new Error('expected insert');
    expect(intent.hasOnConflict).toBe(true);
  });

  it('handles DEFAULT VALUES', () => {
    const intent = parseWrite('INSERT INTO "user" DEFAULT VALUES');
    if (intent.kind !== 'insert') throw new Error('expected insert');
    expect(intent.columns).toEqual([]);
    expect(intent.rows).toEqual([[]]);
  });

  it('strips trailing sqlcommenter', () => {
    const intent = parseWrite(
      `INSERT INTO "user" ("id") VALUES ($1) /* trace_id='abc' */`,
    );
    if (intent.kind !== 'insert') throw new Error('expected insert');
    expect(intent.columns).toEqual(['id']);
  });
});

describe('parseWrite: UPDATE', () => {
  it('parses set assignments and a single equality where', () => {
    const intent = parseWrite('UPDATE "user" SET "name" = $1 WHERE "id" = $2');
    if (intent.kind !== 'update') throw new Error('expected update');
    expect(intent.table).toBe('user');
    expect(intent.set).toEqual([{ column: 'name', value: { kind: 'param', index: 1 } }]);
    expect(intent.where?.equalities).toEqual([
      { column: 'id', value: { kind: 'param', index: 2 } },
    ]);
  });

  it('flags non-equality WHERE as unsupported', () => {
    const intent = parseWrite('UPDATE "user" SET "n" = $1 WHERE "age" > $2');
    if (intent.kind !== 'update') throw new Error('expected update');
    expect(intent.where?.unsupported).toBeTruthy();
  });
});

describe('parseWrite: DELETE', () => {
  it('parses delete with where', () => {
    const intent = parseWrite('DELETE FROM "user" WHERE "id" = $1');
    if (intent.kind !== 'delete') throw new Error('expected delete');
    expect(intent.table).toBe('user');
    expect(intent.where?.equalities).toEqual([
      { column: 'id', value: { kind: 'param', index: 1 } },
    ]);
  });
});

describe('resolveSlot', () => {
  it('resolves params 1-based against args', () => {
    expect(resolveSlot({ kind: 'param', index: 2 }, ['a', 'b', 'c'])).toBe('b');
    expect(resolveSlot({ kind: 'literal', value: 5 }, [])).toBe(5);
    expect(resolveSlot({ kind: 'default' }, [])).toBeUndefined();
  });
});

describe('parseWrite: rejects unrecognized', () => {
  it('throws on non-write statement', () => {
    expect(() => parseWrite('SELECT 1')).toThrow(UnsupportedOperationError);
  });
});
