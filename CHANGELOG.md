# Changelog

## 0.1.0 (2026-10-26)

- Initial release. Clean-room rebuild of the documented yarr Code Mode
  surface: one MCP tool, `yarr`, taking a required `code` string.
- The `code` is a JavaScript async arrow function run in a `node:vm`
  sandbox. Inside the sandbox: one callable per configured service
  (sonarr, radarr, prowlarr, tautulli, overseerr, bazarr, sabnzbd,
  qbittorrent, plex, jellyfin), `api.<service>.get/post/put/delete`,
  `callTool(action, params)` for the generic actions (service_status,
  api_get, api_post, api_put, api_delete, help) and the codemode
  actions (codemode, op, snippet_list, snippet_save, snippet_run,
  snippet_delete), `codemode.search/describe/snippets/run`, and
  `writeArtifact(name, content)`.
- Services are configured with `YARR_SERVICES`, `YARR_<SERVICE>_URL`
  and `YARR_<SERVICE>_API_KEY` (`YARR_PLEX_TOKEN` for Plex). All HTTP
  goes through an injectable executor; snippets live in a per-process
  in-memory store.
- CLI: `mediafleet yarr '<json>'`, `mediafleet mcp`, `--version`.
