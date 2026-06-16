import { describe, expect, it } from 'vitest';
import { classify, leadingKeyword, isRead } from '../src/sql/classify.js';

describe('leadingKeyword', () => {
  it('reads the first keyword', () => {
    expect(leadingKeyword('SELECT 1')).toBe('SELECT');
    expect(leadingKeyword('  insert into x')).toBe('INSERT');
  });

  it('skips block comments (Prisma trace prefix)', () => {
    expect(leadingKeyword("/* trace_id='abc' */ SELECT 1")).toBe('SELECT');
  });

  it('skips line comments', () => {
    expect(leadingKeyword('-- a comment\nUPDATE t SET x=1')).toBe('UPDATE');
  });

  it('handles leading whitespace and newlines', () => {
    expect(leadingKeyword('\n\t  DELETE FROM t')).toBe('DELETE');
  });
});

describe('classify', () => {
  it('classifies reads', () => {
    expect(classify('SELECT * FROM entity."user"')).toBe('read');
    expect(classify('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('read');
    expect(classify('VALUES (1),(2)')).toBe('read');
    expect(classify('EXPLAIN SELECT 1')).toBe('read');
  });

  it('classifies writes', () => {
    expect(classify('INSERT INTO "user" ("id") VALUES ($1)')).toBe('insert');
    expect(classify('UPDATE "user" SET "name" = $1 WHERE "id" = $2')).toBe('update');
    expect(classify('DELETE FROM "user" WHERE "id" = $1')).toBe('delete');
  });

  it('classifies transaction control', () => {
    expect(classify('BEGIN')).toBe('tx');
    expect(classify('COMMIT')).toBe('tx');
    expect(classify('ROLLBACK')).toBe('tx');
    expect(classify('SAVEPOINT s1')).toBe('tx');
  });

  it('isRead helper', () => {
    expect(isRead('SELECT 1')).toBe(true);
    expect(isRead('INSERT INTO t VALUES (1)')).toBe(false);
  });
});
