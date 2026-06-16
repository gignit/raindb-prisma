# Deploying a Prisma-on-RainDB Lightning Bolt

This guide explains how to build and deploy a Lightning Bolt that runs the
Prisma ORM against RainDB. A Bolt is a single deployable unit -- it serves
your app (SPA + API) and is the secure backend; you do not run a separate
server.

There are two ways the real `PrismaClient` runs, depending on where the
WebAssembly query engine executes:

| Mode | Where PrismaClient runs | When to use |
|------|-------------------------|-------------|
| **Browser** | the user's browser (the Bolt serves the SPA + acts as the auth/GraphQL gateway) | browser-facing apps; the Bolt holds the RainDB key, the browser never sees it |
| **In-Bolt (server-side)** | inside the Bolt's goja engine, via the WebAssembly host surface (`raindb.wasm` capability) | server-side logic, headless/cron bolts, lowest latency (no browser round-trip) |

Both use the same `@raindb/prisma-adapter`. This guide covers both.

---

## 1. Bolt anatomy

A Bolt is a directory with:

```
my-bolt/
  server/index.js        # the bolt handler: exports onHttpRequest(ctx, req)
  client/dist/           # pre-built SPA (optional; server-only bolts omit it)
  capabilities.json      # what RainDB surface the bolt may touch
  routes.json            # static serving + /api/* route table
  deployment.json        # mount, healthcheck, CORS
  .secrets/secrets.json  # secret values (local only; staged at first deploy)
```

The handler runs on the **goja** engine (a pure-Go JS interpreter). Your
TypeScript/JS is esbuild-bundled at publish time. The handler is `async`;
`ctx` exposes the substrate (`ctx.fetch`, `ctx.secrets`, `ctx.jwt`,
`ctx.db`, `ctx.sql`, `ctx.crypto`, ...).

---

## 2. capabilities.json -- least-privilege opt-in

A Bolt only gets the substrate surface it declares. Nothing is granted by
default.

```json
{
  "raindb": {
    "formations": [
      { "id": "my-model", "ops": ["read", "write", "list"] }
    ],
    "secrets": { "names": ["raindb_url", "raindb_api_key", "app_password", "session_secret"] },
    "sqlRead": true,
    "wasm": true
  },
  "network": {
    "egress": ["localhost", "127.0.0.1", "raindb.io", "api.raindb.io"]
  },
  "limits": { "memMb": 256 }
}
```

| Field | Meaning |
|-------|---------|
| `raindb.formations[]` | per-formation `read`/`write`/`list` grants the bolt's `ctx.db`/`ctx.sql` may touch |
| `raindb.secrets.names[]` | the secret keys the bolt may read via `ctx.secrets.get(name)` |
| `raindb.sqlRead` | opt-in for `ctx.sql.query` against the Periscope analytical plane |
| `raindb.wasm` | **opt-in for the WebAssembly host surface** (in-Bolt PrismaClient). When true and the bundle includes a `.wasm` asset, the engine compiles it once and installs a `WebAssembly` global on every sandbox. Omit it for the browser-mode pattern. |
| `network.egress[]` | hosts the bolt's `ctx.fetch` may reach |
| `limits.memMb` | per-invocation memory ceiling (raise to ~256 for the in-Bolt WASM path -- the query engine needs headroom) |

---

## 3. The secure auth model (never put the RainDB key in the browser)

The RainDB tenant key lives **only** in the Bolt's secrets. Browser-mode
bolts authenticate the app and mint a short-lived session the browser
carries; the Bolt validates it and injects the real key server-side.

```
POST /api/login { password }
  -> bolt: verify against the app_password secret (ctx.crypto.verifyPassword
     for hashed, or a direct compare for a shared gate)
  -> bolt: ctx.jwt.sign(session_secret, { sub, scope }, ttlSec)  -> token
  -> browser stores the token

browser PrismaClient -> POST /graphql  (Authorization: Bearer <session token>)
  -> bolt: ctx.jwt.verify(session_secret, token)   [reject if invalid]
  -> bolt: inject Authorization: Bearer <raindb_api_key>, forward to RainDB
  -> return the GraphQL response
```

`ctx.jwt.sign` / `ctx.jwt.verify` take the **secret name** (declared in
`capabilities.raindb.secrets.names`), not the value -- the substrate
resolves it.

---

## 4. routes.json

```json
{
  "block": [
    { "path": "/.env",   "status": 404 },
    { "path": "/.git/*", "status": 404 }
  ],
  "static": [
    { "path": "/assets/*", "publicAsset": "assets/" },
    { "path": "/*",        "publicAsset": "index.html" }
  ],
  "routes": [
    { "method": "POST", "path": "/api/login", "handler": "onHttpRequest" },
    { "method": "POST", "path": "/graphql",   "handler": "onHttpRequest" },
    { "method": "GET",  "path": "/api/health", "handler": "onHttpRequest" }
  ]
}
```

