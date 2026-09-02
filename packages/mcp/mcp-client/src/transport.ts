/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Agent, fetch as undiciFetch } from 'undici'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './index.ts'

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * A fetch whose undici dispatcher bounds the idle header and body waits to
 * the row's toolCallTimeoutMs. Node's default dispatcher kills an idle socket
 * after ~300 seconds, so a long LLM-backed MCP call (no response bytes until
 * completion) would lose its connection mid-call while the server kept
 * processing. The dispatcher's pooled sockets are released when the owning
 * transport closes.
 *
 * @param agent - The dispatcher shared by every request of one transport.
 * @returns A FetchLike that routes every request through the dispatcher.
 */
function boundedFetch(agent: Agent): FetchLike {
  return (url, init) => {
    // The dispatcher option is undici's extension of the web RequestInit, and
    // the two init type families differ in that extension (and in undici's
    // BodyInit generics), so the merged object casts to undici's own
    // parameter type; the call's signal, headers, and method pass through
    // untouched.
    const dispatch = undiciFetch(url, { ...init, dispatcher: agent } as unknown as Parameters<typeof undiciFetch>[1])
    // undici's Response implements the web Response contract the SDK consumes
    // (status, headers, text/json, body stream).
    return dispatch as unknown as Promise<Response>
  }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http': {
      // Idle waits (response headers and body bytes) follow the row's
      // per-tool-call budget; the total-call cap stays with the SDK protocol
      // timer, so a call that exceeds the budget is rejected, not killed by
      // a shorter socket limit.
      const agent = new Agent({
        headersTimeout: config.toolCallTimeoutMs,
        bodyTimeout: config.toolCallTimeoutMs,
      })
      // The MCP SDK's StreamableHTTPClientTransport has optional callback
      // properties typed without `| undefined` (exactOptionalPropertyTypes
      // mismatch with the Transport interface); the SDK constructed the
      // object, so the cast records only that widening.
      const transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        { fetch: boundedFetch(agent), requestInit: { headers: config.headers } },
      ) as Transport
      const closeTransport = transport.close.bind(transport)
      transport.close = async () => {
        await closeTransport()
        try {
          await agent.close()
        } catch {
          /* a dispatcher pool that will not drain; the process exit reclaims its sockets */
        }
      }
      return transport
    }
  }
}
