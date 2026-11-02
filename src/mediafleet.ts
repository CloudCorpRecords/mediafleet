/**
 * mediafleet core: a Code Mode sandbox for a self-hosted media stack.
 *
 * Clean-room rebuild of the documented surface of dinglebear-ai/yarr,
 * from its public README. The server exposes exactly one tool, `yarr`,
 * whose `code` argument is a JavaScript async arrow function. The code
 * runs in a `node:vm` context with these globals:
 *
 * - one callable per configured service (sonarr, radarr, prowlarr,
 *   tautulli, overseerr, bazarr, sabnzbd, qbittorrent, plex, jellyfin):
 *   calling it performs a GET, and `.get/.post/.put/.delete(path, body)`
 *   plus `.status()` are attached;
 * - `api.<service>.get/post/put/delete(path, body)`;
 * - `callTool(action, params)` dispatching the generic actions
 *   (service_status, api_get, api_post, api_put, api_delete, help) and
 *   the codemode actions (codemode, op, snippet_list, snippet_save,
 *   snippet_run, snippet_delete);
 * - `codemode.search(query)`, `codemode.describe(path)`,
 *   `codemode.snippets()`, `codemode.run(name, input)`;
 * - `writeArtifact(name, content)` and a capturing `console`.
 *
 * Every service call funnels through one injectable Executor. The
 * default executor performs real HTTP against the configured base URL
 * with an `X-Api-Key` header (`X-Plex-Token` for Plex). Tests inject
 * a recording fake executor and a fake fetch, so nothing here needs a
 * live service. Snippets and artifacts live in per-process in-memory
 * maps. There is deliberately no extra gating on destructive verbs:
 * a DELETE issued by the code is executed like any other call.
 */
import vm from "node:vm";
import {
  SERVICE_NAMES,
  type CatalogueEntry,
  type Executor,
  type FetchFn,
  type HttpMethod,
  type MediaDeps,
  type RunOutcome,
  type ServiceConfig,
  type ServiceName,
  type YarrArgs,
} from "./types.js";

export const VERSION = "0.1.0";

export const TOOL_NAMES = ["yarr"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const GENERIC_ACTIONS = [
  "service_status",
  "api_get",
  "api_post",
  "api_put",
  "api_delete",
  "help",
] as const;

export const CODEMODE_ACTIONS = [
  "codemode",
  "op",
  "snippet_list",
  "snippet_save",
  "snippet_run",
  "snippet_delete",
] as const;

/** Conventional status probe path per service, used by service_status. */
export const STATUS_PATHS: Record<ServiceName, string> = {
  sonarr: "/api/v3/system/status",
  radarr: "/api/v3/system/status",
  prowlarr: "/api/v1/system/status",
  tautulli: "/api/v2?cmd=get_server_info",
  overseerr: "/api/v1/status",
  bazarr: "/api/system/status",
  sabnzbd: "/api?mode=version",
  qbittorrent: "/api/v2/app/version",
  plex: "/identity",
  jellyfin: "/System/Info/Public",
};

// ------------------------------------------------------------ configuration

/**
 * Read the service configuration from an environment map.
 *
 * `YARR_SERVICES` is a comma-separated list; when it is absent, any
 * service with a `YARR_<SERVICE>_URL` set counts as configured. Each
 * service takes `YARR_<SERVICE>_URL` and `YARR_<SERVICE>_API_KEY`,
 * except Plex, whose credential is `YARR_PLEX_TOKEN`.
 */
export function parseServicesFromEnv(
  env: Record<string, string | undefined>,
): ServiceConfig[] {
  const known = new Set<string>(SERVICE_NAMES as readonly string[]);
  let listed: string[] = [];
  const raw = env.YARR_SERVICES;
  if (raw && raw.trim()) {
    listed = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => known.has(s));
  } else {
    listed = SERVICE_NAMES.filter((n) => env[`YARR_${n.toUpperCase()}_URL`]);
  }
  const unique = [...new Set(listed)];
  return unique.map((name) => {
    const svc = name as ServiceName;
    const upper = svc.toUpperCase();
    const baseUrl = (env[`YARR_${upper}_URL`] ?? "").replace(/\/+$/, "");
    const apiKey =
      svc === "plex"
        ? (env.YARR_PLEX_TOKEN ?? env[`YARR_${upper}_API_KEY`])
        : env[`YARR_${upper}_API_KEY`];
    return { name: svc, baseUrl, ...(apiKey ? { apiKey } : {}) };
  });
}

