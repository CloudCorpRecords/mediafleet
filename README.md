# mediafleet

mediafleet puts a whole self-hosted media stack behind a single MCP
tool. Instead of one tool per operation per service, the server exposes
one Code Mode tool, `yarr`: you hand it a JavaScript async arrow
function, and it runs in a sandbox whose globals are callables for the
media services you configured — Sonarr, Radarr, Prowlarr, Tautulli,
Overseerr, Bazarr, SABnzbd, qBittorrent, Plex and Jellyfin. A single
call can query three services, combine the answers, and return one
composed result.

This package is a clean-room rebuild of that documented surface. It
implements the full documented core: the one tool, the sandbox
globals, the action dispatch, and the snippet store described below.

## Configuration

Services are opted in through the environment:

| Variable | Meaning |
| --- | --- |
| `YARR_SERVICES` | Comma-separated list of configured services. When unset, any service with a URL variable set counts as configured. |
| `YARR_<SERVICE>_URL` | Base URL, e.g. `YARR_SONARR_URL=http://localhost:8989`. |
| `YARR_<SERVICE>_API_KEY` | API key, sent as the `X-Api-Key` header. |
| `YARR_PLEX_TOKEN` | Plex's credential, sent as the `X-Plex-Token` header. |

Only configured services appear in the sandbox. Unconfigured names are
simply not defined there, and `api.<service>` is absent for them too.

## The sandbox

The `code` argument is an async arrow function. It is invoked with no
argument (snippet runs pass their input instead; see below) and its
return value — normalised to plain JSON-shaped data — becomes the
tool result, alongside any artifacts written and any console lines
captured during the run.

Globals available to the code:

- **Per-service callables** — `sonarr`, `radarr`, … Calling one
  performs a GET (`await sonarr("/api/v3/series")`); `.get`, `.post`,
  `.put` and `.delete(path, body)` are attached, plus `.status()`,
  which probes the service's conventional status endpoint and reports
  `{service, ok, status}` or `{service, ok: false, error}`.
- **`api.<service>.get/post/put/delete(path, body)`** — the explicit
  HTTP surface for each configured service.
- **`callTool(action, params)`** — dispatch for the documented
  actions. Generic: `service_status` (`{service?}`), `api_get`,
  `api_post`, `api_put`, `api_delete` (each `{service, path, body?}`)
  and `help`. Codemode: `codemode` (`{code, input?}` runs nested code,
  otherwise returns a summary), `op` (one of `{path}` to describe,
  `{name, input?}` to run a snippet, `{code, input?}` to run code),
  `snippet_list`, `snippet_save` (`{name, code}`), `snippet_run`
  (`{name, input?}`) and `snippet_delete` (`{name}`).
- **`codemode.search(query)`** — substring-search the catalogue of
  services, api paths, actions and helpers.
- **`codemode.describe(path)`** — return the catalogue entry for one
  path, e.g. `codemode.describe("api.sonarr.get")`.
- **`codemode.snippets()`** — list the snippets in the store.
- **`codemode.run(name, input)`** — run a saved snippet; its function
  receives `input` as its argument.
- **`writeArtifact(name, content)`** — store a named text artifact;
  everything written during a run is returned with that run's result.
- **`console.log/info/warn/error`** — captured and returned as the
  run's `logs`, never written to the server's stdout.

Snippets live in a per-process in-memory store: they persist across
calls for the life of the server process and are gone when it exits.

Two honest limits: the sandbox is `node:vm`, which isolates globals
(there is no `process` or `require` inside) but is not a hardened
security boundary; and destructive verbs are not specially gated — if
the code issues a DELETE, mediafleet executes it, exactly as written.

## Install

```bash
npx @reneturcios/mediafleet yarr '{"code":"async () => { return await callTool(\"help\"); }"}'
```

Or run the container image:

```bash
docker run -i ghcr.io/cloudcorprecords/mediafleet
```

The container defaults to the MCP server. Pass CLI arguments to use
it as a CLI instead. Remember to pass the `YARR_*` environment
variables to whichever process runs the server.

## CLI

```bash
mediafleet yarr '{"code":"async () => { return await api.sonarr.get(\"/api/v3/system/status\"); }"}'
mediafleet yarr '{"code":"async () => { const s = await callTool(\"service_status\"); return s; }"}'
mediafleet --version
mediafleet mcp
```

Exit codes: `0` on success, `1` on an execution or validation error,
`2` on a usage error.

## MCP client config

```json
{
  "mcpServers": {
    "mediafleet": {
      "command": "npx",
      "args": ["-y", "@reneturcios/mediafleet", "mcp"],
      "env": {
        "YARR_SERVICES": "sonarr,radarr,plex",
        "YARR_SONARR_URL": "http://localhost:8989",
        "YARR_SONARR_API_KEY": "…",
        "YARR_RADARR_URL": "http://localhost:7878",
        "YARR_RADARR_API_KEY": "…",
        "YARR_PLEX_URL": "http://localhost:32400",
        "YARR_PLEX_TOKEN": "…"
      }
    }
  }
}
```

## MCP tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `yarr` | `code: string` (required) | Execute the async arrow function in the Code Mode sandbox and return `{result, artifacts, logs}`. |

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # tsx --test test/*.test.ts — fake executor and fake fetch only, no network
npm run dev     # tsx src/cli.ts
```

All service traffic goes through a single injectable executor
function, and the default executor's HTTP goes through an injectable
fetch, which is what lets the test suite exercise the whole surface —
URL and header construction included — without a live service.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
