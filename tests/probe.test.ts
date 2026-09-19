import { describe, expect, it } from 'vitest'
import type {
  Api,
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent,
  Context as PiContext,
  Model,
  SimpleStreamOptions,
  Usage as PiUsage,
} from '@earendil-works/pi-ai'
import { PiAuthBridgeAdapter } from '../src/adapter.js'
import { createProbeHandler, probeModel } from '../src/probe.js'
import type { PiModelsLike } from '../src/provider.js'
import type { RouteDef } from '../src/convert.js'

/* ---------------- 与 adapter.test.ts 同款的最小 fixture ---------------- */

function fakeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: 'test-model',
    name: 'Test Model',
    api: 'openai-completions',
    provider: 'openai' as Model<Api>['provider'],
    baseUrl: 'https://api.example/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    ...overrides,
  }
}

function fakeRoute(overrides: Partial<RouteDef> = {}): RouteDef {
  return {
    route: 'openai',
    providerId: 'openai',
    kind: 'builtin',
    displayName: 'OpenAI (pi)',
    apiKey: 'sk-test',
    models: [],
    ...overrides,
  }
}

function piUsage(input = 10, output = 5): PiUsage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function piAssistant(overrides: Partial<PiAssistantMessage> = {}): PiAssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'pong' }],
    api: 'openai-completions',
    provider: 'openai' as PiAssistantMessage['provider'],
    model: 'test-model',
    usage: piUsage(),
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  }
}

function textDone(text = 'pong', stopReason: PiAssistantMessage['stopReason'] = 'stop'): AssistantMessageEvent[] {
  return [
    { type: 'start', partial: piAssistant({ content: [] }) },
    { type: 'text_delta', contentIndex: 0, delta: text, partial: piAssistant() },
    { type: 'done', reason: 'stop', message: piAssistant({ content: [{ type: 'text', text }], stopReason }) },
  ]
}

class FakeModels implements PiModelsLike {
  captured: { context: PiContext; options: SimpleStreamOptions | undefined }[] = []
  constructor(
    private readonly models: Model<Api>[],
    private readonly events: () => AsyncIterable<AssistantMessageEvent>,
  ) {}
  getModel(provider: string, id: string): Model<Api> | undefined {
    return this.models.find((model) => model.provider === provider && model.id === id)
  }
  getModels(provider: string): readonly Model<Api>[] {
    return this.models.filter((model) => model.provider === provider)
  }
  streamSimple(model: Model<Api>, context: PiContext, options?: SimpleStreamOptions): AsyncIterable<AssistantMessageEvent> {
    this.captured.push({ context, options })
    return this.events()
  }
}

async function* eventsOf(events: AssistantMessageEvent[]): AsyncGenerator<AssistantMessageEvent> {
  for (const event of events) yield event
}

function makeAdapter(
  events: AssistantMessageEvent[] | (() => AsyncIterable<AssistantMessageEvent>),
  modelOverrides: Partial<Model<Api>> = {},
): { adapter: PiAuthBridgeAdapter; fake: FakeModels } {
  const fake = new FakeModels([fakeModel(modelOverrides)], typeof events === 'function' ? events : () => eventsOf(events))
  return { adapter: new PiAuthBridgeAdapter([fakeRoute()], fake), fake }
}

/* ---------------- 用例 ---------------- */

