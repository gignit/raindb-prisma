/**
 * The RainDB SqlDriverAdapter.
 *
 * Implements the Prisma driver-adapter contract
 * (@prisma/driver-adapter-utils):
 *
 *   queryRaw(SqlQuery)   -> reads via RainDB Periscope (executeSQL) + the
 *                           freshness drift merge.
 *   executeRaw(SqlQuery) -> writes via droplet operations (INSERT/UPDATE/
 *                           DELETE translation).
 *   startTransaction()   -> a best-effort transaction object (see TRANSACTIONS
 *                           below).
 *
 * Provider: 'postgres'. RainDB has no Postgres wire protocol, but the
 * driver-adapter Provider union is closed to four SQL dialects; 'postgres'
 * is the closest match to the SQL the engine should generate for RainDB's
 * Periscope plane (positional $N params, double-quoted identifiers).
 *
 * TRANSACTIONS: RainDB has no multi-record ACID transaction across
 * formations (writes are immutable single-droplet appends with single-key
 * CAS). The adapter therefore implements a "pass-through" transaction: each
 * statement is applied as it arrives, and commit/rollback are advisory.
 * This is correct for the common single-aggregate case (one droplet write)
 * and for read transactions; it does NOT provide cross-formation rollback.
 * The adapter surfaces this honestly rather than faking durability it cannot
 * deliver. See README "Transactions".
 */
import type {
  IsolationLevel,
  SqlDriverAdapter,
  SqlQuery,
  SqlQueryable,
  SqlResultSet,
  Transaction,
  TransactionOptions,
} from '@prisma/driver-adapter-utils';
import { DriverAdapterError } from '@prisma/driver-adapter-utils';

import type { ResolvedConfig } from './config.js';
import { RainDBError, UnsupportedOperationError } from './errors.js';
import { mapRainDBError } from './raindb/error-map.js';
import type { RainDBClient } from './raindb/client.js';
import { classify } from './sql/classify.js';
import type { FormationNameMap } from './sql/identifiers.js';
import { executeRead } from './read/execute-read.js';
import { toSqlResultSet } from './read/column-types.js';
import { executeWrite, type WriteContext } from './write/execute-write.js';

const PROVIDER = 'postgres' as const;
const ADAPTER_NAME = '@raindb/prisma-adapter';

export interface AdapterDeps {
  client: RainDBClient;
  cfg: ResolvedConfig;
  nameMap: FormationNameMap;
  scopeKeyOf: (formationId: string) => string;
  author: string;
}

class RainDBQueryable implements SqlQueryable {
  readonly provider = PROVIDER;
  readonly adapterName = ADAPTER_NAME;

  protected readonly deps: AdapterDeps;

  constructor(deps: AdapterDeps) {
    this.deps = deps;
  }