/**
 * The default executor: real HTTP against `{baseUrl}{path}` with the
 * service credential as `X-Api-Key` (`X-Plex-Token` for Plex), a JSON
 * body for non-GET calls, and JSON-or-text response parsing. A non-2xx
 * response is an error naming the service, method, path and status.
 */
export function createDefaultExecutor(
  services: ServiceConfig[],
  fetchFn: FetchFn,
): Executor {
  const byName = new Map(services.map((s) => [s.name, s]));
  return async (service, method, path, body) => {
    const cfg = byName.get(service);
    if (!cfg) throw new Error(`service not configured: ${service}`);
    if (!cfg.baseUrl) {
      throw new Error(`service ${service} has no base URL configured`);
    }
    const suffix = path.startsWith("/") || path.startsWith("?") ? path : `/${path}`;
    const url = cfg.baseUrl.replace(/\/+$/, "") + suffix;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (cfg.apiKey) {
      if (service === "plex") headers["X-Plex-Token"] = cfg.apiKey;
      else headers["X-Api-Key"] = cfg.apiKey;
    }
    let payload: string | undefined;
    if (body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetchFn(url, { method, headers, body: payload });
    const text = await res.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    } else {
      data = null;
    }
    if (!res.ok) {
      const detail = typeof data === "string" ? data : JSON.stringify(data);
      throw new Error(
        `${service} ${method} ${path} failed with HTTP ${res.status}: ${detail}`,
      );
    }
    return data;
  };
}

export interface CreateDepsOptions {
  services?: ServiceConfig[];
  executor?: Executor;
  fetchFn?: FetchFn;
  env?: Record<string, string | undefined>;
  snippets?: Map<string, string>;
  artifacts?: Map<string, string>;
  timeoutMs?: number;
}

/** Build a deps object; anything not supplied gets its default. */
export function createDeps(options: CreateDepsOptions = {}): MediaDeps {
  const services =
    options.services ?? parseServicesFromEnv(options.env ?? {});
  const fetchFn =
    options.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  return {
    services,
    executor: options.executor ?? createDefaultExecutor(services, fetchFn),
    snippets: options.snippets ?? new Map<string, string>(),
    artifacts: options.artifacts ?? new Map<string, string>(),
    timeoutMs: options.timeoutMs ?? 15000,
  };
}

const sharedSnippets = new Map<string, string>();
const sharedArtifacts = new Map<string, string>();

/**
 * Default deps from the process environment. Snippet and artifact
 * stores are module-level singletons, so snippets saved by one tool
 * call stay runnable for the life of the process.
 */
export function defaultDeps(): MediaDeps {
  return createDeps({
    env: process.env,
    snippets: sharedSnippets,
    artifacts: sharedArtifacts,
  });
}

// --------------------------------------------------------------- catalogue

