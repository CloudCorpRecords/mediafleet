/**
 * mediafleet types.
 *
 * The single tool, `yarr`, takes a `code` string: a JavaScript async
 * arrow function. Everything the sandboxed code can reach is described
 * here as plain data or as an injectable function type, so the whole
 * surface is testable with a fake executor and a fake fetch — no live
 * media service and no network are ever needed in tests.
 */

/** Every service the sandbox knows how to expose, in documented order. */
export const SERVICE_NAMES = [
  "sonarr",
  "radarr",
  "prowlarr",
  "tautulli",
  "overseerr",
  "bazarr",
  "sabnzbd",
  "qbittorrent",
  "plex",
  "jellyfin",
] as const;

export type ServiceName = (typeof SERVICE_NAMES)[number];

/** HTTP verbs the api surface and the executor speak. */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** One configured media service: where it lives and how to authenticate. */
export interface ServiceConfig {
  name: ServiceName;
  /** Base URL with no trailing slash, e.g. "http://localhost:8989". */
  baseUrl: string;
  /**
   * Credential sent by the default executor: as `X-Api-Key` for every
   * service except Plex, whose token is sent as `X-Plex-Token`. For
   * Plex this field holds the value of `YARR_PLEX_TOKEN`.
   */
  apiKey?: string;
}

/**
 * The injectable executor: every service call the sandbox makes is
 * funnelled through one of these. The default implementation performs
 * a real HTTP request against the service's base URL; tests substitute
 * a recording fake.
 */
export type Executor = (
  service: ServiceName,
  method: HttpMethod,
  path: string,
  body?: unknown,
) => Promise<unknown>;

/** The subset of the fetch API the default executor relies on. */
export type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Arguments of the one MCP tool. */
export interface YarrArgs {
  code: string;
}

/** One snippet in the store: a named, reusable piece of sandbox code. */
export interface Snippet {
  name: string;
  code: string;
}

/** One catalogue entry, as returned by codemode.search / describe. */
export interface CatalogueEntry {
  path: string;
  kind: "service" | "api" | "action" | "helper";
  description: string;
}

/** What one sandbox run hands back to the tool result. */
export interface RunOutcome {
  /** The function's return value, normalised to JSON-shaped data. */
  result: unknown;
  /** Artifacts written with writeArtifact() during this run, in order. */
  artifacts: { name: string; content: string }[];
  /** Lines the sandboxed code sent to console.* during this run. */
  logs: string[];
}

/**
 * Injectable dependencies for the core. `executor` performs service
 * calls, `snippets` and `artifacts` are the per-process in-memory
 * stores, and `timeoutMs` bounds one sandbox run.
 */
export interface MediaDeps {
  services: ServiceConfig[];
  executor: Executor;
  snippets: Map<string, string>;
  artifacts: Map<string, string>;
  timeoutMs: number;
}
