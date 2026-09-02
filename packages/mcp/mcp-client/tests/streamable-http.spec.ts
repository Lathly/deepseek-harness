/**
 * REAL-composition tests for the Streamable HTTP transport's undici
 * dispatcher: the row's toolCallTimeoutMs bounds the socket's idle header and
 * body waits (Node's default dispatcher kills an idle socket after ~300
 * seconds, wedging a long LLM-backed call mid-flight), a connection broken
 * mid-call regenerates through the supervisor, and disposal drains the
 * dispatcher's pooled sockets. A local HTTP MCP server stands in for a
 * remote one; no SDK module is mocked, so the real fetch path is exercised.
 */
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import { resolveReconnectPolicy, startConnection } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import { isTransportFailure } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'

// ---- Local MCP server ----

interface ServerOptions {
  listDelayMs?: number
  callDelayMs?: number
}

interface LocalMcpServer {
  port: number
  sockets: Set<Socket>
  close(): Promise<void>
  closeAllConnections(): void
}

/**
 * Start a single-endpoint JSON-RPC MCP server: initialize, tools/list (one
 * `sleep` tool), and tools/call. GET answers 405 (no standalone stream).
 * Every connection is tracked so tests can observe socket teardown. The
 * same handle can listen again after close on a chosen port.
 */
function startLocalMcpServer(options: ServerOptions, port?: number): Promise<LocalMcpServer> {
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' })
      res.end('no standalone streams')
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      const message = JSON.parse(body) as { id?: unknown; method: string; params?: Record<string, unknown> }
      const respond = (payload: unknown) => {
        // The client may have aborted (dispatcher timeout, generation close):
        // a delayed response must not write to a destroyed socket.
        if (req.socket.destroyed || res.destroyed) return
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })
      switch (message.method) {
        case 'initialize':
          respond({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: (message.params?.protocolVersion as string) ?? '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'spec-server', version: '1.0.0' },
            },
          })
          break
        case 'notifications/initialized':
          res.writeHead(202, { 'Content-Type': 'text/plain' })
          res.end()
          break
        case 'tools/list':
          void delay(options.listDelayMs ?? 0).then(() => {
            respond({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                tools: [{ name: 'sleep', description: 'sleeps then answers', inputSchema: { type: 'object', properties: {} } }],
                nextCursor: undefined,
              },
            })
          })
          break
        case 'tools/call':
          void delay(options.callDelayMs ?? 0).then(() => {
            respond({
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: `slept ${options.callDelayMs ?? 0}ms` }] },
            })
          })
          break
        default:
          respond({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })
      }
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
  })

  const handle: LocalMcpServer = {
    port: 0,
    sockets,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error === undefined) {
            resolve()
          } else {
            reject(error)
          }
        })
      })
    },
    closeAllConnections: () => { server.closeAllConnections() },
  }
  return new Promise((resolve, reject) => {
    server.listen(port ?? 0, '127.0.0.1', () => {
      handle.port = (server.address() as AddressInfo).port
      resolve(handle)
    })
    server.on('error', reject)
  })
}

// ---- Test scaffolding ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function captureLogs(ctx: Context): { warns: string[]; infos: string[] } {
  const warns: string[] = []
  const infos: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.info = ((message: unknown) => { infos.push(String(message)) }) as typeof ctx.logger.info
  return { warns, infos }
}

function httpConfig(reconnect?: StreamableHttpConfig['reconnect']): StreamableHttpConfig {
  return {
    transport: 'streamable-http',
    serverName: 'srv',
    url: 'http://127.0.0.1:0/mcp', // replaced per test
    headers: {},
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...reconnect === undefined ? {} : { reconnect },
  }
}

let callSeq = 0
function nextCallId(): ToolCallId {
  return ToolCallId(`streamable-http-${++callSeq}`)
}

async function executeTool(ctx: Context, name: string): Promise<{ isError: boolean; content: unknown }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: nextCallId(),
    name,
    arguments: {},
  })
  return result
}

// ---- Tests ----

