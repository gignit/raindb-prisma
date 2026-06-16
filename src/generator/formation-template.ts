/**
 * Formation config emitter -- the single source of truth for producing a
 * RainDB formation that ACTUALLY SNAPSHOTS into Periscope.
 *
 * This shape is modeled on a production RainDB formation that is known to
 * snapshot correctly (verified live via describeFormation).
 *
 * MENTAL MODEL -- ONE TABLE, NOT A PIPELINE OF TABLES. A formation's
 * Periscope data is a SINGLE logical table (`entity."<formation>"`). The
 * moment a snapshot lands in ANY pool/tier it becomes part of that one giant
 * table. `stream`/`river`/`lake` are just DEFAULT tier names -- they could be
 * named anything, and there could be 2 tiers or 100. Tiers are purely a
 * rollup/compaction strategy (consolidating many small datasets into fewer
 * larger ones over time); they do NOT partition the queryable surface. The
 * adapter always queries the single unified `entity."<formation>"` view and
 * never a specific tier.
 *
 * The load-bearing chain that makes data queryable by SQL is:
 *
 *   1. a `by-update` pointer index keyed by {{.dropletId}} WITH descIndex
 *      enabled (the droplet-sourced tier reads droplets through it);
 *   2. an `actions: [{ action: "periscope-pool", trigger: "onDroplet",
 *      metadata: { tier: "<entry-tier>" }}]` entry (fires pooling on write);
 *   3. AT LEAST ONE tier whose source is { type: "droplets", index:
 *      "by-update" } -- this is the tier droplets actually enter through.
 *      Additional tiers that roll up { type: "tier", tier: "<lower>" } are
 *      OPTIONAL compaction conveniences.
 *   4. tierPolicy.catalog.location + partition + expiration;
 *   5. views.defaultBehavior.dedup = true + queryDefaults.autoPool = true.
 *
 * Items 1-3 are mandatory: miss any and droplets never snapshot, so every
 * findMany stays empty. The default below uses the conventional 3-tier
 * stream/river/lake rollup; that count is a choice, not a requirement.
 *
 * IMPORTANT -- the tier `trigger.next` field is NOT a cron scheduler.
 * RainDB actions are EVENT-DRIVEN: a pool only happens when new droplets
 * arrive in the formation. The cron-looking `next` string only defines the
 * WINDOW/cadence at which an already-triggered pool fires -- i.e. "IF new
 * data came in, pool it at the next window boundary on this schedule". A
 * formation with no writes never pools, no matter the schedule. A
 * five-minute window expression means "batch new arrivals into a pool at
 * most every ~5 min", not "run every 5 min unconditionally". This is also
 * why a brand-new, never-written formation legitimately has no snapshot yet
 * (the adapter maps that to an empty result -- see src/read/execute-read.ts).
 */

export interface FormationTemplateOptions {
  /** RainDB formation id (e.g. "blog-post"). */
  formationId: string;
  /** Payload field that is the primary key (Prisma @id). */
  scopeKey: string;
  /** Auto-generate the scope value when the caller omits it. */
  autoGenId: boolean;
  /** Schema version (publish increments this on compatible change). */
  schemaVersion: number;
}

