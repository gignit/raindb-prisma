/**
 * PrismaRainDB -- the driver adapter factory.
 *
 * This is the object an application hands to PrismaClient:
 *
 *   import { PrismaRainDB } from '@raindb/prisma-adapter';
 *   const adapter = new PrismaRainDB({ endpoint, apiKey });
 *   const prisma = new PrismaClient({ adapter });
 *
 * It implements SqlDriverAdapterFactory: PrismaClient calls `connect()` to
 * obtain the live adapter.
 */
import type {
  SqlDriverAdapter,
  SqlDriverAdapterFactory,
} from '@prisma/driver-adapter-utils';

import { resolveConfig, type RainDBAdapterConfig } from './config.js';
import { RainDBClient } from './raindb/client.js';
import { PrismaRainDBAdapter, type AdapterDeps } from './adapter.js';
import {
  emptyNameMap,
  nameMapFromFormations,
  type FormationNameMap,
} from './sql/identifiers.js';

const PROVIDER = 'postgres' as const;
const ADAPTER_NAME = '@raindb/prisma-adapter';

/**
 * Per-model metadata the adapter needs to translate SQL to droplet ops.
 * The @raindb/prisma generator emits this from schema.prisma; it can also be
 * supplied by hand for simple cases.
 */
export interface RainDBModelMap {
  /** All formation ids (model -> formation). Drives table<->formation naming. */
  formations: string[];
  /**
   * formation id -> scope key (the payload field that is the @id). When a
   * formation is absent, the adapter falls back to 'id'.
   */
  scopeKeys?: Record<string, string>;
}

export interface PrismaRainDBOptions extends RainDBAdapterConfig {
  /**
   * Model/formation metadata. Strongly recommended (lets the adapter resolve
   * hyphenated formation names and per-model scope keys). When omitted, the
   * adapter assumes table name == formation id and scope key == 'id'.
   */
  models?: RainDBModelMap;
  /**
   * Author stamped on every write (writes require an author). Typically the
   * authenticated user id; defaults to the adapter's own marker.
   */
  author?: string;
}

export class PrismaRainDB implements SqlDriverAdapterFactory {
  readonly provider = PROVIDER;
  readonly adapterName = ADAPTER_NAME;

  readonly #deps: AdapterDeps;

  constructor(options: PrismaRainDBOptions) {
    const cfg = resolveConfig(options);
    const client = new RainDBClient(cfg);

    const nameMap: FormationNameMap = options.models
      ? nameMapFromFormations(options.models.formations)
      : emptyNameMap();

    const scopeKeys = options.models?.scopeKeys ?? {};
    const scopeKeyOf = (formationId: string): string => scopeKeys[formationId] ?? 'id';

    this.#deps = {
      client,
      cfg,
      nameMap,
      scopeKeyOf,
      author: options.author ?? 'raindb-prisma-adapter',
    };
  }

  connect(): Promise<SqlDriverAdapter> {
    return Promise.resolve(new PrismaRainDBAdapter(this.#deps));
  }
}
