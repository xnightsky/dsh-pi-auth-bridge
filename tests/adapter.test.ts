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
import {
  attributionHeaders,
  LlmError,
  MessageId,
  type ContentBlock,
  type GenerateOptions,
  type Message as DshMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { PiBridgeAdapter, toPiContext, type PiModelsLike } from '../src/adapter.js'
import type { RouteDef } from '../src/convert.js'

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

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

function piUsage(input = 10, output = 5, cacheRead = 0, cacheWrite = 0): PiUsage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function piAssistant(overrides: Partial<PiAssistantMessage> = {}): PiAssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello' }],
    api: 'openai-completions',
    provider: 'openai' as PiAssistantMessage['provider'],
    model: 'test-model',
    usage: piUsage(),
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  }
}

async function* eventsOf(events: AssistantMessageEvent[]): AsyncGenerator<AssistantMessageEvent> {
  for (const event of events) yield event
}

class FakeModels implements PiModelsLike {
  captured: { context: PiContext; options: SimpleStreamOptions | undefined } | undefined
  constructor(
    private readonly models: Model<Api>[],
    private readonly events: (options?: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>,
  ) {}
  getModel(provider: string, id: string): Model<Api> | undefined {
    return this.models.find((model) => model.provider === provider && model.id === id)
  }
  getModels(provider: string): readonly Model<Api>[] {
    return this.models.filter((model) => model.provider === provider)
  }
  streamSimple(model: Model<Api>, context: PiContext, options?: SimpleStreamOptions): AsyncIterable<AssistantMessageEvent> {
    this.captured = { context, options }
    return this.events(options)
  }
}

let messageSeq = 0
function dshMessage(role: DshMessage['role'], content: ContentBlock[], source?: DshMessage['source']): DshMessage {
  messageSeq += 1
  return {
    id: MessageId(`m${messageSeq}`),
    role,
    content,
    source: source ?? (role === 'assistant' ? { kind: 'model', provider: 'openai', model: 'test-model' } : { kind: 'user' }),
  }
}

function genOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'openai',
    model: 'test-model',
    messages: [dshMessage('user', [{ type: 'text', text: 'hello' }])],
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function makeAdapter(
  events: AssistantMessageEvent[] | ((options?: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>),
  routeOverrides: Partial<RouteDef> = {},
  modelOverrides: Partial<Model<Api>> = {},
): { adapter: PiBridgeAdapter; fake: FakeModels } {
  const fake = new FakeModels([fakeModel(modelOverrides)], typeof events === 'function' ? events : () => eventsOf(events))
  return { adapter: new PiBridgeAdapter([fakeRoute(routeOverrides)], fake), fake }
}

/* ------------------------------------------------------------------ */
/* Stream protocol                                                     */
/* ------------------------------------------------------------------ */

describe('PiBridgeAdapter stream protocol', () => {
  it('translates a text turn: block-start → deltas → block-end → usage → finish', async () => {
    const done: AssistantMessageEvent = {
      type: 'done',
      reason: 'stop',
      message: piAssistant({ usage: piUsage(12, 7, 3, 2) }),
    }
    const { adapter } = makeAdapter([
      { type: 'start', partial: piAssistant({ content: [] }) },
      { type: 'text_start', contentIndex: 0, partial: piAssistant() },
      { type: 'text_delta', contentIndex: 0, delta: 'Hel', partial: piAssistant() },
      { type: 'text_delta', contentIndex: 0, delta: 'lo', partial: piAssistant() },
      { type: 'text_end', contentIndex: 0, content: 'Hello', partial: piAssistant() },
      done,
    ])
    const chunks = await collect(adapter.stream(genOptions()))
    expect(chunks.map((chunk) => chunk.type)).toEqual(['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks[3]).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } })
    // usage before finish, nothing after finish
    expect(chunks[4]).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 } })
    expect(chunks[5]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('translates tool calls with raw-JSON argumentsDelta streaming', async () => {
    const partial = piAssistant({ content: [{ type: 'toolCall', id: 'call_1', name: 'get_weather', arguments: {} }] })
    const { adapter } = makeAdapter([
      { type: 'start', partial },
      { type: 'toolcall_start', contentIndex: 0, partial },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"city":', partial },
      { type: 'toolcall_delta', contentIndex: 0, delta: '"Paris"}', partial },
      { type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }, partial },
      { type: 'done', reason: 'toolUse', message: piAssistant({ stopReason: 'toolUse', content: partial.content }) },
    ])
    const chunks = await collect(adapter.stream(genOptions()))
    expect(chunks.map((chunk) => chunk.type)).toEqual(['block-start', 'tool-call-delta', 'tool-call-delta', 'block-end', 'usage', 'finish'])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks[1]).toMatchObject({ type: 'tool-call-delta', index: 0, name: 'get_weather', argumentsDelta: '{"city":' })
    expect(chunks[2]).toMatchObject({ type: 'tool-call-delta', index: 0, argumentsDelta: '"Paris"}' })
    const end = chunks[3]
    if (end?.type !== 'block-end') throw new Error('expected block-end')
    expect(end.block.type).toBe('tool-call')
    if (end.block.type === 'tool-call') {
      expect(end.block.name).toBe('get_weather')
      expect(typeof end.block.arguments).toBe('string')
      expect(JSON.parse(end.block.arguments)).toEqual({ city: 'Paris' })
    }
    expect(chunks[5]).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('translates thinking blocks into reasoning chunks', async () => {
    const { adapter } = makeAdapter([
      { type: 'start', partial: piAssistant({ content: [] }) },
      { type: 'thinking_start', contentIndex: 0, partial: piAssistant() },
      { type: 'thinking_delta', contentIndex: 0, delta: 'hmm', partial: piAssistant() },
      { type: 'thinking_end', contentIndex: 0, content: 'hmm', partial: piAssistant() },
      { type: 'done', reason: 'stop', message: piAssistant({ content: [{ type: 'thinking', thinking: 'hmm' }] }) },
    ])
    const chunks = await collect(adapter.stream(genOptions()))
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: 'hmm' })
    expect(chunks[2]).toEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hmm' } })
  })

  it('maps pi-ai error events to finish chunks with classified codes', async () => {
    const { adapter } = makeAdapter([
      { type: 'start', partial: piAssistant({ content: [] }) },
      { type: 'error', reason: 'error', error: piAssistant({ stopReason: 'error', errorMessage: 'HTTP 401 unauthorized', content: [] }) },
    ])
    const chunks = await collect(adapter.stream(genOptions()))
    expect(chunks.map((chunk) => chunk.type)).toEqual(['usage', 'finish'])
    expect(chunks[1]).toEqual({ type: 'finish', reason: { kind: 'error', failure: { message: 'HTTP 401 unauthorized', code: 'AUTH' } } })
  })

  it('maps pi-ai aborted events to an aborted finish', async () => {
    const { adapter } = makeAdapter([
      { type: 'error', reason: 'aborted', error: piAssistant({ stopReason: 'aborted', errorMessage: 'user aborted', content: [] }) },
    ])
    const chunks = await collect(adapter.stream(genOptions()))
    expect(chunks[1]).toEqual({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'user aborted', code: 'ABORTED' } } })
  })

  it('maps length to max-tokens', async () => {
    const { adapter } = makeAdapter([
      { type: 'done', reason: 'length', message: piAssistant({ stopReason: 'length' }) },
    ])
    const chunks = await collect(adapter.stream(genOptions()))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('throws LlmError STREAM_CLOSED when the event stream ends without a terminal event', async () => {
    const { adapter } = makeAdapter([{ type: 'start', partial: piAssistant({ content: [] }) }])
    await expect(collect(adapter.stream(genOptions()))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})

/* ------------------------------------------------------------------ */
/* Option validation                                                   */
/* ------------------------------------------------------------------ */

describe('PiBridgeAdapter option validation', () => {
  it('rejects GenerateOptions.stop with UNSUPPORTED_OPTION', async () => {
    const { adapter } = makeAdapter([])
    await expect(collect(adapter.stream(genOptions({ stop: ['###'] })))).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPTION',
    })
  })

  it('rejects image attachments with UNSUPPORTED_OPTION', async () => {
    const { adapter } = makeAdapter([])
    const image = { type: 'image', attachment: { attachmentId: 'a1' } } as unknown as ContentBlock
    await expect(collect(adapter.stream(genOptions({ messages: [dshMessage('user', [image])] })))).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPTION',
    })
  })

  it('rejects an unknown provider route with NO_ADAPTER', async () => {
    const { adapter } = makeAdapter([])
    await expect(collect(adapter.stream(genOptions({ provider: 'nope' })))).rejects.toMatchObject({ code: 'NO_ADAPTER' })
  })

  it('rejects an unknown model with UNKNOWN_MODEL', async () => {
    const { adapter } = makeAdapter([])
    await expect(collect(adapter.stream(genOptions({ model: 'nope' })))).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  })

  it('rejects an unsupported reasoning effort', async () => {
    const { adapter } = makeAdapter([])
    const options: GenerateOptions = { ...genOptions(), reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] & string }
    await expect(collect(adapter.stream(options))).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  })

  it('honors the caller signal: abort mid-stream throws LlmError ABORTED', async () => {
    const controller = new AbortController()
    const hanging = (options?: SimpleStreamOptions) =>
      (async function* (): AsyncGenerator<AssistantMessageEvent> {
        yield { type: 'start', partial: piAssistant({ content: [] }) }
        while (options?.signal?.aborted === false) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        throw new Error('The operation was aborted')
      })()
    const { adapter } = makeAdapter(hanging)
    const stream = adapter.stream(genOptions({ signal: controller.signal }))
    const iterator = stream[Symbol.asyncIterator]()
    const first = iterator.next()
    setTimeout(() => controller.abort(), 20)
    await expect(first).rejects.toMatchObject({ code: 'ABORTED' })
  })
})