/** The searchable/describable catalogue of the sandbox surface. */
export function buildCatalogue(services: ServiceConfig[]): CatalogueEntry[] {
  const entries: CatalogueEntry[] = [];
  for (const svc of services) {
    entries.push({
      path: svc.name,
      kind: "service",
      description: `Callable for the configured ${svc.name} service at ${svc.baseUrl || "(no base URL)"}: ${svc.name}(path) performs a GET; .get/.post/.put/.delete(path, body) and .status() are attached.`,
    });
    entries.push({
      path: `api.${svc.name}`,
      kind: "api",
      description: `HTTP surface for ${svc.name}: api.${svc.name}.get/post/put/delete(path, body).`,
    });
    for (const verb of ["get", "post", "put", "delete"] as const) {
      entries.push({
        path: `api.${svc.name}.${verb}`,
        kind: "api",
        description: `${verb.toUpperCase()} request to ${svc.name}: api.${svc.name}.${verb}(path${verb === "get" ? "" : ", body"}).`,
      });
    }
  }
  const actionDescriptions: Record<string, string> = {
    service_status:
      "Probe one service ({service}) or every configured service ({}) and report ok plus the status payload or error.",
    api_get: "GET via callTool: callTool('api_get', {service, path}).",
    api_post: "POST via callTool: callTool('api_post', {service, path, body}).",
    api_put: "PUT via callTool: callTool('api_put', {service, path, body}).",
    api_delete: "DELETE via callTool: callTool('api_delete', {service, path, body?}).",
    help: "Return the sandbox help object: services, actions and helpers.",
    codemode:
      "Run nested code ({code, input?}) or return a summary of the codemode helpers.",
    op: "One dispatch for describe ({path}), snippet run ({name, input?}) or nested code ({code, input?}).",
    snippet_list: "List the snippets in the per-process in-memory store.",
    snippet_save: "Save a snippet: callTool('snippet_save', {name, code}).",
    snippet_run: "Run a saved snippet: callTool('snippet_run', {name, input?}).",
    snippet_delete: "Delete a snippet: callTool('snippet_delete', {name}).",
  };
  for (const action of [...GENERIC_ACTIONS, ...CODEMODE_ACTIONS]) {
    entries.push({ path: action, kind: "action", description: actionDescriptions[action] });
  }
  const helpers: [string, string][] = [
    ["callTool", "Dispatch a generic or codemode action: callTool(action, params)."],
    ["codemode", "Namespace for search, describe, snippets and run."],
    ["codemode.search", "Search the catalogue by substring: codemode.search(query) -> matching entries."],
    ["codemode.describe", "Describe one catalogue path: codemode.describe(path) -> the entry."],
    ["codemode.snippets", "List the snippets in the per-process in-memory store."],
    ["codemode.run", "Run a saved snippet with an input: codemode.run(name, input)."],
    ["writeArtifact", "Store a named text artifact for this run: writeArtifact(name, content)."],
    ["api", "Per-service HTTP surface: api.<service>.get/post/put/delete(path, body)."],
  ];
  for (const [path, description] of helpers) {
    entries.push({ path, kind: "helper", description });
  }
  return entries;
}

// ----------------------------------------------------------------- runtime

export interface ApiSurface {
  get(path: string, body?: unknown): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  put(path: string, body?: unknown): Promise<unknown>;
  delete(path: string, body?: unknown): Promise<unknown>;
}

export type ServiceCallable = {
  (path: string, body?: unknown): Promise<unknown>;
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  put(path: string, body?: unknown): Promise<unknown>;
  delete(path: string, body?: unknown): Promise<unknown>;
  status(): Promise<unknown>;
};

