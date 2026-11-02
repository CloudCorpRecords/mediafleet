import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  callMediafleetTool,
  createDefaultExecutor,
  createDeps,
  parseServicesFromEnv,
  runYarr,
  STATUS_PATHS,
  VERSION,
} from "../src/mediafleet.js";
import type { Executor, FetchFn, ServiceConfig } from "../src/types.js";

const SONARR: ServiceConfig = {
  name: "sonarr",
  baseUrl: "http://sonarr.test:8989",
  apiKey: "sonarr-key",
};
const RADARR: ServiceConfig = {
  name: "radarr",
  baseUrl: "http://radarr.test:7878",
  apiKey: "radarr-key",
};

interface RecordedCall {
  service: string;
  method: string;
  path: string;
  body?: unknown;
}

function fakeDeps(timeoutMs = 1000) {
  const calls: RecordedCall[] = [];
  const executor: Executor = async (service, method, path, body) => {
    calls.push({ service, method, path, body });
    if (service === "radarr" && path === STATUS_PATHS.radarr) {
      throw new Error("down");
    }
    return { service, method, path, echo: body ?? null };
  };
  const deps = createDeps({
    services: [SONARR, RADARR],
    executor,
    timeoutMs,
  });
  return { deps, calls };
}

const run = (deps: ReturnType<typeof fakeDeps>["deps"], code: string) =>
  runYarr(deps, { code });

describe("environment configuration", () => {
  it("parses YARR_SERVICES with per-service URL and key, Plex via token", () => {
    const services = parseServicesFromEnv({
      YARR_SERVICES: "sonarr, plex ,bogus",
      YARR_SONARR_URL: "http://host:8989/",
      YARR_SONARR_API_KEY: "k1",
      YARR_PLEX_URL: "http://host:32400",
      YARR_PLEX_TOKEN: "tok-1",
    });
    assert.deepEqual(services, [
      { name: "sonarr", baseUrl: "http://host:8989", apiKey: "k1" },
      { name: "plex", baseUrl: "http://host:32400", apiKey: "tok-1" },
    ]);
  });

  it("infers configured services from URL variables when the list is absent", () => {
    const services = parseServicesFromEnv({
      YARR_JELLYFIN_URL: "http://jf:8096",
      YARR_JELLYFIN_API_KEY: "jk",
      YARR_SONARR_API_KEY: "no-url-so-not-configured",
    });
    assert.deepEqual(services, [
      { name: "jellyfin", baseUrl: "http://jf:8096", apiKey: "jk" },
    ]);
    assert.deepEqual(parseServicesFromEnv({}), []);
    assert.equal(VERSION, "0.1.0");
  });
});

describe("default executor (fake fetch, no network)", () => {
  it("joins base URL and path and sends X-Api-Key", async () => {
    const seen: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"version":"4.0"}' };
    };
    const executor = createDefaultExecutor([SONARR], fetchFn);
    const out = await executor("sonarr", "GET", "/api/v3/system/status");
    assert.deepEqual(out, { version: "4.0" });
    assert.equal(seen[0].url, "http://sonarr.test:8989/api/v3/system/status");
    assert.equal(seen[0].init.headers["X-Api-Key"], "sonarr-key");
    assert.equal(seen[0].init.body, undefined);
  });

  it("sends X-Plex-Token for Plex and a JSON body for POST", async () => {
    const seen: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, text: async () => "plain-ok" };
    };
    const executor = createDefaultExecutor(
      [{ name: "plex", baseUrl: "http://plex.test:32400", apiKey: "tok" }],
      fetchFn,
    );
    const out = await executor("plex", "POST", "library/refresh", { force: true });
    assert.equal(out, "plain-ok");
    assert.equal(seen[0].url, "http://plex.test:32400/library/refresh");
    assert.equal(seen[0].init.headers["X-Plex-Token"], "tok");
    assert.equal(seen[0].init.headers["X-Api-Key"], undefined);
    assert.equal(seen[0].init.body, '{"force":true}');
  });

  it("throws a descriptive error on HTTP failure and for unknown services", async () => {
    const fetchFn: FetchFn = async () => ({
      ok: false,
      status: 401,
      text: async () => "bad key",
    });
    const executor = createDefaultExecutor([SONARR], fetchFn);
    await assert.rejects(executor("sonarr", "GET", "/x"), /HTTP 401: bad key/);
    await assert.rejects(executor("radarr", "GET", "/x"), /not configured/);
  });
});

