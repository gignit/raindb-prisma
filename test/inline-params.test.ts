import { describe, expect, it } from 'vitest';
import type { ArgType } from '@prisma/driver-adapter-utils';
import { inlineParams } from '../src/read/inline-params.js';

const t = (scalarType: ArgType['scalarType']): ArgType => ({ scalarType, arity: 'scalar' });

describe('inlineParams', () => {
  it('inlines string params with quote escaping', () => {
    const sql = inlineParams('SELECT * FROM t WHERE name = $1', ["O'Brien"], [t('string')]);
    expect(sql).toBe("SELECT * FROM t WHERE name = 'O''Brien'");
  });

  it('inlines numbers and booleans bare', () => {
    const sql = inlineParams('SELECT * FROM t WHERE a = $1 AND b = $2', [42, true], [
      t('int'),
      t('boolean'),
    ]);
    expect(sql).toBe('SELECT * FROM t WHERE a = 42 AND b = TRUE');
  });

  it('renders null as NULL', () => {
    const sql = inlineParams('SELECT $1', [null], [t('string')]);
    expect(sql).toBe('SELECT NULL');
  });

  it('does NOT substitute placeholders inside string literals', () => {
    // The literal '$1' must survive untouched; the real $1 is replaced.
    const sql = inlineParams("SELECT '$1' AS lit, $1 AS val", ['x'], [t('string')]);
    expect(sql).toBe("SELECT '$1' AS lit, 'x' AS val");
  });

  it('handles multi-digit placeholders', () => {
    const args = Array.from({ length: 12 }, (_, i) => i + 1);
    const types = args.map(() => t('int'));
    const sql = inlineParams('SELECT $10, $11, $12', args, types);
    expect(sql).toBe('SELECT 10, 11, 12');
  });

  it('serializes json/object args', () => {
    const sql = inlineParams('SELECT $1', [{ a: 1 }], [t('json')]);
    expect(sql).toBe(`SELECT '{"a":1}'`);
  });

  it('serializes Date args as ISO strings', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    const sql = inlineParams('SELECT $1', [d], [t('datetime')]);
    expect(sql).toBe("SELECT '2026-01-02T03:04:05.000Z'");
  });

  it('returns sql unchanged when no args', () => {
    expect(inlineParams('SELECT 1', [], [])).toBe('SELECT 1');
  });
});
