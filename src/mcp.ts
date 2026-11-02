/**
 * mediafleet MCP server. One tool: yarr.
 *
 * Why the low-level Server instead of McpServer: the high-level helper
 * converts zod schemas to JSON Schema and injects keys that are not in
 * this tool's public spec ("$schema" and "additionalProperties"), which
 * breaks exact tool-list/schema parity with the spec. This file serves
 * tools/list with the spec's exact input schema as an explicit literal,
 * while zod still validates every tools/call argument set.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callMediafleetTool, defaultDeps, VERSION } from "./mediafleet.js";

const YarrArgs = z.object({ code: z.string() });

const TOOLS = [
  {
    name: "yarr",
    description:
      "Execute a JavaScript async arrow function in a Code Mode sandbox with callables for the configured media services.",
    inputSchema: {
      type: "object" as const,
      properties: { code: { type: "string", description: "JavaScript async arrow function to execute in the sandbox." } },
      required: ["code"],
    },
  },
];

const SCHEMAS: Record<string, z.ZodTypeAny> = {
  yarr: YarrArgs,
};

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

const server = new Server(
  { name: "mediafleet", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const schema = SCHEMAS[name];
  if (!schema) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  try {
    const parsed = schema.parse(args ?? {}) as Record<string, unknown>;
    return textResult(await callMediafleetTool(defaultDeps(), name, parsed));
  } catch (err) {
    return errorResult(err);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
