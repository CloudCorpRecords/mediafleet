#!/usr/bin/env node
/**
 * mediafleet CLI.
 *
 *   mediafleet yarr '<json-arguments>'
 *   mediafleet mcp
 *   mediafleet --version
 *
 * Example:
 *   mediafleet yarr '{"code":"async () => { return await callTool(\"help\"); }"}'
 *
 * Exit codes: 0 success, 1 execution/validation error, 2 usage error.
 */
import { callMediafleetTool, defaultDeps, TOOL_NAMES, VERSION } from "./mediafleet.js";

function usage(): never {
  console.error(`Usage:
  mediafleet <tool-name> '<json-arguments>'
  mediafleet mcp
  mediafleet --version
Tools: ${TOOL_NAMES.join(", ")}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    await import("./mcp.js");
    return;
  }
  if (!cmd || !(TOOL_NAMES as readonly string[]).includes(cmd)) usage();
  let args: Record<string, unknown> = {};
  const raw = rest.join(" ").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) usage();
      args = parsed as Record<string, unknown>;
    } catch {
      usage();
    }
  }
  try {
    const result = await callMediafleetTool(defaultDeps(), cmd, args);
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