describe('probeModel', () => {
  it('runs the full suite through the real pipeline: text ok, image/reasoning skipped, toolCall ok', async () => {
    const toolEvents: AssistantMessageEvent[] = [
      { type: 'start', partial: piAssistant({ content: [] }) },
      {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: piAssistant({ content: [{ type: 'toolCall', id: 'c1', name: 'probe_echo', arguments: {} }] }),
      },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"value":"ok"}', partial: piAssistant() },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'c1', name: 'probe_echo', arguments: { value: 'ok' } },
        partial: piAssistant(),
      },
      { type: 'done', reason: 'toolUse', message: piAssistant({ stopReason: 'toolUse', content: [] }) },
    ]
    // text → 文本事件；image/reasoning 跳过不发请求；toolCall → 工具事件。
    let call = 0
    const { adapter, fake } = makeAdapter(() => eventsOf(call++ === 0 ? textDone() : toolEvents))
    const report = await probeModel(adapter, 'openai', 'test-model')

    expect(report.ok).toBe(true)
    expect(report.outcomes).toHaveLength(4)
    const byCapability = Object.fromEntries(report.outcomes.map((outcome) => [outcome.capability, outcome]))
    expect(byCapability.text).toMatchObject({ verdict: 'ok', message: 'pong' })
    expect(byCapability.image).toMatchObject({ verdict: 'skipped' })
    expect(byCapability.reasoning).toMatchObject({ verdict: 'skipped' })
    expect(byCapability.toolCall).toMatchObject({ verdict: 'ok' })
    // 只发了 text 与 toolCall 两次真实请求。
    expect(fake.captured).toHaveLength(2)
    expect(fake.captured[0]?.options?.maxTokens).toBe(16)
    expect(fake.captured[1]?.options?.maxTokens).toBe(128)
    expect(fake.captured[1]?.context.tools?.[0]?.name).toBe('probe_echo')
  })

  it('probes image input through the attachment conversion path with a validated target', async () => {
    const { adapter, fake } = makeAdapter(textDone('red'), { input: ['text', 'image'] })
    const report = await probeModel(adapter, 'openai', 'test-model')
    const image = report.outcomes.find((outcome) => outcome.capability === 'image')
    expect(image).toMatchObject({ verdict: 'ok' })
    // 图片经完整转换路径：pi 上下文里是内联 base64 image 块（假 reader 返回 1×1 PNG）。
    const imageRequest = fake.captured.find(({ context }) =>
      context.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'image')),
    )
    expect(imageRequest).toBeDefined()
  })

  it('probes reasoning with the lowest supported effort', async () => {
    const { adapter, fake } = makeAdapter(textDone('42'), { reasoning: true })
    await probeModel(adapter, 'openai', 'test-model')
    const reasoningRequest = fake.captured.find(({ options }) => options?.reasoning !== undefined)
    expect(reasoningRequest?.options?.reasoning).toBe('low')
    expect(reasoningRequest?.options?.maxTokens).toBe(1024)
  })

  it('marks an upstream error as a failed outcome without throwing', async () => {
    const { adapter } = makeAdapter([
      { type: 'start', partial: piAssistant({ content: [] }) },
      { type: 'error', reason: 'error', error: piAssistant({ stopReason: 'error', errorMessage: '401 invalid api key', content: [] }) },
    ])
    const report = await probeModel(adapter, 'openai', 'test-model')
    expect(report.ok).toBe(false)
    const text = report.outcomes.find((outcome) => outcome.capability === 'text')
    expect(text).toMatchObject({ verdict: 'failed' })
    expect(text?.message).toContain('401 invalid api key')
  })

  it('marks a text-only answer to the tool probe as inconclusive', async () => {
    const { adapter } = makeAdapter(textDone('I cannot call tools'))
    const report = await probeModel(adapter, 'openai', 'test-model')
    const toolCall = report.outcomes.find((outcome) => outcome.capability === 'toolCall')
    expect(toolCall).toMatchObject({ verdict: 'inconclusive' })
    // inconclusive 不算失败。
    expect(report.ok).toBe(true)
  })

  it('probes a single dimension on request, with diagnostic details attached', async () => {
    const { adapter, fake } = makeAdapter(textDone('red'), { input: ['text', 'image'] })
    const report = await probeModel(adapter, 'openai', 'test-model', 'image')
    expect(report.outcomes).toHaveLength(1)
    expect(report.outcomes[0]).toMatchObject({ capability: 'image', verdict: 'ok' })
    expect(report.outcomes[0]?.detail).toContain('target=')
    expect(report.outcomes[0]?.detail).toContain('finish=stop')
    // 只发了图片这一次请求。
    expect(fake.captured).toHaveLength(1)
  })

  it('records the exception type in detail when a probe throws', async () => {
    const { adapter } = makeAdapter(() => {
      throw new Error('socket hang up')
    })
    const report = await probeModel(adapter, 'openai', 'test-model', 'text')
    expect(report.outcomes[0]).toMatchObject({ verdict: 'failed', message: 'socket hang up' })
    expect(report.outcomes[0]?.detail).toContain('exception=')
  })
})

describe('createProbeHandler', () => {
  it('maps an unknown route or model to a business failure with the adapter code', async () => {
    const { adapter } = makeAdapter(textDone())
    const handler = createProbeHandler(adapter)
    const routeResult = await handler({ route: 'pi/nope', model: 'test-model' })
    expect(routeResult).toMatchObject({ ok: false, code: 'NO_ADAPTER' })
    const modelResult = await handler({ route: 'openai', model: 'no-such' })
    expect(modelResult).toMatchObject({ ok: false, code: 'UNKNOWN_MODEL' })
  })

  it('writes start and per-dimension lines to the probe logger', async () => {
    const { adapter } = makeAdapter(textDone())
    const lines: string[] = []
    const handler = createProbeHandler(adapter, { info: (m) => lines.push(m), warn: (m) => lines.push(m) })
    const result = await handler({ route: 'openai', model: 'test-model', capability: 'text' })
    expect(result.ok).toBe(true)
    expect(lines.some((line) => line.includes('（单维 text）开始'))).toBe(true)
    expect(lines.some((line) => line.includes('text → ok') && line.includes('finish=stop'))).toBe(true)
  })
})
