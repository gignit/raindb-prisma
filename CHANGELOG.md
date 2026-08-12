# Changelog

All notable changes to `@raindb/prisma-adapter` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **Drift is read from the server's `freshnessStatus` verdict, not re-derived.**
  `driftMerge` and the `signal`-mode logger previously hand-rolled
  `snapshotDropletId !== currentDropletId`, which missed the cold-current
  guard: when the current side was unobserved (`currentDropletId === ''`) they
  compared `snapshot !== ''` and FALSELY flagged drift, firing a needless
  harvest / logging phantom drift. Both now filter on
  `freshnessStatus === 'BEHIND'` (the server's verdict; `UNKNOWN` is
  undetermined, not drift). Added the `FreshnessStatus` type + the
  `freshnessStatus` field to `RainDBFormationLatest`, and selected it in the
  `executeSQL` query. Regression test covers the cold-current case.

### Added

- Initial RainDB Prisma driver adapter (`PrismaRainDB`), targeting Prisma 7.
- Read path: `queryRaw` -> RainDB Periscope `executeSQL`, with positional
  parameter inlining, column-type inference, and formation-hint extraction.
- Freshness merge: closes read-your-writes on list queries by detecting
  columnar-snapshot drift (via the server's freshness bookmark) and merging
  in the missing newest records. Configurable: `merge` / `signal` / `off`.
- Write path: `executeRaw` -> droplet operations. `INSERT` -> append,
  `UPDATE` -> read-modify-write (immutable new version), `DELETE` ->
  soft-delete. Unbounded or non-equality writes fail explicitly.
- Error mapping: RainDB SDK errors -> typed Prisma errors (e.g. CAS /
  idempotency conflicts -> unique constraint violation `P2002`).
- Honest transaction object: pass-through commit; rollback warns that
  RainDB's immutable writes are not reverted.
- RainDB GraphQL transport (`executeSQL`, `readLatest`, `writeDroplet`,
  `listKeys`) over `Authorization: Bearer`.
- Unit tests (SQL classification, write parsing, identifiers, parameter
  inlining) and live integration tests gated behind `RAINDB_ENDPOINT` /
  `RAINDB_API_KEY`.

### Notes

- RainDB Periscope table-name rule: a hyphen in a formation id maps to a
  **double underscore** in the SQL view name (`my-entity` ->
  `entity."my__entity"`). The adapter applies this in both directions.