type RunCode = (code: string, input?: unknown) => Promise<unknown>;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function createRuntime(deps: MediaDeps, runCode: RunCode) {
  const configured = new Map(deps.services.map((s) => [s.name, s]));
  const catalogue = buildCatalogue(deps.services);

  function requireService(value: unknown): ServiceName {
    if (typeof value !== "string" || !configured.has(value as ServiceName)) {
      throw new Error(`service not configured: ${String(value)}`);
    }
    return value as ServiceName;
  }

  function requirePath(value: unknown): string {
    if (typeof value !== "string" || !value) {
      throw new Error("path must be a non-empty string");
    }
    return value;
  }

  function apiFor(service: ServiceName): ApiSurface {
    const call =
      (method: HttpMethod) =>
      (path: string, body?: unknown): Promise<unknown> =>
        deps.executor(service, method, requirePath(path), body);
    return {
      get: call("GET"),
      post: call("POST"),
      put: call("PUT"),
      delete: call("DELETE"),
    };
  }

  async function statusFor(service: ServiceName) {
    try {
      const status = await deps.executor(service, "GET", STATUS_PATHS[service]);
      return { service, ok: true, status };
    } catch (err) {
      return { service, ok: false, error: messageOf(err) };
    }
  }

  function serviceCallable(service: ServiceName): ServiceCallable {
    const api = apiFor(service);
    const fn = ((path: string, body?: unknown) =>
      api.get(path, body)) as ServiceCallable;
    fn.get = api.get;
    fn.post = api.post;
    fn.put = api.put;
    fn.delete = api.delete;
    fn.status = () => statusFor(service);
    return fn;
  }

  function listSnippets() {
    return [...deps.snippets.entries()].map(([name, code]) => ({ name, code }));
  }

  async function runSnippet(name: unknown, input?: unknown): Promise<unknown> {
    if (typeof name !== "string" || !name) {
      throw new Error("snippet name must be a non-empty string");
    }
    const code = deps.snippets.get(name);
    if (code === undefined) throw new Error(`snippet not found: ${name}`);
    return runCode(code, input);
  }

  function describe(path: unknown): CatalogueEntry {
    if (typeof path !== "string" || !path) {
      throw new Error("path must be a non-empty string");
    }
    const entry = catalogue.find((e) => e.path === path);
    if (!entry) throw new Error(`unknown path: ${path}`);
    return entry;
  }

  function helpObject() {
    return {
      services: deps.services.map((s) => s.name),
      api: "api.<service>.get/post/put/delete(path, body)",
      generic_actions: [...GENERIC_ACTIONS],
      codemode_actions: [...CODEMODE_ACTIONS],
      helpers: [
        "callTool(action, params)",
        "codemode.search(query)",
        "codemode.describe(path)",
        "codemode.snippets()",
        "codemode.run(name, input)",
        "writeArtifact(name, content)",
      ],
    };
  }

  async function apiCallViaTool(
    method: HttpMethod,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const service = requireService(params.service);
    return deps.executor(service, method, requirePath(params.path), params.body);
  }

  async function callTool(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const p = params ?? {};
    switch (action) {
      case "service_status": {
        if (p.service !== undefined) return statusFor(requireService(p.service));
        const out = [];
        for (const svc of deps.services) out.push(await statusFor(svc.name));
        return out;
      }
      case "api_get":
        return apiCallViaTool("GET", p);
      case "api_post":
        return apiCallViaTool("POST", p);
      case "api_put":
        return apiCallViaTool("PUT", p);
      case "api_delete":
        return apiCallViaTool("DELETE", p);
      case "help":
        return helpObject();
      case "codemode": {
        if (typeof p.code === "string") return runCode(p.code, p.input);
        return {
          helpers: helpObject().helpers,
          snippets: listSnippets(),
          services: deps.services.map((s) => s.name),
        };
      }
      case "op": {
        if (typeof p.code === "string") return runCode(p.code, p.input);
        if (typeof p.name === "string") return runSnippet(p.name, p.input);
        if (typeof p.path === "string") return describe(p.path);
        throw new Error("op requires one of: code, name, path");
      }
      case "snippet_list":
        return listSnippets();
      case "snippet_save": {
        if (typeof p.name !== "string" || !p.name) {
          throw new Error("snippet_save requires a non-empty name");
        }
        if (typeof p.code !== "string" || !p.code) {
          throw new Error("snippet_save requires a non-empty code string");
        }
        deps.snippets.set(p.name, p.code);
        return { saved: p.name };
      }
      case "snippet_run":
        return runSnippet(p.name, p.input);
      case "snippet_delete": {
        if (typeof p.name !== "string" || !p.name) {
          throw new Error("snippet_delete requires a non-empty name");
        }
        return { name: p.name, deleted: deps.snippets.delete(p.name) };
      }
      default:
        throw new Error(`unknown action: ${action}`);
    }
  }

  const codemode = {
    search(query: string): CatalogueEntry[] {
      const q = String(query ?? "").toLowerCase();
      if (!q) return [...catalogue];
      return catalogue.filter(
        (e) =>
          e.path.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q),
      );
    },
    describe(path: string): CatalogueEntry {
      return describe(path);
    },
    snippets(): { name: string; code: string }[] {
      return listSnippets();
    },
    run(name: string, input?: unknown): Promise<unknown> {
      return runSnippet(name, input);
    },
  };

  const api: Record<string, ApiSurface> = {};
  const callables: Record<string, ServiceCallable> = {};
  for (const svc of deps.services) {
    api[svc.name] = apiFor(svc.name);
    callables[svc.name] = serviceCallable(svc.name);
  }

  return { api, callables, callTool, codemode };
}