/* ------------------------------------------------------------------ */
/* Request plumbing                                                    */
/* ------------------------------------------------------------------ */

describe('PiBridgeAdapter request plumbing', () => {
  it('passes the resolved api key, sampling options, and attribution headers to pi-ai', async () => {
    const { adapter, fake } = makeAdapter(
      [{ type: 'done', reason: 'stop', message: piAssistant() }],
      { headers: { 'x-team': 'blue' } },
    )
    await collect(adapter.stream(genOptions({ temperature: 0.3, maxTokens: 128, system: 'be brief' })))
    const captured = fake.captured
    expect(captured).toBeDefined()
    expect(captured?.options?.apiKey).toBe('sk-test')
    expect(captured?.options?.temperature).toBe(0.3)
    expect(captured?.options?.maxTokens).toBe(128)
    expect(captured?.options?.headers).toMatchObject({ 'x-team': 'blue' })
    for (const [name, value] of Object.entries(attributionHeaders())) {
      expect(captured?.options?.headers?.[name]).toBe(value)
    }
    expect(captured?.options?.signal).toBeInstanceOf(AbortSignal)
    expect(captured?.context.systemPrompt).toBe('be brief')
    expect(captured?.context.messages).toEqual([{ role: 'user', content: 'hello', timestamp: 0 }])
  })

  it('converts assistant tool-calls and tool results into pi-ai history', () => {
    const context = toPiContext(genOptions({
      messages: [
        dshMessage('user', [{ type: 'text', text: 'weather?' }]),
        dshMessage('assistant', [
          { type: 'text', text: 'checking' },
          { type: 'tool-call', id: 'call_1' as ContentBlock extends never ? never : never, name: 'get_weather', arguments: '{"city":"Paris"}' } as unknown as ContentBlock,
        ]),
        dshMessage('user', [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'sunny' }] } as unknown as ContentBlock,
        ], { kind: 'tool', callId: 'call_1' as never } as DshMessage['source']),
      ],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
    }))
    expect(context.messages).toHaveLength(3)
    const assistant = context.messages[1]
    expect(assistant?.role).toBe('assistant')
    if (assistant?.role === 'assistant') {
      const toolCall = assistant.content.find((block) => block.type === 'toolCall')
      expect(toolCall).toMatchObject({ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } })
    }
    const toolResult = context.messages[2]
    expect(toolResult).toMatchObject({ role: 'toolResult', toolCallId: 'call_1', toolName: 'get_weather', isError: false })
    expect(context.tools).toHaveLength(1)
  })

  it('flattens a system-role history message into a user message', () => {
    const context = toPiContext(genOptions({
      messages: [dshMessage('system', [{ type: 'text', text: 'context snapshot' }], { kind: 'plugin', plugin: 'test' } as DshMessage['source'])],
    }))
    expect(context.messages).toEqual([{ role: 'user', content: 'context snapshot', timestamp: 0 }])
  })
})

