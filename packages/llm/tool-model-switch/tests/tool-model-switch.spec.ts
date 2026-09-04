/**
 * Unit tier for the two model-routing tools: registration surface, delegation
 * to the `sessionController` service, the pinned model-visible result texts,
 * and the call-time failures of a controller-less deployment. The controller
 * itself is a test stand-in; the real service is exercised by the
 * loader-composition spec.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ModelCatalog, SessionSelectModelRequest } from '@deepseek-ai/dsh-api-session-controller'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolModelSwitch from '@deepseek-ai/dsh-tool-model-switch'

/** The catalog every list_models assertion renders against. */
const CATALOG: ModelCatalog = {
  default: { provider: 'llama-cpp', model: 'Qwen3.8-27b-Samantha-NVFP4' },
  routableProviders: ['llama-cpp', 'openai'],
  groups: [
    {
      id: 'llama-cpp',
      name: 'llama-cpp',
      models: [
        { id: 'Qwen3.8-27B-Ridge', name: 'Ridge', description: '27B Ridge fine-tune' },
        { id: 'Qwen3.8-27b-Samantha-NVFP4', name: 'Samantha' },
      ],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      models: [{ id: 'gpt-x', name: 'GPT-X', description: 'cloud model' }],
    },
  ],
  failures: [{ id: 'anthropic', name: 'Anthropic', message: 'catalog load failed' }],
}

interface MockControllerState {
  selectCalls: SessionSelectModelRequest[]
  catalogCalls: number
}

/** One controller stand-in recording its calls and optionally failing selectModel. */
function mockController(selectError?: Error): { state: MockControllerState; controller: unknown } {
  const state: MockControllerState = { selectCalls: [], catalogCalls: 0 }
  const controller = {
    async selectModel(request: SessionSelectModelRequest) {
      state.selectCalls.push(request)
      if (selectError !== undefined) throw selectError
      return {
        selected: {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
        },
      }
    },
    async modelCatalog(): Promise<ModelCatalog> {
      state.catalogCalls += 1
      return CATALOG
    },
  }
  return { state, controller }
}

interface Bench {
  ctx: Context
  agent: Agent
  mock: MockControllerState
}

/** Boot tools + agent registry, mount the tool package, and optionally serve the controller. */
async function harness(withController: boolean, selectError?: Error): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const mock = mockController(selectError)
  if (withController) ctx.provide('sessionController', mock.controller)
  await ctx.plugin(ToolModelSwitch)
  const id = SessionId('model-switch-agent')
  const agent = { id, session: Session.create(id), status: 'idle', ctx } as Agent
  ctx.agents.register(agent)
  return { ctx, agent, mock: mock.state }
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('dsh-tool-model-switch registration', () => {
  it('registers switch_model and list_models with the pinned descriptions', async () => {
    const { ctx } = await harness(true)
    const schemas = Object.fromEntries(ctx.tools.schemas().map(schema => [schema.name, schema]))
    expect(schemas['switch_model']?.description).toContain('Switch the LLM model that this session runs on')
    expect(schemas['switch_model']?.description).toContain('Call list_models first')
    expect(schemas['list_models']?.description).toBe('List the LLM providers and models this deployment can route to, the current default selection, and any providers whose catalog failed to load. Call it before switch_model.')
    const switchSchema = ctx.tools.schemas().find(schema => schema.name === 'switch_model')
    const parameters = switchSchema?.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined
    const props = parameters?.properties ?? {}
    expect(Object.keys(props)).toEqual(['provider', 'model', 'reasoning_effort'])
    expect(props['provider']).toEqual(expect.objectContaining({ type: 'string' }))
    expect(props['model']).toEqual(expect.objectContaining({ type: 'string' }))
    expect(props['reasoning_effort']).toEqual(expect.objectContaining({ type: 'string' }))
    expect(parameters?.required).toEqual(['provider', 'model'])
    expect(schemas['list_models']?.parameters?.properties ?? {}).toEqual({})
    expect(ctx.tools.get('switch_model')?.presentCall?.({ provider: 'llama-cpp', model: 'Qwen3.8-27B-Ridge' })).toEqual({
      card: 'generic', title: 'Switch session model', kind: 'other', rawInput: { provider: 'llama-cpp', model: 'Qwen3.8-27B-Ridge' },
    })
    expect(ctx.tools.get('list_models')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'List available models', kind: 'other', rawInput: {},
    })
  })

  it('unloading the tool fiber removes both tools (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(ToolModelSwitch)
    const names = () => ctx.tools.schemas().map(schema => schema.name)
    expect(names()).toEqual(expect.arrayContaining(['switch_model', 'list_models']))
    await fiber.dispose()
    expect(names()).not.toEqual(expect.arrayContaining(['switch_model', 'list_models']))
  })
})