- `block[]` -- hard 404s for sensitive paths.
- `static[]` -- SPA asset serving; `/*` falls back to `index.html` for client routing.
- `routes[]` -- dynamic routes dispatched to the named handler export.

`deployment.json` carries the mount + healthcheck:

```json
{
  "preferredMount": "/",
  "healthcheckPath": "/api/health",
  "websocket": false,
  "corsAllowedOrigins": []
}
```

---

## 5. Deploy

Deploy with the `raindb-cli lightning bolt deploy` command. The first deploy
sends everything (source, capabilities, routes, deployment, client dist,
secrets); subsequent deploys re-send capabilities + routes so config never
drifts from the repo.

```bash
# First-time / full deploy
raindb-cli --profile <profile> lightning bolt deploy <bolt-name> \
  --name <bolt-name> \
  --source . \
  --entry server/index.js \
  --client-dist client/dist \
  --capabilities ./capabilities.json \
  --deployment ./deployment.json \
  --routes ./routes.json \
  --from-secrets ./.secrets/secrets.json \
  --domain <custom-domain>

# Republish (code/config change)
raindb-cli --profile <profile> lightning bolt deploy <bolt-name> \
  --domain <custom-domain> \
  --capabilities ./capabilities.json \
  --routes ./routes.json
```

Key flags (verified against `cmd/raindb-cli/lightning.go`):

| Flag | Purpose |
|------|---------|
| `--name` | bolt name (required for a new bolt) |
| `--source` | directory to build (esbuild + zip); auto-discovered if omitted |
| `--entry` | server entry relative to `--source` (auto-detected: `server/index.{ts,js}`) |
| `--client-dist` | pre-built SPA dir (auto-detected: `client/dist`); omit for server-only |
| `--capabilities` | path to `capabilities.json` |
| `--routes` | path to `routes.json` (or `--auto-routes` for a SPA-friendly default) |
| `--deployment` | path to `deployment.json` |
| `--from-secrets` | path to a JSON object of secret name->value (staged at deploy) |
| `--domain` | custom domain to bind; **pass on EVERY deploy** -- a republish without it reverts the binding |
| `--engine` | runtime engine (default `goja`) |

> **`--domain` is mandatory on every republish.** Omitting it on a
> subsequent deploy reverts the bolt to its autogen domain.

A `deploy.sh` wrapper that pins the profile/name/domain and toggles
first-time vs republish is the recommended convention (see the crexprisma
bolt's `deploy.sh`).

---

## 6. Browser-mode bolt (the common case)

The SPA bundles the real `PrismaClient` (WASM client, `prisma-client`
generator with `runtime = "edge-light"`) + `@raindb/prisma-adapter`. The
adapter points at the bolt's `/graphql` gateway and carries the session
token; the bolt injects the RainDB key.

```ts
// in the SPA
import { PrismaClient } from './generated/prisma/client.js';
import { PrismaRainDB } from '@raindb/prisma-adapter';

const adapter = new PrismaRainDB({
  endpoint: '/graphql',                 // the bolt gateway, same origin
  headers: () => ({ authorization: `Bearer ${sessionToken}` }),
  models: { formations: ['my-model'], scopeKeys: { 'my-model': 'id' } },
});
export const prisma = new PrismaClient({ adapter });
```

Vite needs `vite-plugin-wasm` + `vite-plugin-top-level-await` (and a small
plugin for Prisma's `?module` wasm import) so the WASM client bundles for
the browser. The bolt does NOT need `raindb.wasm` for this mode -- the WASM
runs in the browser, not the bolt.

---

## 7. In-Bolt (server-side) mode -- requires `raindb.wasm`

When you want the full `PrismaClient` to run **inside** the bolt (no browser
involved -- server-side handlers, cron/trigger bolts, lowest latency),
declare the `raindb.wasm` capability and bundle the Prisma WASM module. The
engine compiles it once (cached on the artifact, disposed on idle-evict) and
installs a `WebAssembly` global on each sandbox, so the bundled
PrismaClient's WASM query engine runs in goja.

```json
// capabilities.json
{ "raindb": { "formations": [...], "secrets": {...}, "wasm": true } }
```

The bolt's bundle must include the `.wasm` asset alongside the JS. With
`raindb.wasm` on, `WebAssembly.instantiate` inside the bundle resolves to
the engine's pre-compiled module.

> Capability-gated by design: bolts that don't declare `raindb.wasm` get no
> WebAssembly surface and pay no WASM compile cost. This keeps the ~99% of
> bolts that never touch WASM fast, consistent with RainDB's lazy
> per-tenant engine model.

---

## 8. Verify

```bash
curl https://<domain>/api/health        # bolt health
raindb-cli --profile <profile> lightning bolt list   # deployed bolts + domains
```

The bolt's autogen domain is returned on first deploy; the custom domain is
live once DNS propagates (seconds to a minute).
