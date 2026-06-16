/**
 * Map RainDB error messages to Prisma MappedError kinds.
 *
 * When a RainDB write fails (conflict, validation, missing formation), the
 * adapter surfaces it to the Prisma engine as a typed driver error so the
 * client receives the correct PrismaClientKnownRequestError (e.g. P2002 for
 * a unique/CAS conflict) instead of an opaque message.
 *
 * The RainDB error strings are stable; we match on their distinctive
 * phrasing. We declare provider 'postgres', so the engine understands the
 * standard constraint-violation kinds. Mappings:
 *   - "concurrent update detected" / "token condition failed" /
 *     "token already exists" / "idempotency conflict" -> unique violation
 *   - "validation failed for formation" / "author field is required" ->
 *     invalid input
 *   - "formation not found"                           -> table missing
 */
import type { MappedError } from '@prisma/driver-adapter-utils';

export function mapRainDBError(message: string): MappedError | null {
  const m = message.toLowerCase();

  // CAS / create-only / idempotency conflicts -> unique constraint violation
  // (Prisma raises P2002).
  if (
    m.includes('concurrent update detected') ||
    m.includes('token condition failed') ||
    m.includes('token already exists') ||
    m.includes('idempotency conflict')
  ) {
    return { kind: 'UniqueConstraintViolation' };
  }

  // Unknown formation -> the relational analog is a missing table.
  if (m.includes('formation not found')) {
    return { kind: 'TableDoesNotExist' };
  }

  // Auth-level failures.
  if (m.includes('http 401') || m.includes('unauthenticated') || m.includes('unauthorized')) {
    return { kind: 'AuthenticationFailed' };
  }

  // Transport timeout.
  if (m.includes('timed out') || m.includes('timeout')) {
    return { kind: 'SocketTimeout' };
  }

  // Schema validation / required-field rejections, expired tokens: surface as
  // an invalid-input error carrying the RainDB message.
  if (
    m.includes('validation failed for formation') ||
    m.includes('author field is required') ||
    m.includes('tenant id is required') ||
    m.includes('token expired')
  ) {
    return { kind: 'InvalidInputValue', message };
  }

  return null;
}
