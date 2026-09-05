import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Engine } from './engine.js';

/**
 * The inbound half of the proxy: an MCP server facing the agent.
 *
 * From the agent's side this is indistinguishable from the server it used to
 * talk to, minus the tools it was never allowed to call. One line of config
 * changes; no code does. That is the whole integration story, and it is why the
 * refusal shapes in responses.ts matter so much — a drop-in that makes agents
 * retry is worse than no drop-in at all.
 */

export const PROXY_NAME = 'interlock';
export const PROXY_VERSION = '0.1.0';

export interface ProxyServerOptions {
  readonly engine: Engine;
  readonly name?: string;
  readonly version?: string;
}

export function createProxyServer(options: ProxyServerOptions): Server {
  const server = new Server(
    { name: options.name ?? PROXY_NAME, version: options.version ?? PROXY_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await options.engine.listTools();
    return { tools: tools.map((tool) => ({ ...tool, inputSchema: tool.inputSchema as never })) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const result = await options.engine.callTool(request.params.name, args);
    return {
      content: result.content.map((part) => ({ ...part })),
      isError: result.isError ?? false,
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
    };
  });

  return server;
}

export async function connectProxy(server: Server, transport: Transport): Promise<void> {
  await server.connect(transport);
}
