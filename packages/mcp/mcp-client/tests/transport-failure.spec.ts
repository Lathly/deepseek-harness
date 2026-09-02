/**
 * Tests for the transport-failure report: a tool call whose connection broke
 * mid-call (a fetch-level network failure) must regenerate the connection
 * through the supervisor's existing reconnect cycle, while protocol-level
 * server responses and aborted calls must not. The classifier's cause-chain
 * walk is covered directly. Isolated file so vi.mock of the MCP SDK doesn't
 * pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Config } from '@deepseek-ai/dsh-mcp-client'
import { McpError } from '@modelcontextprotocol/sdk/types.js'

// ---- Mock MCP SDK (mirrors reconnect.spec.ts) ----

const { mockConnect, mockClose, mockListTools, mockCallTool, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockCallTool = vi.fn<(
    _params?: Record<string, unknown>, _compatibilitySchema?: unknown, _options?: unknown,
  ) => Promise<unknown>>()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    if (request.method === 'tools/call') return await mockCallTool(request.params, undefined, options)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = vi.fn()
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, mockListTools, mockCallTool, MockClient, instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  // The factory wraps the instance's close to drain its undici dispatcher,
  // so the mock must expose the methods the wrapper reads. A plain function
  // keeps the `new` semantics: the returned object becomes the instance.
  StreamableHTTPClientTransport: vi.fn(function () {
    return { start: vi.fn(), close: vi.fn() }
  }),
}))

// vi.mock is hoisted above static imports, so the modules under test see the
// mocked SDK even through a static import.
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { resolveReconnectPolicy, startConnection } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import { isTransportFailure, syncTools } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import type { ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'

// ---- Helpers ----

const testToolSignal = new AbortController().signal

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

/** Capture the supervisor's logger lines by level on one context. */
function captureLogs(ctx: Context): { warns: string[]; errors: string[]; infos: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  const infos: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
  ctx.logger.info = ((message: unknown) => { infos.push(String(message)) }) as typeof ctx.logger.info
  return { warns, errors, infos }
}

function httpConfig(reconnect?: Config['reconnect']): Config {
  return {
    transport: 'streamable-http',
    serverName: 'srv',
    url: 'http://127.0.0.1:3800/mcp',
    headers: {},
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...reconnect === undefined ? {} : { reconnect },
  }
}

function listing(...names: string[]): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return {
    tools: names.map(name => ({ name, inputSchema: { type: 'object' } })),
    nextCursor: undefined,
  }
}

/** The rejection shape undici produces when the connection dies mid-call. */
function fetchFailure(code?: string): TypeError {
  const cause = new Error(code === undefined ? 'socket hang up' : `connect ${code} 127.0.0.1:3800`)
  if (code !== undefined) (cause as NodeJS.ErrnoException).code = code
  const failure = new TypeError('fetch failed')
  failure.cause = cause
  return failure
}

let callSeq = 0
function nextCallId(): ToolCallId {
  return ToolCallId(`transport-failure-${++callSeq}`)
}

async function executeTool(ctx: Context, name: string): Promise<{ isError: boolean }> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: nextCallId(),
    name,
    arguments: {},
  })
}

// ---- Tests ----

