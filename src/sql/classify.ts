/**
 * Statement classification.
 *
 * Every SqlQuery the Prisma engine hands the adapter is classified by its
 * leading keyword so the adapter can route it:
 *
 *   READ  (SELECT / WITH / VALUES / TABLE / SHOW / EXPLAIN / DESCRIBE)
 *         -> RainDB Periscope `executeSQL` (the analytical/list plane).
 *   WRITE (INSERT / UPDATE / DELETE)
 *         -> translated to droplet operations (RainDB SQL is read-only;
 *            writes go through writeDroplet).
 *   TX    (BEGIN / COMMIT / ROLLBACK / SAVEPOINT ...)
 *         -> handled by the adapter's transaction object, not forwarded.
 *
 * This mirrors RainDB's read-only SQL guard: the analytical plane only
 * accepts read statements, so anything else MUST be intercepted here.
 */

export type StatementKind = 'read' | 'insert' | 'update' | 'delete' | 'tx' | 'unknown';

const READ_LEADERS = new Set([
  'SELECT',
  'WITH',
  'VALUES',
  'TABLE',
  'SHOW',
  'EXPLAIN',
  'DESCRIBE',
  'DESC',
]);

const TX_LEADERS = new Set([
  'BEGIN',
  'START',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
]);

/**
 * Strip leading SQL comments and whitespace, then return the upper-cased
 * leading keyword. Prisma emits sqlcommenter trailers (and sometimes
 * leading trace comments), so we skip `/* ... *\/` and `-- ...` runs.
 */
export function leadingKeyword(sql: string): string {
  let i = 0;
  const n = sql.length;
  for (;;) {
    // skip whitespace
    while (i < n && /\s/.test(sql[i]!)) i++;
    // skip block comment
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return '';
      i = end + 2;
      continue;
    }
    // skip line comment
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      if (end === -1) return '';
      i = end + 1;
      continue;
    }
    break;
  }
  let j = i;
  while (j < n && /[A-Za-z]/.test(sql[j]!)) j++;
  return sql.slice(i, j).toUpperCase();
}

export function classify(sql: string): StatementKind {
  const kw = leadingKeyword(sql);
  if (kw === '') return 'unknown';
  if (READ_LEADERS.has(kw)) return 'read';
  if (kw === 'INSERT') return 'insert';
  if (kw === 'UPDATE') return 'update';
  if (kw === 'DELETE') return 'delete';
  if (TX_LEADERS.has(kw)) return 'tx';
  return 'unknown';
}

export function isRead(sql: string): boolean {
  return classify(sql) === 'read';
}
