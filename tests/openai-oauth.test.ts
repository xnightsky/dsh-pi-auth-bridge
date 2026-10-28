/**
 * 新版 openai OAuth 跨边界回归：真实 pi-ai + 合成凭据 + 拦截 fetch。
 * 不读取真实 pi、不访问外网；fixture 文件与面板均不得收到轮换凭据。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchFunction } from '@earendil-works/pi-ai'
import { MessageId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { readPiAuth, type PiModelsFile } from '../src/pi/auth.js'
import { buildRoutes, type RouteDef } from '../src/bridge/convert.js'
import { PiAuthBridgeAdapter } from '../src/bridge/adapter.js'
import { routeStatusOf } from '../src/panel/status.js'

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000
const CLIENT_ID = 'synthetic-issued-client'
const INITIAL_ACCESS = 'synthetic-access'
const INITIAL_REFRESH = 'synthetic-refresh'
const SCOPES = ['chatgpt.tokens.use.direct']
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-openai-oauth-test-'))
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.stubEnv('OPENAI_API_KEY', 'sk-synthetic-ambient-must-not-win')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function credential(expires = NOW + HOUR) {
  return {
    type: 'oauth', access: INITIAL_ACCESS, refresh: INITIAL_REFRESH,
    expires, clientId: CLIENT_ID, scopes: SCOPES,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function textResponse(): Response {
  const events = [
    { type: 'response.output_item.done', output_index: 0, item: {
      id: 'msg_synthetic', type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    } },
    { type: 'response.completed', response: {
      id: 'resp_synthetic', status: 'completed',
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    } },
  ]
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function refreshEndpoint() {
  const forms: URLSearchParams[] = []
  const fetch = vi.fn<FetchFunction>(async (input, init) => {
    const request = new Request(input, init)
    expect(request.url).toBe('https://auth.openai.com/api/accounts/oauth/token')
    forms.push(new URLSearchParams(await request.text()))
    return jsonResponse({
      access_token: `synthetic-access-${forms.length}`,
      refresh_token: `synthetic-refresh-${forms.length}`,
      expires_in: 3600, scope: SCOPES.join(' '),
    })
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, forms }
}

function harness(entry: unknown = credential(), models?: PiModelsFile) {
  const path = join(dir, 'auth.json')
  const original = JSON.stringify({ openai: entry })
  writeFileSync(path, original)
  const routes = buildRoutes(readPiAuth(dir), models, { resolve: (value) => value, warn: () => {} })
  const requests: { url: string; authorization: string | null; body: Record<string, unknown> }[] = []
  const fetch = vi.fn<FetchFunction>(async (input, init) => {
    const request = new Request(input, init)
    requests.push({
      url: request.url, authorization: request.headers.get('authorization'),
      body: await request.json() as Record<string, unknown>,
    })
    return textResponse()
  })
  const adapter = new PiAuthBridgeAdapter(routes, undefined, { proxyFetch: fetch })
  return { adapter, routes, requests, fetch, path, original }
}

function options(): GenerateOptions {
  return {
    provider: 'pi/openai', model: 'gpt-5', maxTokens: 128, temperature: 0.3,
    messages: [{
      id: MessageId('synthetic-user'), role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    }],
  }
}

async function run(adapter: PiAuthBridgeAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options())) chunks.push(chunk)
  return chunks
}

function expectSuccess(chunks: StreamChunk[]): void {
  expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  expect(chunks.at(-2)?.type).toBe('usage')
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'block-end', block: { type: 'text', text: 'ok' } }))
}

describe('new openai OAuth', () => {
  it('uses OAuth on the immediate first request instead of racing ambient API-key lookup', async () => {
    const refresh = refreshEndpoint()
    const h = harness()
    expectSuccess(await run(h.adapter))
    expect(h.requests[0]?.authorization).toBe(`Bearer ${INITIAL_ACCESS}`)
    expect(refresh.fetch).not.toHaveBeenCalled()
    expect(h.routes[0]?.oauth).toMatchObject({ clientId: CLIENT_ID, scopes: SCOPES })
    expect(h.routes[0]?.apiKey).toBeUndefined()
  })

  it('refreshes a startup-expired credential with its issued client ID', async () => {
    const refresh = refreshEndpoint()
    const h = harness(credential(NOW - 1))
    expectSuccess(await run(h.adapter))
    expect(refresh.fetch).toHaveBeenCalledTimes(1)
    expect(refresh.forms[0]?.get('client_id')).toBe(CLIENT_ID)
    expect(refresh.forms[0]?.get('refresh_token')).toBe(INITIAL_REFRESH)
    expect(refresh.forms[0]?.get('grant_type')).toBe('refresh_token')
    expect(h.requests[0]?.authorization).toBe('Bearer synthetic-access-1')
  })

  it('refreshes after startup and reuses the rotated refresh token on the next expiry', async () => {
    const refresh = refreshEndpoint()
    const h = harness()
    expectSuccess(await run(h.adapter))
    vi.mocked(Date.now).mockReturnValue(NOW + HOUR)
    expectSuccess(await run(h.adapter))
    expectSuccess(await run(h.adapter))
    expect(refresh.fetch).toHaveBeenCalledTimes(1)
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * HOUR)
    expectSuccess(await run(h.adapter))
    expect(refresh.fetch).toHaveBeenCalledTimes(2)
    expect(refresh.forms[1]?.get('refresh_token')).toBe('synthetic-refresh-1')
    expect(refresh.forms[1]?.get('client_id')).toBe(CLIENT_ID)
    expect(h.requests.map((request) => request.authorization)).toEqual([
      `Bearer ${INITIAL_ACCESS}`, 'Bearer synthetic-access-1', 'Bearer synthetic-access-1', 'Bearer synthetic-access-2',
    ])
    expect(readFileSync(h.path, 'utf8')).toBe(h.original)
  })

  it('lets the SDK refresh once for concurrent requests in the same process', async () => {
    const refresh = refreshEndpoint()
    const h = harness(credential(NOW - 1))
    const results = await Promise.all([run(h.adapter), run(h.adapter), run(h.adapter)])
    for (const chunks of results) expectSuccess(chunks)
    expect(refresh.fetch).toHaveBeenCalledTimes(1)
    expect(h.requests).toHaveLength(3)
    expect(h.requests.every((request) => request.authorization === 'Bearer synthetic-access-1')).toBe(true)
  })

  it('preserves ChatGPT-specific parameter handling behind the pi/openai route', async () => {
    refreshEndpoint()
    const h = harness()
    expectSuccess(await run(h.adapter))
    expect(h.requests[0]?.url).toBe('https://api.openai.com/v1/responses')
    expect(h.requests[0]?.body).not.toHaveProperty('temperature')
    expect(h.requests[0]?.body).not.toHaveProperty('max_output_tokens')
    expect(h.adapter.routes).toEqual(['pi/openai'])
    expect((await h.adapter.listModels('pi/openai'))[0]?.provider).toBe('pi/openai')
  })

  it('keeps OpenAI semantics when models.json explicitly selects the Responses protocol', async () => {
    refreshEndpoint()
    const h = harness(credential(), { providers: { openai: {
      api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-5' }],
    } } })
    expectSuccess(await run(h.adapter))
    expect(h.requests[0]?.body).not.toHaveProperty('temperature')
    expect(h.requests[0]?.body).not.toHaveProperty('max_output_tokens')
  })

  it('keeps API-key requests on the API-key parameter path', async () => {
    const refresh = refreshEndpoint()
    const h = harness({ type: 'api_key', key: 'sk-synthetic-explicit' })
    expectSuccess(await run(h.adapter))
    expect(h.requests[0]?.authorization).toBe('Bearer sk-synthetic-explicit')
    expect(h.requests[0]?.body).toMatchObject({ temperature: 0.3, max_output_tokens: 128 })
    expect(refresh.fetch).not.toHaveBeenCalled()
  })

  it('terminates on refresh failure without falling back to the ambient API key', async () => {
    const refresh = refreshEndpoint()
    refresh.fetch.mockImplementation(async () => jsonResponse({ error: 'invalid_grant' }, 400))
    const h = harness(credential(NOW - 1))
    const chunks = await run(h.adapter)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(refresh.fetch).toHaveBeenCalledTimes(1)
    expect(h.fetch).not.toHaveBeenCalled()
    expect(readFileSync(h.path, 'utf8')).toBe(h.original)
  })

  it('reports missing OpenAI metadata through the SDK without network access or key fallback', async () => {
    const refresh = refreshEndpoint()
    const { clientId: _clientId, ...incomplete } = credential(NOW - 1)
    const h = harness(incomplete)
    const chunks = await run(h.adapter)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish', reason: { kind: 'error', failure: { message: expect.stringContaining('client ID') } },
    })
    expect(refresh.fetch).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('never projects OAuth metadata or refreshed credentials into the panel', async () => {
    refreshEndpoint()
    const h = harness(credential(NOW - 1))
    expectSuccess(await run(h.adapter))
    const route = h.routes[0]
    if (route === undefined) throw new Error('missing fixture route')
    const status = routeStatusOf(route)
    expect(status.credential).toBe('oauth')
    const snapshot = JSON.stringify(status)
    for (const secret of [INITIAL_ACCESS, INITIAL_REFRESH, CLIENT_ID, ...SCOPES, 'synthetic-access-1', 'synthetic-refresh-1']) {
      expect(snapshot).not.toContain(secret)
    }
    expect(readFileSync(h.path, 'utf8')).toBe(h.original)
  })

  it('skips a refreshable route when its catalog provider has no OAuth handler', () => {
    const warnings: string[] = []
    const routes: RouteDef[] = [{
      route: 'pi/deepseek', providerId: 'deepseek', kind: 'builtin', displayName: 'Pi · deepseek',
      models: [], oauth: { access: INITIAL_ACCESS, refresh: INITIAL_REFRESH, expires: NOW + HOUR },
    }]
    const adapter = new PiAuthBridgeAdapter(routes, undefined, { warn: (message) => warnings.push(message) })
    expect(adapter.routes).toEqual([])
    expect(warnings.join('\n')).toContain('OAuth')
    expect(warnings.join('\n')).not.toContain(INITIAL_REFRESH)
  })
})