describe('transport failure regeneration', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('remote'))
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    ctx = await mountRegistry()
  })

  it('closes the generation on a mid-call transport failure, reconnects, and re-syncs', async () => {
    const { warns, infos } = captureLogs(ctx)
    await apply(ctx, httpConfig({ initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(instances).toHaveLength(1)

    // The connection dies while a call is in flight: the executor reports the
    // failure, the supervisor closes the generation, and the existing cycle
    // reconnects and re-syncs.
    mockCallTool.mockRejectedValue(fetchFailure('ECONNREFUSED'))
    // The executor maps the rejection to an isError result; the report fires
    // inside the call path and drives the regeneration.
    const failed = await executeTool(ctx, 'mcp__srv__remote')
    expect(failed.isError).toBe(true)
    expect(warns.some(line => line.includes('a tool call hit a transport failure'))).toBe(true)

    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(infos.some(line => line.includes('reconnected and re-synced tools'))).toBe(true)

    // The recovered generation serves calls through the new client.
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    const result = await executeTool(ctx, 'mcp__srv__remote')
    expect(result.isError).toBe(false)
  })

  it('does not regenerate on a protocol-level server response', async () => {
    const { warns } = captureLogs(ctx)
    await apply(ctx, httpConfig({ initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    mockCallTool.mockRejectedValue(new McpError(-32601, 'method not found'))
    const failed = await executeTool(ctx, 'mcp__srv__remote')
    expect(failed.isError).toBe(true)

    expect(warns.some(line => line.includes('a tool call hit a transport failure'))).toBe(false)
    expect(instances).toHaveLength(1)
    expect(mockClose).not.toHaveBeenCalled()
  })

  it('does not regenerate on a plain rejection', async () => {
    const { warns } = captureLogs(ctx)
    await apply(ctx, httpConfig({ initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    mockCallTool.mockRejectedValue(new Error('internal bridge error'))
    const failed = await executeTool(ctx, 'mcp__srv__remote')
    expect(failed.isError).toBe(true)

    expect(warns.some(line => line.includes('a tool call hit a transport failure'))).toBe(false)
    expect(instances).toHaveLength(1)
  })

  it('does not regenerate when the harness aborted the call', async () => {
    const { warns } = captureLogs(ctx)
    await apply(ctx, httpConfig({ initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    const controller = new AbortController()
    controller.abort()
    mockCallTool.mockRejectedValue(fetchFailure('ECONNRESET'))
    const failed = await ctx.tools.execute({
      signal: controller.signal,
      callId: nextCallId(),
      name: 'mcp__srv__remote',
      arguments: {},
    }) as { isError: boolean }
    expect(failed.isError).toBe(true)

    expect(warns.some(line => line.includes('a tool call hit a transport failure'))).toBe(false)
    expect(instances).toHaveLength(1)
  })

  it('no-ops the report for a call routed through a closed generation', async () => {
    // A long backoff widens the down window: the pre-crash tools stay
    // registered while the reconnect timer is pending, and a stale failure
    // must not close a generation that no longer exists.
    const { warns } = captureLogs(ctx)
    const config = httpConfig({ initialDelayMs: 60_000, maxDelayMs: 60_000, maxAttempts: 2 })
    const handle = startConnection(ctx, config, resolveReconnectPolicy(config.reconnect, 'transport-failure'))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(instances).toHaveLength(1)

    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(warns.some(line => line.includes('reconnecting in 60000ms (attempt 1/2)'))).toBe(true) })

    mockCallTool.mockRejectedValue(fetchFailure('ECONNREFUSED'))
    const failed = await executeTool(ctx, 'mcp__srv__remote')
    expect(failed.isError).toBe(true)
    // The report saw no current generation: nothing was closed, nothing new
    // was scheduled.
    expect(mockClose).not.toHaveBeenCalled()
    expect(warns.some(line => line.includes('a tool call hit a transport failure'))).toBe(false)
    expect(instances).toHaveLength(1)
    await handle.dispose()
  })

  it('swallows a rejecting close and still regenerates through the close signal', async () => {
    const { infos } = captureLogs(ctx)
    await apply(ctx, httpConfig({ initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    // The close rejects (the transport is already gone), but its close signal
    // still fires, so the reconnect cycle proceeds and the rejection stays
    // contained.
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.reject(new Error('close failed'))
    })
    mockCallTool.mockRejectedValue(fetchFailure('ECONNRESET'))
    const failed = await executeTool(ctx, 'mcp__srv__remote')
    expect(failed.isError).toBe(true)

    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    expect(infos.some(line => line.includes('reconnected and re-synced tools'))).toBe(true)
  })

  it('omits the report when the bridge options define no handler', async () => {
    const { infos } = captureLogs(ctx)
    const client = new MockClient()
    const opts: ToolBridgeOptions = {
      registrationFailure: 'contain',
      serverName: 'srv',
      toolCallTimeoutMs: 60_000,
    }
    await syncTools(client as never, ctx, opts, new Map())
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    mockCallTool.mockRejectedValue(fetchFailure('ECONNREFUSED'))
    const failed = await executeTool(ctx, 'mcp__srv__remote')
    expect(failed.isError).toBe(true)
    // No handler, no supervisor: the call fails and the registry stands.
    expect(infos).toHaveLength(0)
    expect(instances).toHaveLength(1)
  })
})

describe('isTransportFailure', () => {
  it('classifies protocol-level responses as non-transport failures', () => {
    expect(isTransportFailure(new McpError(-32601, 'method not found'))).toBe(false)
  })

  it('classifies undici fetch failures by their wrapper message', () => {
    expect(isTransportFailure(fetchFailure())).toBe(true)
    expect(isTransportFailure(fetchFailure('ECONNREFUSED'))).toBe(true)
  })

  it('classifies network errors by a cause-chain error code', () => {
    const socket = new Error('socket closed')
    ;(socket as NodeJS.ErrnoException).code = 'UND_ERR_SOCKET'
    const outer = new Error('request failed')
    outer.cause = socket
    expect(isTransportFailure(outer)).toBe(true)
  })

  it('walks nested causes to reach the network error', () => {
    const socket = new Error('broken pipe')
    ;(socket as NodeJS.ErrnoException).code = 'EPIPE'
    const middle = new Error('upstream failed')
    middle.cause = socket
    const outer = new Error('request failed')
    outer.cause = middle
    expect(isTransportFailure(outer)).toBe(true)
  })

  it('ignores error codes outside the network family', () => {
    const notFound = new Error('no such file')
    ;(notFound as NodeJS.ErrnoException).code = 'ENOENT'
    const outer = new Error('request failed')
    outer.cause = notFound
    expect(isTransportFailure(outer)).toBe(false)
  })

  it('ignores rejections without an Error cause chain', () => {
    expect(isTransportFailure(new Error('plain failure'))).toBe(false)
    expect(isTransportFailure('fetch failed')).toBe(false)
  })
})
