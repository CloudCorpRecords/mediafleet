# mediafleet — Build Report

Tranche Batch 3, MCP Rebuild 100 program. Clean-room rebuild of
dinglebear-ai/yarr (rank 66, 16 stars), built from its public README
tool spec retrieved firsthand 2026-10-26. The original exposes ONE
tool; this rebuild implements that documented core in full (no subset
omission). Local build only — nothing pushed or published.

Identity: repo `mediafleet`, npm `@reneturcios/mediafleet`, MCP name
`io.github.CloudCorpRecords/mediafleet`, version `0.1.0`.
Build dir: `~/workspace/mcp-rebuild-100/builds/mediafleet/`

## Files created (19/19 per TEMPLATE.md checklist)

- `package.json` — bin `mediafleet: dist/cli.js`, `mcpName` set,
  scripts build=`tsc` / dev=`tsx src/cli.ts` / test=`tsx --test test/*.test.ts`
- `server.json` — description "Run JavaScript in a sandbox to
  orchestrate Sonarr, Radarr, Plex and other media services." =
  **89 chars** (≤100 ✓, counted programmatically); npm entry carries
  `version: 0.1.0`; OCI entry `ghcr.io/cloudcorprecords/mediafleet:0.1.0`
  carries **no** `version` field (verified programmatically)
- `Dockerfile` — node:20-alpine two-stage, ENTRYPOINT
  `node /app/dist/cli.js`, CMD `mcp`, label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/mediafleet"`
- `tsconfig.json` (318 bytes, fleet-identical), `.gitignore`,
  `package-lock.json` (see Lockfile), `LICENSE` (MIT, Copyright (c)
  2026 Rene Turcios), `README.md` (fresh text), `CHANGELOG.md`
  (single 0.1.0 entry, 2026-10-26)
- `src/index.ts`, `src/cli.ts` (`yarr` subcommand taking a JSON
  argument object, plus `mcp` and `--version`; unknown command exits
  2), `src/mcp.ts`, `src/types.ts`, `src/mediafleet.ts` (core,
  `VERSION = "0.1.0"`)
- `test/mediafleet.test.ts`
- `.github/workflows/{ci,publish,publish-container,registry-publish}.yml`
  (fleet mechanics; image/server name set to mediafleet)

## Fixture first

`~/workspace/mcp-rebuild-100/harness/fixtures/yarr-tools-original.json`
was written before the build, with `_source` labelled **docs-derived**:
the 1 documented tool from the dinglebear-ai/yarr README — `yarr`
with a single required string input `code` — plus the documented
sandbox surface and env configuration in prose. The README names the
tool and its parameter but publishes no wire schema, so the schema is
a documented-parameter reconstruction. Parity is against this fixture
only.

## Implementation notes

- `src/mcp.ts` uses the SDK's low-level `Server` with an explicit
  schema literal exactly as in the fixture (NOT `McpServer` + zod),
  so `tools/list` matches the spec exactly; zod still validates every
  `tools/call` argument set.
- Execution: the `code` string is compiled with `node:vm`
  (`new vm.Script("(<code>)")`), must evaluate to a function, and is
  awaited under a timeout (default 15000 ms, injectable). The vm
  context's globals are exactly the documented surface — per-service
  callables, `api`, `callTool`, `codemode`, `writeArtifact`, a
  capturing `console`, and `input` — with no `process` or `require`
  (a test asserts both are `undefined` inside). Only configured
  services are present; unconfigured names are `undefined`.
- Per-service callables: calling one performs a GET; `.get/.post/
  .put/.delete(path, body)` and `.status()` are attached. `.status()`
  and `callTool("service_status")` probe a per-service status-path
  table (`STATUS_PATHS`, e.g. sonarr/radarr `/api/v3/system/status`,
  plex `/identity`, jellyfin `/System/Info/Public`) and report
  `{service, ok, status|error}` per service, isolating failures.
- Every service call funnels through one injectable executor
  `(service, method, path, body)`. The default executor fetches
  `{baseUrl}{path}` with `X-Api-Key` (`X-Plex-Token` for Plex), a JSON
  body for non-GET calls, JSON-or-text response parsing, and a
  descriptive error on non-2xx. Its fetch is itself injectable.
- `callTool` dispatches all 12 documented actions: generic
  `service_status`, `api_get`, `api_post`, `api_put`, `api_delete`,
  `help`; codemode `codemode` (`{code}` runs nested code, otherwise a
  summary), `op` (one of `{path}` describe / `{name}` snippet run /
  `{code}` run), `snippet_list`, `snippet_save`, `snippet_run`,
  `snippet_delete`. `codemode.search/describe` read a catalogue built
  from the configured services plus the actions and helpers.
- Snippets and artifacts are per-process in-memory maps; the default
  deps use module-level singleton stores so snippets persist across
  tool calls for the life of the process. `writeArtifact` content and
  captured console lines from a run are returned in that run's
  outcome `{result, artifacts, logs}`; nested runs (snippet/codemode)
  share the outer run's artifact store and log capture.
