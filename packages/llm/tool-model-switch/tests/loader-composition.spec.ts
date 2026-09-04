/**
 * REAL-composition tier (packages/AGENTS.md): boot a test-only cordis.yml
 * through the Loader — the same mechanism the app uses — with the real tool
 * registry and a stand-in `sessionController` service, and assert the
 * model-visible surface: the registered schemas and the rendered tool results.
 * The stand-in replaces only the web-surface BFF controller (its full
 * dependency stack is external to this package); everything between the
 * composition file and the tool result is the product path.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ModelCatalog, SessionSelectModelRequest } from '@deepseek-ai/dsh-api-session-controller'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolModelSwitch from '@deepseek-ai/dsh-tool-model-switch'

const CATALOG: ModelCatalog = {
  default: { provider: 'llama-cpp', model: 'Qwen3.8-27b-Samantha-NVFP4' },
  routableProviders: ['llama-cpp'],
  groups: [{
    id: 'llama-cpp',
    name: 'llama-cpp',
    models: [{ id: 'Qwen3.8-27B-Ridge', name: 'Ridge', description: '27B Ridge fine-tune' }],
  }],
  failures: [],
}

/** Boot-level observation of the stand-in controller, read by the assertions. */
const mockState: { selectCalls: SessionSelectModelRequest[]; catalogCalls: number } = { selectCalls: [], catalogCalls: 0 }

/**
 * Test-only stand-in for the web-surface `sessionController` service: the same
 * two methods the tools delegate to, backed by a fixed catalog.
 */
const MockSessionController = {
  name: 'mock-session-controller',
  apply(ctx: Context): void {
    ctx.provide('sessionController', {
      async selectModel(request: SessionSelectModelRequest) {
        mockState.selectCalls.push(request)
        return {
          selected: {
            provider: request.provider,
            model: request.model,
            ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
          },
        }
      },
      async modelCatalog(): Promise<ModelCatalog> {
        mockState.catalogCalls += 1
        return CATALOG
      },
    })
  },
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  mockState.selectCalls = []
  mockState.catalogCalls = 0
})

function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('model-switch-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml carrying the tool package, optionally beside the stand-in
 * controller.
 * @param withController - whether the composition mounts the stand-in service.
 * @returns the booted context.
 */
async function boot(withController: boolean): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-model-switch-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-model-switch'",
    ...(withController ? ["- name: 'mock-session-controller'"] : []),
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-model-switch', ToolModelSwitch],
    ['mock-session-controller', MockSessionController],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('tool-model-switch through a real Loader composition', () => {
  it('switch_model delegates the normalized request and renders the selection', async () => {
    const ctx = await boot(true)
    const owner = agent(ctx)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('loader-switch'),
      name: 'switch_model',
      arguments: { provider: 'llama-cpp', model: 'Qwen3.8-27B-Ridge', reasoning_effort: 'high' },
      agent: owner,
    })
    expect(result.isError).toBe(false)
    expect(mockState.selectCalls).toEqual([{
      sessionId: owner.id, provider: 'llama-cpp', model: 'Qwen3.8-27B-Ridge', reasoningEffort: 'high',
    }])
    expect(resultText(result)).toBe(
      'Switched this session\'s model to llama-cpp/Qwen3.8-27B-Ridge (reasoning effort high). '
      + 'Effective from the next model request; the default for new sessions now matches this selection.',
    )
  }, 30_000)

  it('list_models renders the catalog through the composed service', async () => {
    const ctx = await boot(true)
    const owner = agent(ctx)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('loader-list'),
      name: 'list_models',
      arguments: {},
      agent: owner,
    })
    expect(result.isError).toBe(false)
    expect(mockState.catalogCalls).toBe(1)
    expect(resultText(result)).toBe([
      'Default: llama-cpp/Qwen3.8-27b-Samantha-NVFP4',
      'llama-cpp',
      '  Qwen3.8-27B-Ridge — 27B Ridge fine-tune',
    ].join('\n'))
  }, 30_000)

  it('a controller-less composition fails both calls at call time', async () => {
    const ctx = await boot(false)
    const owner = agent(ctx)
    const switched = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('loader-no-controller-switch'),
      name: 'switch_model',
      arguments: { provider: 'llama-cpp', model: 'Qwen3.8-27B-Ridge' },
      agent: owner,
    })
    expect(switched.isError).toBe(true)
    expect(resultText(switched)).toContain('switch_model: the session controller is not available in this deployment')
    const listed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('loader-no-controller-list'),
      name: 'list_models',
      arguments: {},
      agent: owner,
    })
    expect(listed.isError).toBe(true)
    expect(resultText(listed)).toContain('list_models: the session controller is not available in this deployment')
    expect(mockState.selectCalls).toEqual([])
    expect(mockState.catalogCalls).toBe(0)
  }, 30_000)
})