// --------------------------------------------------------------- execution

function normalise(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`code execution timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

function stringifyForLog(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function executeInternal(
  deps: MediaDeps,
  code: string,
  input: unknown,
  logs: string[],
): Promise<unknown> {
  const runCode: RunCode = (nestedCode, nestedInput) =>
    executeInternal(deps, nestedCode, nestedInput, logs);
  const runtime = createRuntime(deps, runCode);

  const capture = (...args: unknown[]) => {
    logs.push(args.map(stringifyForLog).join(" "));
  };
  const sandbox: Record<string, unknown> = {
    api: runtime.api,
    callTool: runtime.callTool,
    codemode: runtime.codemode,
    writeArtifact: (name: string, content: unknown) => {
      const key = String(name);
      const text = typeof content === "string" ? content : stringifyForLog(content);
      deps.artifacts.set(key, text);
      return { name: key, size: text.length };
    },
    console: { log: capture, info: capture, warn: capture, error: capture, debug: capture },
    input,
  };
  for (const svc of deps.services) {
    sandbox[svc.name] = runtime.callables[svc.name];
  }

  const context = vm.createContext(sandbox);
  const src = code.trim().replace(/;+\s*$/, "");
  if (!src) throw new Error("code must be a non-empty string");
  let fn: unknown;
  try {
    const script = new vm.Script(`(${src})`, { filename: "mediafleet-code.js" });
    fn = script.runInContext(context, { timeout: 1000 });
  } catch (err) {
    throw new Error(`code did not evaluate: ${messageOf(err)}`);
  }
  if (typeof fn !== "function") {
    throw new Error("code must be a JavaScript async arrow function");
  }
  const callable = fn as (arg: unknown) => unknown;
  const value = await withTimeout(
    Promise.resolve().then(() => callable(input)),
    deps.timeoutMs,
  );
  return normalise(value);
}

/**
 * Run one `yarr` call: validate the code, execute it in the sandbox,
 * and hand back the normalised result plus the artifacts written and
 * the console lines captured during this run.
 */
export async function runYarr(deps: MediaDeps, args: YarrArgs): Promise<RunOutcome> {
  if (!args || typeof args.code !== "string" || !args.code.trim()) {
    throw new Error("code must be a non-empty string");
  }
  const logs: string[] = [];
  const before = new Map(deps.artifacts);
  const result = await executeInternal(deps, args.code, undefined, logs);
  const artifacts: { name: string; content: string }[] = [];
  for (const [name, content] of deps.artifacts) {
    if (!before.has(name) || before.get(name) !== content) {
      artifacts.push({ name, content });
    }
  }
  return { result, artifacts, logs };
}

/** Generic entry point used by the MCP server and the CLI. */
export async function callMediafleetTool(
  deps: MediaDeps,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (tool) {
    case "yarr":
      return runYarr(deps, (args ?? {}) as unknown as YarrArgs);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