describe("sandbox execution", () => {
  it("returns the function result and exposes only configured services", async () => {
    const { deps } = fakeDeps();
    const outcome = await run(
      deps,
      "async () => ({ sonarr: typeof sonarr, radarr: typeof radarr, plex: typeof plex, apiPlex: typeof api.plex, proc: typeof process, req: typeof require })",
    );
    assert.deepEqual(outcome.result, {
      sonarr: "function",
      radarr: "function",
      plex: "undefined",
      apiPlex: "undefined",
      proc: "undefined",
      req: "undefined",
    });
    assert.deepEqual(outcome.artifacts, []);
  });

  it("routes api verbs and per-service callables through the executor", async () => {
    const { deps, calls } = fakeDeps();
    const outcome = await run(
      deps,
      [
        "async () => {",
        "  const a = await api.sonarr.get('/api/v3/series');",
        "  const b = await api.sonarr.post('/api/v3/command', { name: 'RefreshSeries' });",
        "  const c = await radarr('/api/v3/movie');",
        "  const d = await radarr.put('/api/v3/movie/1', { monitored: true });",
        "  const e = await api.radarr.delete('/api/v3/movie/2');",
        "  return [a.path, b.echo, c.method, d.echo, e.method];",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(outcome.result, [
      "/api/v3/series",
      { name: "RefreshSeries" },
      "GET",
      { monitored: true },
      "DELETE",
    ]);
    assert.deepEqual(
      calls.map((c) => [c.service, c.method]),
      [
        ["sonarr", "GET"],
        ["sonarr", "POST"],
        ["radarr", "GET"],
        ["radarr", "PUT"],
        ["radarr", "DELETE"],
      ],
    );
  });

  it("captures console output and writeArtifact content per run", async () => {
    const { deps } = fakeDeps();
    const outcome = await run(
      deps,
      "async () => { console.log('hello', 42); const w = await writeArtifact('note.txt', 'fleet note'); return w; }",
    );
    assert.deepEqual(outcome.result, { name: "note.txt", size: 10 });
    assert.deepEqual(outcome.artifacts, [{ name: "note.txt", content: "fleet note" }]);
    assert.deepEqual(outcome.logs, ["hello 42"]);
    assert.equal(deps.artifacts.get("note.txt"), "fleet note");
  });

  it("per-service .status() probes the documented status path", async () => {
    const { deps, calls } = fakeDeps();
    const outcome = await run(deps, "async () => sonarr.status()");
    assert.deepEqual(outcome.result, {
      service: "sonarr",
      ok: true,
      status: { service: "sonarr", method: "GET", path: STATUS_PATHS.sonarr, echo: null },
    });
    assert.equal(calls[0].path, "/api/v3/system/status");
  });
});

describe("callTool dispatch", () => {
  it("service_status reports every service and isolates failures", async () => {
    const { deps } = fakeDeps();
    const outcome = await run(deps, "async () => callTool('service_status')");
    assert.deepEqual(outcome.result, [
      {
        service: "sonarr",
        ok: true,
        status: { service: "sonarr", method: "GET", path: STATUS_PATHS.sonarr, echo: null },
      },
      { service: "radarr", ok: false, error: "down" },
    ]);
    const single = await run(
      deps,
      "async () => callTool('service_status', { service: 'sonarr' })",
    );
    assert.equal((single.result as { service: string }).service, "sonarr");
  });

  it("api_post / api_put / api_delete route with bodies; unconfigured services fail", async () => {
    const { deps, calls } = fakeDeps();
    const outcome = await run(
      deps,
      [
        "async () => {",
        "  const a = await callTool('api_post', { service: 'sonarr', path: '/api/v3/command', body: { name: 'Rescan' } });",
        "  const b = await callTool('api_put', { service: 'sonarr', path: '/api/v3/config/host', body: { port: 8989 } });",
        "  const c = await callTool('api_delete', { service: 'sonarr', path: '/api/v3/queue/9' });",
        "  return [a.echo, b.echo, c.method];",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(outcome.result, [{ name: "Rescan" }, { port: 8989 }, "DELETE"]);
    assert.equal(calls.length, 3);
    await assert.rejects(
      run(deps, "async () => callTool('api_get', { service: 'plex', path: '/identity' })"),
      /not configured/,
    );
  });

  it("help lists services, actions and helpers; unknown actions fail", async () => {
    const { deps } = fakeDeps();
    const outcome = await run(deps, "async () => callTool('help')");
    const help = outcome.result as {
      services: string[];
      generic_actions: string[];
      codemode_actions: string[];
    };
    assert.deepEqual(help.services, ["sonarr", "radarr"]);
    assert.ok(help.generic_actions.includes("service_status"));
    assert.ok(help.codemode_actions.includes("snippet_save"));
    await assert.rejects(run(deps, "async () => callTool('nope')"), /unknown action/);
  });
});

describe("snippets and codemode helpers", () => {
  it("snippet lifecycle via callTool: save, list, run with input, delete", async () => {
    const { deps } = fakeDeps();
    const outcome = await run(
      deps,
      [
        "async () => {",
        "  await callTool('snippet_save', { name: 'double', code: 'async (input) => input.x * 2' });",
        "  const list = await callTool('snippet_list');",
        "  const value = await callTool('snippet_run', { name: 'double', input: { x: 21 } });",
        "  const del = await callTool('snippet_delete', { name: 'double' });",
        "  const after = await callTool('snippet_list');",
        "  return { listed: list.map((s) => s.name), value, del, remaining: after.length };",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(outcome.result, {
      listed: ["double"],
      value: 42,
      del: { name: "double", deleted: true },
      remaining: 0,
    });
  });

  it("codemode.snippets/run mirror the store; codemode + op execute and describe", async () => {
    const { deps } = fakeDeps();
    await run(
      deps,
      "async () => callTool('snippet_save', { name: 'greet', code: 'async (input) => \"hi \" + input.name' })",
    );
    const outcome = await run(
      deps,
      [
        "async () => {",
        "  const names = codemode.snippets().map((s) => s.name);",
        "  const greeting = await codemode.run('greet', { name: 'fleet' });",
        "  const viaOp = await callTool('op', { name: 'greet', input: { name: 'op' } });",
        "  const described = await callTool('op', { path: 'sonarr' });",
        "  const nested = await callTool('codemode', { code: 'async () => 7' });",
        "  return { names, greeting, viaOp, describedPath: described.path, nested };",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(outcome.result, {
      names: ["greet"],
      greeting: "hi fleet",
      viaOp: "hi op",
      describedPath: "sonarr",
      nested: 7,
    });
    await assert.rejects(
      run(deps, "async () => codemode.run('missing')"),
      /snippet not found/,
    );
  });

  it("codemode.search and codemode.describe read the catalogue", async () => {
    const { deps } = fakeDeps();
    const outcome = await run(
      deps,
      [
        "async () => {",
        "  const hits = codemode.search('snippet').map((e) => e.path);",
        "  const entry = codemode.describe('api.sonarr.get');",
        "  const all = codemode.search('').length;",
        "  return { hits, entryKind: entry.kind, all };",
        "}",
      ].join("\n"),
    );
    const result = outcome.result as { hits: string[]; entryKind: string; all: number };
    assert.ok(result.hits.includes("snippet_save"));
    assert.ok(result.hits.includes("codemode.snippets"));
    assert.equal(result.entryKind, "api");
    assert.ok(result.all > 10);
    await assert.rejects(
      run(deps, "async () => codemode.describe('nope.nothing')"),
      /unknown path/,
    );
  });
});

describe("validation and limits", () => {
  it("rejects non-function code, empty code and unknown tools", async () => {
    const { deps } = fakeDeps();
    await assert.rejects(run(deps, "42"), /async arrow function/);
    await assert.rejects(runYarr(deps, { code: "   " }), /non-empty string/);
    await assert.rejects(
      callMediafleetTool(deps, "nope", {}),
      /Unknown tool/,
    );
    const ok = await callMediafleetTool(deps, "yarr", {
      code: "async () => 'via-dispatch'",
    });
    assert.equal((ok as { result: unknown }).result, "via-dispatch");
  });

  it("times out a run that never settles", async () => {
    const { deps } = fakeDeps(100);
    await assert.rejects(
      run(deps, "async () => { await new Promise(() => {}); }"),
      /timed out after 100ms/,
    );
  });
});
