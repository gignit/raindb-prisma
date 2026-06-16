/**
 * @raindb/prisma-adapter
 *
 * Prisma driver adapter for RainDB. Run the Prisma ORM against RainDB's
 * S3-native dataplane:
 *
 *   - reads  -> RainDB Periscope (the columnar SQL/analytical plane), with a
 *               freshness drift-merge that gives read-your-writes on lists.
 *   - writes -> immutable droplet appends (INSERT/UPDATE/DELETE translated to
 *               writeDroplet / read-modify-write / soft-delete).
 *
 * Usage:
 *   import { PrismaClient } from '@prisma/client';
 *   import { PrismaRainDB } from '@raindb/prisma-adapter';
 *
 *   const adapter = new PrismaRainDB({
 *     endpoint: process.env.RAINDB_ENDPOINT!,
 *     apiKey:   process.env.RAINDB_API_KEY!,
 *   });
 *   const prisma = new PrismaClient({ adapter });
 */
export { PrismaRainDB } from './factory.js';
export type { PrismaRainDBOptions, RainDBModelMap } from './factory.js';
export type { RainDBAdapterConfig, AdapterLogger } from './config.js';
export {
  RainDBError,
  RainDBNotFoundError,
  UnsupportedOperationError,
} from './errors.js';
