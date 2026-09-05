import { sha256Hex } from '@interlock/core';

/**
 * The outbound half of the proxy: our MCP client, facing the real server.
 *
 * The agent's config changes by one line and nothing else. It points at us, we
 * point at whatever it used to point at, and the tools it sees are the upstream
 * tools minus the ones the mandate does not grant.
 */

/** A tool as the upstream server describes it. Shape is the MCP `Tool`. */
export interface UpstreamTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly [key: string]: unknown;
}

export interface Manifest {
  readonly tools: readonly UpstreamTool[];
  /** sha256 over the whole manifest, before any filtering. */
  readonly sha256: string;
}

/**
 * Stable stringify for manifests.
 *
 * Deliberately *not* canonicalJson. That one refuses any number which is not a
 * safe integer, because in this codebase a float is always money going wrong.
 * A JSON Schema is not money and may legitimately carry `1.5`, so manifests get
 * their own encoder: same recursive key ordering, no opinion about numbers.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${members.join(',')}}`;
}

/**
 * Hash the manifest as served, with tools ordered by name.
 *
 * Ordering is normalised because a server is free to list its tools in any
 * order and we do not want the pin to churn on that. Everything else — every
 * description, every schema field — is in the hash, so a tool whose description
 * changed under us produces a different pin. That is Gate 6's input.
 */
export function manifestHash(tools: readonly UpstreamTool[]): string {
  const ordered = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256Hex(stableStringify(ordered));
}

/** The subset of an MCP client the proxy uses. Kept narrow so it can be faked. */
export interface UpstreamClient {
  listTools(): Promise<{ tools: UpstreamTool[] }>;
  callTool(request: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
}

export interface Upstream {
  manifest(): Promise<Manifest>;
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createUpstream(client: UpstreamClient): Upstream {
  return {
    async manifest() {
      const listed = await client.listTools();
      return { tools: listed.tools, sha256: manifestHash(listed.tools) };
    },
    call(name, args) {
      return client.callTool({ name, arguments: args });
    },
  };
}

/**
 * Tools the mandate grants, in upstream's own words.
 *
 * An agent that cannot see create_instant_settlement cannot be talked into
 * calling it, which removes a whole class of prompt injection before any gate
 * has to think about it. The gates still enforce scope independently, because
 * a tool name learned from somewhere else must not work either.
 */
export function grantedTools(
  tools: readonly UpstreamTool[],
  grantedNames: readonly string[],
): readonly UpstreamTool[] {
  const granted = new Set(grantedNames);
  return tools.filter((tool) => granted.has(tool.name));
}