  async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    const kind = classify(query.sql);
    try {
      if (kind === 'read') {
        return await executeRead(this.deps, query);
      }
      // Writes can arrive at queryRaw when Prisma uses RETURNING (it reads
      // the result back). Execute the write, then surface the written rows.
      if (kind === 'insert' || kind === 'update' || kind === 'delete') {
        return await this.#queryWrite(query);
      }
      // tx/unknown: a no-op empty result keeps the engine happy for
      // statements like SET / phantom queries.
      return emptyResult();
    } catch (err) {
      throw this.#translate(err);
    }
  }

  async executeRaw(query: SqlQuery): Promise<number> {
    const kind = classify(query.sql);
    try {
      if (kind === 'insert' || kind === 'update' || kind === 'delete') {
        const outcome = await executeWrite(this.#writeContext(), query);
        return outcome.affected;
      }
      if (kind === 'read') {
        // executeRaw on a SELECT: run it, report row count.
        const res = await executeRead(this.deps, query);
        return res.rows.length;
      }
      // tx/unknown statements (SET, BEGIN handled elsewhere): 0 affected.
      return 0;
    } catch (err) {
      throw this.#translate(err);
    }
  }

  /**
   * Execute a write that came through queryRaw because it carried a RETURNING
   * clause. We perform the write and return the affected row(s) projected to
   * the RETURNING columns, so Prisma sees the row it expects (a write with
   * RETURNING that returns 0 rows is read by Prisma as "no record found").
   */
  async #queryWrite(query: SqlQuery): Promise<SqlResultSet> {
    const outcome = await executeWrite(this.#writeContext(), query);
    if (outcome.rows.length === 0) {
      return emptyResult();
    }
    // Project each written payload to the RETURNING columns (or all keys when
    // no explicit RETURNING list). RETURNING names are bare (schema/table
    // qualifiers stripped by the parser).
    const columns =
      outcome.returning.length > 0
        ? outcome.returning
        : Object.keys(outcome.rows[0]!);
    const projected = outcome.rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const col of columns) out[col] = col in row ? row[col] : null;
      return out;
    });
    return toSqlResultSet(columns, projected);
  }

  #writeContext(): WriteContext {
    return {
      client: this.deps.client,
      cfg: this.deps.cfg,
      nameMap: this.deps.nameMap,
      scopeKeyOf: this.deps.scopeKeyOf,
      author: this.deps.author,
    };
  }

  /**
   * Normalize errors at the adapter boundary. We deliberately do NOT wrap
   * everything in DriverAdapterError: the Prisma engine surfaces a thrown
   * Error's message to the user, and our errors (UnsupportedOperationError,
   * RainDBError) already carry clear, actionable messages. Wrapping them in
   * a GenericJs DriverAdapterError would require registering them in the
   * error registry and would hide the message. So we pass real Errors
   * through unchanged and only coerce non-Error throws.
   */
  #translate(err: unknown): Error {
    if (err instanceof DriverAdapterError) return err;
    if (err instanceof UnsupportedOperationError) {
      this.deps.cfg.logger.warn('raindb.adapter: unsupported operation', {
        feature: err.feature,
        message: err.message,
      });
      return err;
    }
    if (err instanceof RainDBError) {
      this.deps.cfg.logger.error('raindb.adapter: error', { message: err.message });
      const mapped = mapRainDBError(err.message);
      if (mapped) {
        return new DriverAdapterError(mapped);
      }
      return err;
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

class RainDBTransaction extends RainDBQueryable implements Transaction {
  readonly options: TransactionOptions;

  constructor(deps: AdapterDeps, options: TransactionOptions) {
    super(deps);
    this.options = options;
  }

  commit(): Promise<void> {
    // Pass-through: statements were applied as they arrived. Nothing to flush.
    this.deps.cfg.logger.debug('raindb.tx: commit (pass-through)');
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    // RainDB cannot roll back already-appended droplets. Surface a warning so
    // the limitation is visible; the engine treats this as a completed
    // rollback so the client doesn't hang.
    this.deps.cfg.logger.warn(
      'raindb.tx: rollback requested but RainDB writes are immutable; ' +
        'already-applied droplet writes are NOT reverted (see README "Transactions")',
    );
    return Promise.resolve();
  }
}

export class PrismaRainDBAdapter extends RainDBQueryable implements SqlDriverAdapter {
  executeScript(_script: string): Promise<void> {
    // Multi-statement scripts (used by Migrate) have no RainDB analog: schema
    // changes are formation publishes, not DDL scripts. Reject clearly.
    return Promise.reject(
      new UnsupportedOperationError(
        'migrate.script',
        'executeScript (raw multi-statement DDL) is not supported. RainDB ' +
          'schema changes are formation publishes; use the @raindb/prisma ' +
          'generator + formation publish flow instead of prisma migrate.',
      ),
    );
  }

  startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    if (
      isolationLevel &&
      isolationLevel !== 'READ COMMITTED' &&
      isolationLevel !== 'SERIALIZABLE'
    ) {
      this.deps.cfg.logger.warn('raindb.tx: isolation level ignored', { isolationLevel });
    }
    const options: TransactionOptions = { usePhantomQuery: false };
    return Promise.resolve(new RainDBTransaction(this.deps, options));
  }

  getConnectionInfo(): { supportsRelationJoins: boolean } {
    // RainDB Periscope supports relation joins in the SQL plane, but Prisma's
    // default relation strategy (query-per-relation + in-JS stitch) is a
    // better fit for the resolution-plane access pattern. Report false so the
    // engine prefers separate queries it can route to id-grabs.
    return { supportsRelationJoins: false };
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

function emptyResult(): SqlResultSet {
  return { columnNames: [], columnTypes: [], rows: [] };
}