/** Build the complete, snapshot-capable formation config object. */
export function buildFormationConfig(
  opts: FormationTemplateOptions,
): Record<string, unknown> {
  const { formationId: fid, scopeKey, autoGenId, schemaVersion } = opts;
  const t = (p: string) => `tenants/{{.tenantId}}/${p}`;

  return {
    configVersion: 1,
    formationId: fid,
    // Entity path partitioned by date; keyed by dropletId so each write is a
    // distinct immutable object.
    pathTemplate: t(
      `entities/${fid}/{{.${scopeKey}}}/{{.yyyy}}/{{.mm}}/{{.dd}}/{{.dropletId}}.json`,
    ),
    scopeKey,
    autoGenId,
    minSchemaVersion: schemaVersion,
    maxSchemaVersion: schemaVersion,
    compatibleSchemas: [`v${schemaVersion}`],

    indexes: [
      // (1) by-id pointer: powers readCurrent/readLatest (the resolution
      // plane). The adapter routes findUnique-by-id here.
      {
        name: 'by-id-latest',
        type: 'pointer',
        strategy: 'write',
        template: t(`indexes/${fid}/by-id/{{.${scopeKey}}}/latest.json`),
      },
      // (2) by-update pointer WITH descIndex: the stream tier's droplet
      // source. Keyed by dropletId (chronological via UUIDv7). REQUIRED for
      // snapshotting + the freshness bookmark + newest-first reads.
      {
        name: 'by-update',
        type: 'pointer',
        strategy: 'write',
        template: t(`indexes/${fid}/by-update/{{.dropletId}}/latest.json`),
        descIndex: {
          enabled: true,
          entryTemplate: t(`indexes/${fid}/by-update.desc/{{.dropletId}}/meta.json`),
          latestPointerTemplate: t(`indexes/${fid}/by-update.desc/latest.json`),
          setsTemplate: t(`indexes/${fid}/by-update.sets/{{.setId}}/meta.json`),
        },
      },
    ],

    // (3) The pool action: fires the cascade on every droplet write. Without
    // this, the tierPolicy exists but is never triggered -> no snapshots.
    actions: [
      {
        action: 'periscope-pool',
        trigger: 'onDroplet',
        metadata: { tier: 'stream' },
      },
    ],

    queryConfig: {
      enabled: true,
      flattenDepth: 1,
      defaultLimit: 100,
      maxLimit: 1000,
    },

    // (4) The default 3-tier rollup. This is ONE logical table; the tiers
    // only control compaction (stream = freshest/smallest pools, rolled up
    // into river, then lake). The mandatory link is the droplet-sourced tier
    // (stream below: source { type: "droplets", index: "by-update" }); river
    // and lake are optional rollups of the tier below. The `trigger.next`
    // window is event-driven (fires only when new data arrived in that tier's
    // source), NOT a standalone cron timer -- see the file header.
    tierPolicy: {
      tiers: {
        stream: {
          enabled: true,
          source: { type: 'droplets', index: 'by-update' },
          trigger: { next: '*/5 * * * *', tz: 'UTC', operator: 'OR' },
          path: t(`periscope/{{.formationId}}/stream/{{.yyyy}}/{{.mm}}/{{.dd}}/{{.poolId}}.parquet`),
          retainInputs: true,
          retention: { afterSupersession: '30d' },
        },
        river: {
          enabled: true,
          source: { type: 'tier', tier: 'stream' },
          trigger: { next: '*/30 * * * *', tz: 'UTC', operator: 'OR' },
          path: t(`periscope/{{.formationId}}/river/{{.yyyy}}/{{.mm}}/{{.dd}}/{{.poolId}}.parquet`),
          retainInputs: false,
          retention: { afterSupersession: '90d' },
        },
        lake: {
          enabled: true,
          source: { type: 'tier', tier: 'river' },
          trigger: { next: '0 */6 * * *', tz: 'UTC', operator: 'OR' },
          path: t(`periscope/{{.formationId}}/lake/{{.yyyy}}/{{.poolId}}.parquet`),
          retainInputs: false,
          retention: { afterSupersession: '365d' },
        },
      },
      partition: { strategy: 'formation' },
      catalog: { location: t(`periscope/{{.formationId}}/catalog`) },
      expiration: { schedule: 'daily', snapshotRetention: '30d' },
    },

    // (5) Dedup so a plain SELECT returns one row per entity; autoPool so a
    // stale-tier query triggers a sync pool before running.
    views: {
      defaultBehavior: { dedup: true },
      queryDefaults: { autoPool: true, window: '10s' },
    },
  };
}