describe('switch_model', () => {
  it('delegates the normalized request to the controller and renders the selection', async () => {
    const { ctx, agent, mock } = await harness(true)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('switch-plain'),
      name: 'switch_model',
      arguments: { provider: 'llama-cpp', model: 'Qwen3.8-27B-Ridge' },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(mock.selectCalls).toEqual([{ sessionId: agent.id, provider: 'llama-cpp', model: 'Qwen3.8-27B-Ridge' }])
    expect(resultText(result)).toBe(
      'Switched this session\'s model to llama-cpp/Qwen3.8-27B-Ridge. '
      + 'Effective from the next model request; the default for new sessions now matches this selection.',
    )
  })

  it('carries reasoning_effort through and renders it when the controller echoes it back', async () => {
    const { ctx, agent, mock } = await harness(true)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('switch-effort'),
      name: 'switch_model',
      arguments: { provider: 'llama-cpp', model: 'Qwen3.8-27B-Ridge', reasoning_effort: 'high' },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(mock.selectCalls).toEqual([{ sessionId: agent.id, provider: 'llama-cpp', model: 'Qwen3.8-27B-Ridge', reasoningEffort: 'high' }])
    expect(resultText(result)).toBe(
      'Switched this session\'s model to llama-cpp/Qwen3.8-27B-Ridge (reasoning effort high). '
      + 'Effective from the next model request; the default for new sessions now matches this selection.',
    )
  })

  it('omits an empty-string reasoning_effort from the request', async () => {
    const { ctx, agent, mock } = await harness(true)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('switch-empty-effort'),
      name: 'switch_model',
      arguments: { provider: 'llama-cpp', model: 'Qwen3.8-27B-Ridge', reasoning_effort: '' },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(mock.selectCalls).toEqual([{ sessionId: agent.id, provider: 'llama-cpp', model: 'Qwen3.8-27B-Ridge' }])
  })

  it('rejects a call without an owning agent session', async () => {
    const { ctx } = await harness(true)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('switch-no-agent'),
      name: 'switch_model',
      arguments: { provider: 'llama-cpp', model: 'Qwen3.8-27B-Ridge' },
    })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('switch_model: no agent context for this call')
  })

  it('fails at call time in a controller-less deployment', async () => {
    const { ctx, agent, mock } = await harness(false)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('switch-no-controller'),
      name: 'switch_model',
      arguments: { provider: 'llama-cpp', model: 'Qwen3.8-27B-Ridge' },
      agent,
    })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('switch_model: the session controller is not available in this deployment')
    expect(mock.selectCalls).toEqual([])
  })

  it('propagates the controller rejection', async () => {
    const unavailable = new Error('session/model-unavailable: llama-cpp has no model nope')
    const { ctx, agent } = await harness(true, unavailable)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('switch-unavailable'),
      name: 'switch_model',
      arguments: { provider: 'llama-cpp', model: 'nope' },
      agent,
    })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('session/model-unavailable: llama-cpp has no model nope')
  })
})

describe('list_models', () => {
  it('renders the default, the provider groups, and the catalog failures', async () => {
    const { ctx, agent, mock } = await harness(true)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('list-1'),
      name: 'list_models',
      arguments: {},
      agent,
    })
    expect(result.isError).toBe(false)
    expect(mock.catalogCalls).toBe(1)
    expect(resultText(result)).toBe([
      'Default: llama-cpp/Qwen3.8-27b-Samantha-NVFP4',
      'llama-cpp',
      '  Qwen3.8-27B-Ridge — 27B Ridge fine-tune',
      '  Qwen3.8-27b-Samantha-NVFP4',
      'openai (OpenAI):',
      '  gpt-x — cloud model',
      'unavailable: anthropic — catalog load failed',
    ].join('\n'))
  })

  it('fails at call time in a controller-less deployment', async () => {
    const { ctx, agent, mock } = await harness(false)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('list-no-controller'),
      name: 'list_models',
      arguments: {},
      agent,
    })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('list_models: the session controller is not available in this deployment')
    expect(mock.catalogCalls).toBe(0)
  })
})