/* ------------------------------------------------------------------ */
/* Catalog surface                                                     */
/* ------------------------------------------------------------------ */

describe('PiBridgeAdapter catalog surface', () => {
  it('describes provider info and models', async () => {
    const { adapter } = makeAdapter([])
    expect(adapter.providerInfo('openai')).toEqual({ id: 'openai', name: 'OpenAI (pi)' })
    expect(await adapter.listModels('openai')).toEqual([
      { provider: 'openai', id: 'test-model', name: 'Test Model', inputModalities: ['text'] },
    ])
    const resolved = await adapter.resolveModel('openai', 'test-model')
    expect(resolved).toMatchObject({ provider: 'openai', id: 'test-model', context: { contextWindow: 128_000 } })
    expect(resolved.reasoning).toBeUndefined()
  })

  it('exposes reasoning efforts for reasoning models', async () => {
    const { adapter } = makeAdapter([], {}, { reasoning: true })
    const resolved = await adapter.resolveModel('openai', 'test-model')
    expect(resolved.reasoning?.efforts.length).toBeGreaterThan(0)
  })

  it('throws for provider routes it does not own', async () => {
    const { adapter } = makeAdapter([])
    expect(() => adapter.providerInfo('nope')).not.toThrow()
    await expect(adapter.listModels('nope')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect(adapter.resolveModel('nope', 'x')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
  })

  it('surfaces LlmError instances from stream failures', async () => {
    const { adapter } = makeAdapter([])
    try {
      await collect(adapter.stream(genOptions({ stop: ['x'] })))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).failure.code).toBe('UNSUPPORTED_OPTION')
    }
  })
})
