# Deploying a Prisma-on-RainDB Lightning Bolt

This guide explains how to build and deploy a Lightning Bolt that runs the
Prisma ORM against RainDB. A Bolt is a single deployable unit -- it serves
your app (SPA + API) and is the secure backend; you do not run a separate
server.

There are three deployment postures:

| Posture | Where PrismaClient runs | Authentication |
|------|-------------------------|-------------|
| **Direct server (Node)** | your backend's native Node runtime | pass `endpoint` and an `rdb_*` `apiKey`; backend only |
| **Browser + bolt gateway** | the user's browser; the bolt serves the SPA and proxies GraphQL | omit `apiKey`; carry a session credential that the bolt validates before injecting the real key |
| **In-bolt server (Node pod)** | full native Node runtime inside a warm pod | declare `"engine": "nodejs-20"` in `deployment.json`; read the key from bolt secrets |

All use `@raindb/prisma-adapter`. In all three, `schema.prisma` must use:

```prisma
datasource db {
  provider = "postgres"
}
```

The adapter presents provider `postgres` so Prisma compiles Postgres-dialect
SQL. Schema changes are RainDB formation publishes, not `prisma migrate`.
For direct Node usage, construct `new PrismaRainDB({ endpoint, apiKey })`
and pass it to `new PrismaClient({ adapter })` as in the README.

---

## 1. Bolt anatomy

A Bolt is a directory with:

```
my-bolt/
  server/index.js        # the bolt handler: exports onHttpRequest(ctx, req)
  client/dist/           # pre-built SPA (optional; server-only bolts omit it)
  capabilities.json      # what RainDB surface the bolt may touch
  routes.json            # static serving + /api/* route table
  deployment.json        # engine selection, mount, healthcheck, CORS
  .secrets/secrets.json  # secret values (local only; staged at first deploy)
```

The default **goja** engine is a pure-Go JavaScript interpreter without
WASM support. It can serve a browser app and its GraphQL gateway. To run
PrismaClient inside the bolt, select the **Node pod engine** instead. The
CLI builds pod-engine bundles for Node (default target `node20`).

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
    "sqlRead": true
  },
  "network": {
    "egress": ["localhost", "127.0.0.1", "raindb.io", "api.raindb.io"]
  },
  "limits": { "memMb": 1024 }
}
```

| Field | Meaning |
|-------|---------|
| `raindb.formations[]` | per-formation `read`/`write`/`list` grants the bolt's `ctx.db`/`ctx.sql` may touch |
| `raindb.secrets.names[]` | the secret keys the bolt may read via `ctx.secrets.get(name)` |
| `raindb.sqlRead` | opt-in for `ctx.sql.query` against the Periscope analytical plane |
| `network.egress[]` | hosts the bolt's `ctx.fetch` may reach |
| `limits.memMb` | requested memory budget; allow roughly 1024 MB for Prisma in a Node pod, subject to platform and tenant policy |

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

`deployment.json` selects the runtime and carries the mount + healthcheck.
For server-side Prisma use:

```json
{
  "engine": "nodejs-20",
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
  --deployment ./deployment.json \
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
| `--engine` | explicit runtime override; otherwise read `engine` from `--deployment`, defaulting to `goja` |

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

The browser bundle must include Prisma's WASM query compiler and support
its WASM imports. The proven browser setup used the `edge-light` client,
`vite-plugin-wasm`, `vite-plugin-top-level-await`, and handling for Prisma's
`?module` WASM import. WASM executes in the browser in this posture.
For cookie sessions, pass `credentials: 'same-origin'` (or `'include'` for
an appropriately configured cross-origin gateway). The gateway must validate
the session before forwarding; never ship the `rdb_*` key to the browser.

---

## 7. In-bolt server-side mode: Node pod engine

Set `"engine": "nodejs-20"` in `deployment.json` and pass
`--deployment ./deployment.json` on deploys, including republishes.
An explicit `--engine` overrides that file. The CLI selects a Node build
for the pod engine; package the generated Prisma client and its WASM assets
with the server bundle.

A pod runs a full native Node runtime, including native WASM support for
Prisma's query compiler. Keep the RainDB key in declared bolt secrets and
construct the adapter server-side using those secret values.
Initialize PrismaClient once at pod startup or lazily on the first request,
then reuse that instance across requests while the pod is warm.

The pod boots once and stays warm across requests. The seeded engine policy
uses a **300-second idle TTL** (about five minutes), reset on invocation;
idle expiry tears down the pod, and the next request boots a fresh one.
It also has a one-hour maximum lifetime. Tenant policy can shorten these
lifetimes, so do not rely on process memory for durable state.

The seeded Node engine provides **1024 MB memory headroom** for Prisma.
Size the bolt's requested memory accordingly; actual resource allocation
is governed by platform and tenant policy. This replaces the old guide's
incorrect 256 MB server-side recommendation.

---

## 8. Verify

```bash
curl https://<domain>/api/health        # bolt health
raindb-cli --profile <profile> lightning bolt list   # deployed bolts + domains
```

The bolt's autogen domain is returned on first deploy; the custom domain is
live once DNS propagates (seconds to a minute).
