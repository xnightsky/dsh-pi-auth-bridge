import { describe, expect, it } from 'vitest'
import type {
  Api,
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent,
  Context as PiContext,
  FetchFunction,
  Model,
  SimpleStreamOptions,
  Usage as PiUsage,
} from '@earendil-works/pi-ai'
import { MessageId, type ContentBlock, type GenerateOptions, type Message as DshMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAuthBridgeAdapter } from '../src/adapter.js'
import type { PiModelsLike } from '../src/provider.js'
import type { RouteDef } from '../src/convert.js'
import { createEnvProxyFetch, hasProxyEnv } from '../src/proxy.js'

/* ------------------------------------------------------------------ */
/* hasProxyEnv / createEnvProxyFetch                                   */
/* ------------------------------------------------------------------ */

describe('hasProxyEnv', () => {
  it('detects each proxy variable family, lowercase and uppercase', () => {
    for (const name of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
      expect(hasProxyEnv({ [name]: 'http://127.0.0.1:7890' })).toBe(true)
    }
  })

  it('treats empty-string values as unset', () => {
    expect(hasProxyEnv({ http_proxy: '' })).toBe(false)
  })

  it('does not count no_proxy alone as proxy configuration', () => {
    expect(hasProxyEnv({ no_proxy: 'localhost', NO_PROXY: '127.0.0.1' })).toBe(false)
  })

  it('returns false when nothing proxy-related is set', () => {
    expect(hasProxyEnv({ PATH: '/usr/bin' })).toBe(false)
  })
})

describe('createEnvProxyFetch', () => {
  it('returns undefined when no proxy variable is set', () => {
    expect(createEnvProxyFetch({})).toBeUndefined()
    expect(createEnvProxyFetch({ no_proxy: 'localhost' })).toBeUndefined()
  })

  it('returns a fetch function when a proxy is configured', () => {
    const fetchFn = createEnvProxyFetch({ https_proxy: 'http://127.0.0.1:7890', no_proxy: 'localhost' })
    expect(typeof fetchFn).toBe('function')
  })
})

/* ------------------------------------------------------------------ */
/* Adapter injection                                                   */
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

function piAssistant(): PiAssistantMessage {
  const usage: PiUsage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'openai-completions',
    provider: 'openai' as PiAssistantMessage['provider'],
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: 0,
  }
}

class FakeModels implements PiModelsLike {
  captured: SimpleStreamOptions | undefined
  constructor(private readonly models: Model<Api>[]) {}
  getModel(provider: string, id: string): Model<Api> | undefined {
    return this.models.find((model) => model.provider === provider && model.id === id)
  }
  getModels(provider: string): readonly Model<Api>[] {
    return this.models.filter((model) => model.provider === provider)
  }
  async *streamSimple(_model: Model<Api>, _context: PiContext, options?: SimpleStreamOptions): AsyncGenerator<AssistantMessageEvent> {
    this.captured = options
    yield { type: 'done', reason: 'stop', message: piAssistant() }
  }
}

function genOptions(): GenerateOptions {
  const message: DshMessage = {
    id: MessageId('m1'),
    role: 'user',
    content: [{ type: 'text', text: 'hi' } as ContentBlock],
    source: { kind: 'user' },
  }
  return { provider: 'openai', model: 'test-model', messages: [message] }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const chunk of stream) void chunk
}

const proxyFetch = (() => Promise.reject(new Error('never called in tests'))) as unknown as FetchFunction

describe('proxy fetch injection', () => {
  it('injects the proxy fetch into stream options for regular routes', async () => {
    const fake = new FakeModels([fakeModel()])
    const adapter = new PiAuthBridgeAdapter([fakeRoute()], fake, { proxyFetch })
    await drain(adapter.stream(genOptions()))
    expect(fake.captured?.fetch).toBe(proxyFetch)
  })

  it('injects nothing when no proxy fetch is configured', async () => {
    const fake = new FakeModels([fakeModel()])
    const adapter = new PiAuthBridgeAdapter([fakeRoute()], fake)
    await drain(adapter.stream(genOptions()))
    expect(fake.captured?.fetch).toBeUndefined()
  })

  it('skips injection for google routes and warns once per route', async () => {
    const warnings: string[] = []
    const fake = new FakeModels([fakeModel({ api: 'google-generative-ai' })])
    const adapter = new PiAuthBridgeAdapter([fakeRoute()], fake, { proxyFetch, warn: (message) => warnings.push(message) })
    await drain(adapter.stream(genOptions()))
    await drain(adapter.stream(genOptions()))
    expect(fake.captured?.fetch).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('google-generative-ai')
    expect(warnings[0]).toContain('NODE_USE_ENV_PROXY')
  })

  it('skips injection for google-vertex routes', async () => {
    const warnings: string[] = []
    const fake = new FakeModels([fakeModel({ api: 'google-vertex' })])
    const adapter = new PiAuthBridgeAdapter([fakeRoute()], fake, { proxyFetch, warn: (message) => warnings.push(message) })
    await drain(adapter.stream(genOptions()))
    expect(fake.captured?.fetch).toBeUndefined()
    expect(warnings).toHaveLength(1)
  })
})
