/**
 * Adapter error types.
 *
 * These wrap RainDB transport/protocol failures. The driver-adapter layer
 * translates them into Prisma's `DriverAdapterError` shape at the boundary
 * (see src/adapter.ts), so application code catches standard Prisma errors.
 */

export interface RainDBErrorOptions {
  cause?: unknown;
  status?: number;
  extensions?: Record<string, unknown>;
}

/** Base error for anything originating from the RainDB transport. */
export class RainDBError extends Error {
  readonly status?: number;
  readonly extensions?: Record<string, unknown>;

  constructor(message: string, options: RainDBErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'RainDBError';
    if (options.status !== undefined) this.status = options.status;
    if (options.extensions !== undefined) this.extensions = options.extensions;
  }
}

/** A read targeted a key/entity that does not exist. */
export class RainDBNotFoundError extends RainDBError {
  constructor(message = 'not found') {
    super(message);
    this.name = 'RainDBNotFoundError';
  }
}

/**
 * The adapter was asked to do something RainDB's data model does not
 * support (e.g. a multi-formation transaction with rollback, or a SQL
 * write that cannot be mapped to a droplet operation). Carries a stable
 * `feature` tag so callers can branch.
 */
export class UnsupportedOperationError extends RainDBError {
  readonly feature: string;

  constructor(feature: string, message: string) {
    super(message);
    this.name = 'UnsupportedOperationError';
    this.feature = feature;
  }
}