- Configuration: `parseServicesFromEnv` reads `YARR_SERVICES`
  (comma list; unknown names ignored); when absent, any service with
  `YARR_<SERVICE>_URL` set counts as configured. Credentials come from
  `YARR_<SERVICE>_API_KEY`, except Plex, which reads
  `YARR_PLEX_TOKEN` (falling back to `YARR_PLEX_API_KEY`).
- **Destructive actions are NOT specially gated in this core**,
  matching the assigned spec: a DELETE (or any other verb) issued by
  the sandboxed code, via a callable, `api.*` or `callTool`, is
  executed like any other call. Any gating belongs to a layer above
  this rebuild.

## Verification (exact foreground outputs)

### 1. Build
```
$ ./node_modules/.bin/tsc && echo TSC_OK
TSC_OK (exit 0; dist/ produced: cli, index, mcp, mediafleet, types)
```
One type error was found and fixed during the build (the service
callable passed a body to `api.get`; the `ApiSurface.get` signature
was widened to accept an optional body) — the run above is the clean
re-run after the fix.

### 2. Tests (fake executor and fake fetch only, no network)
```
$ ./node_modules/.bin/tsx --test test/*.test.ts
tests 17 / pass 17 / fail 0
```
Covers: env parsing (explicit list with the Plex token, URL-based
inference, unknown names ignored, trailing-slash trimming); the
default executor (URL joining, `X-Api-Key`, `X-Plex-Token` for Plex,
JSON POST body, text fallback, HTTP-401 and unconfigured-service
errors); sandbox shape (only configured services defined, no
`process`/`require`); api verbs and per-service callables recording
GET/POST/PUT/DELETE through the executor; console capture and
`writeArtifact`; `.status()` probing; `service_status` isolating a
failing service; `api_post/put/delete` routing and the unconfigured
service error; `help` and unknown-action errors; the full snippet
lifecycle via `callTool`; `codemode.snippets/run`, `op` dispatch and
nested `codemode` execution; `codemode.search/describe`; and
validation (non-function code, empty code, unknown tool, a
never-settling run timing out at 100 ms).

### 3. Parity
```
$ python3 ~/workspace/mcp-rebuild-100/harness/parity.py \
    --original ~/workspace/mcp-rebuild-100/harness/fixtures/yarr-tools-original.json \
    --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/mediafleet/dist/cli.js mcp" \
    --out ~/workspace/mcp-rebuild-100/builds/mediafleet/parity-out
verdict=PASS parity_pct=100.0 original_tools=1 rebuild_tools=1 missing=[] extra=[] schema_diffs=[]
(exit 0)
```

### 4. Honest check (real CLI, no live services)
```
$ node dist/cli.js --version
0.1.0

$ YARR_SERVICES=sonarr YARR_SONARR_URL=http://127.0.0.1:9 \
  node dist/cli.js yarr '{"code":"async () => { await callTool(\"snippet_save\", {name: \"one\", code: \"async () => 1\"}); const v = await codemode.run(\"one\"); const h = await callTool(\"help\"); return {v, services: h.services}; }"}'
{
  "result": { "v": 1, "services": ["sonarr"] },
  "artifacts": [],
  "logs": []
}

$ node dist/cli.js bogus '{}'   →  Usage on stderr, exit 2
```
The snippet save + run round-trip and the env-derived service list
really executed through the built `dist/cli.js`; no HTTP call was
made (the configured URL points at a dead port and nothing dialled
it).

## Lockfile status

**Clean lockfile (Route 3), verified.** `package.json` alone was
copied into a fresh `/tmp/mediafleet-lock/` (no `node_modules` there)
and `npm install --package-lock-only --ignore-scripts --offline`
produced a `package-lock.json` that parses, has
`name == "@reneturcios/mediafleet"`, lockfileVersion 3, and **128
package entries**; only that file was copied into the build dir.
`node_modules` in the build dir is a `cp -a` copy from gapproof
(local build only, gitignored).

## Gaps

- **Schemas and sandbox shapes are README reconstructions.** The
  README documents the tool name, the `code` parameter, the sandbox
  global names, the action names and the env variables, but not wire
  schemas or the exact callable shapes. Choices made here: a
  per-service callable performs a GET when invoked and carries the
  verb methods; `codemode` with no `code` returns a summary; `op`
  dispatches on `{path}` / `{name}` / `{code}`. The original server
  was never run — parity is against the docs-derived fixture only.
- **`node:vm` is not a security boundary.** It isolates globals (no
  `process`, no `require`), but determined code can reach host
  intrinsics through prototype chains; a hardened deployment would
  need a separate process or isolate. A synchronous infinite loop
  inside the code also cannot be interrupted by the run timeout,
  which only bounds awaited work.
- **Service API realism is shallow.** Status paths are the services'
  conventional endpoints, and auth is a single header per service:
  qBittorrent's real login-cookie flow and Tautulli's `apikey` query
  parameter are not modelled, so those two would need executor-level
  adaptation against live instances. Nothing was tested against a
  live service.
- **No destructive-action gating** (by spec, noted above): DELETE
  and other verbs pass straight through.
- Container build not exercised locally; the publish-container
  workflow smoke-tests the image at publish time.

## Blockers

None for the local build. Nothing pushed or published;
SCOREBOARD/NAMES were not edited.