describe('streamable-http undici dispatcher', () => {
  let ctx: Context
  let liveServers: LocalMcpServer[] = []

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  afterEach(async () => {
    for (const server of liveServers) await server.close().catch(() => { /* already closed */ })
    liveServers = []
  })

  it('bounds idle waits to the row budget: a slow tools/list is rejected, not served late', async () => {
    // A 1200ms server delay against a 400ms dispatcher bound: Node's default
    // dispatcher would serve the call at 1200ms; the bound must reject it.
    const server = await startLocalMcpServer({ listDelayMs: 1200 })
    liveServers.push(server)

    const config: StreamableHttpConfig = {
      ...httpConfig({ initialDelayMs: 50, maxDelayMs: 100, maxAttempts: 2 }),
      url: `http://127.0.0.1:${server.port}/mcp`,
      toolCallTimeoutMs: 400,
    }
    const handle = startConnection(ctx, config, resolveReconnectPolicy(config.reconnect, 'streamable-http-bounded'))
    const startedAt = Date.now()
    const outcome = await handle.ready
    const elapsedMs = Date.now() - startedAt

    expect(outcome.error).toBeDefined()
    // The rejection is a connection-level failure (the classifier's own
    // verdict), and it landed far short of the 1200ms server completion.
    expect(isTransportFailure(outcome.error)).toBe(true)
    expect(elapsedMs).toBeLessThan(2_500)
    await handle.dispose()
  })

  it('serves a long call within the budget', async () => {
    const server = await startLocalMcpServer({ callDelayMs: 1200 })
    liveServers.push(server)

    const config: StreamableHttpConfig = {
      ...httpConfig(),
      url: `http://127.0.0.1:${server.port}/mcp`,
      toolCallTimeoutMs: 5_000,
    }
    const handle = startConnection(ctx, config, resolveReconnectPolicy(config.reconnect, 'streamable-http-long'))
    const outcome = await handle.ready
    expect(outcome.error).toBeUndefined()

    const result = await executeTool(ctx, 'mcp__srv__sleep')
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('slept 1200ms')
    await handle.dispose()
  })

  it('regenerates the connection when it breaks mid-call and re-syncs after a server restart', async () => {
    const server = await startLocalMcpServer({ callDelayMs: 50 })
    liveServers.push(server)

    const config: StreamableHttpConfig = {
      ...httpConfig({ initialDelayMs: 50, maxDelayMs: 100, maxAttempts: 4 }),
      url: `http://127.0.0.1:${server.port}/mcp`,
      toolCallTimeoutMs: 5_000,
    }
    const { warns, infos } = captureLogs(ctx)
    const handle = startConnection(ctx, config, resolveReconnectPolicy(config.reconnect, 'streamable-http-wedge'))
    const outcome = await handle.ready
    expect(outcome.error).toBeUndefined()
    expect((await executeTool(ctx, 'mcp__srv__sleep')).isError).toBe(false)

    // The server dies while calls flow: the next call fails at the
    // connection level (isError, mapped by the executor), the report warns,
    // and a restarted server on the same port is re-synced.
    await server.close()
    const failure = await executeTool(ctx, 'mcp__srv__sleep')
    expect(failure.isError).toBe(true)
    // The report only fires when the classifier names a connection-level
    // failure, so the warn line is the classifier's own verdict.
    expect(warns.some(line => line.includes('a tool call hit a transport failure'))).toBe(true)

    await startLocalMcpServer({ callDelayMs: 50 }, server.port)
    await vi.waitFor(() => { expect(infos.some(line => line.includes('reconnected and re-synced tools'))).toBe(true) })
    expect((await executeTool(ctx, 'mcp__srv__sleep')).isError).toBe(false)
    await handle.dispose()
  })

  it('drains the dispatcher pool when the connection is disposed', async () => {
    const server = await startLocalMcpServer({})
    liveServers.push(server)

    const config: StreamableHttpConfig = {
      ...httpConfig(),
      url: `http://127.0.0.1:${server.port}/mcp`,
    }
    const handle = startConnection(ctx, config, resolveReconnectPolicy(config.reconnect, 'streamable-http-drain'))
    const outcome = await handle.ready
    expect(outcome.error).toBeUndefined()
    await executeTool(ctx, 'mcp__srv__sleep')
    // The keep-alive pool holds the server's socket after the call.
    expect(server.sockets.size).toBeGreaterThanOrEqual(1)

    await handle.dispose()
    await vi.waitFor(() => { expect(server.sockets.size).toBe(0) })
  })
})
