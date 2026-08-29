import { describe, expect, it } from 'vitest'
import { buildRoutes } from '../src/convert.js'
import type { PiAuthEntry, PiModelsFile } from '../src/pi-auth.js'

const NOW = 1_800_000_000_000

function defaults(overrides: Partial<Parameters<typeof buildRoutes>[2]> = {}): Parameters<typeof buildRoutes>[2] {
  const warnings: string[] = []
  return {
    resolve: (raw) => raw,
    warn: (message) => warnings.push(message),
    now: NOW,
    ...overrides,
  }
}

function warned(warnings: string[], fragment: string): void {
  expect(warnings.join('\n')).toContain(fragment)
}

describe('buildRoutes', () => {
  it('creates a builtin route for an auth.json api_key provider', () => {
    const auth: Record<string, PiAuthEntry> = { openai: { type: 'api_key', key: 'sk-1' } }
    const routes = buildRoutes(auth, undefined, defaults())
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      route: 'pi/openai',
      providerId: 'openai',
      kind: 'builtin',
      displayName: 'Pi · openai',
      apiKey: 'sk-1',
      models: [],
    })
  })

  it('maps a models.json custom provider with every field', () => {
    const models: PiModelsFile = {
      providers: {
        acme: {
          baseUrl: 'https://acme.example/v1',
          api: 'openai-completions',
          apiKey: 'sk-acme',
          authHeader: true,
          name: 'Acme Gateway',
          headers: { 'x-team': 'blue' },
          models: [{ id: 'acme-large', contextWindow: 65536 }],
        },
      },
    }
    const routes = buildRoutes(undefined, models, defaults())
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      route: 'pi/acme',
      kind: 'custom',
      displayName: 'Pi · Acme Gateway',
      apiKey: 'sk-acme',
      api: 'openai-completions',
      baseURL: 'https://acme.example/v1',
      authHeader: true,
      headers: { 'x-team': 'blue' },
      models: [{ id: 'acme-large', contextWindow: 65536 }],
    })
  })

  it('prefers the auth.json key over the models.json apiKey', () => {
    const auth: Record<string, PiAuthEntry> = { acme: { type: 'api_key', key: 'sk-from-auth' } }
    const models: PiModelsFile = {
      providers: { acme: { baseUrl: 'https://acme.example/v1', api: 'openai-completions', apiKey: 'sk-from-models', models: [{ id: 'm' }] } },
    }
    const routes = buildRoutes(auth, models, defaults())
    expect(routes[0]?.apiKey).toBe('sk-from-auth')
    expect(routes[0]?.kind).toBe('custom')
  })

  it('falls back to the models.json apiKey when the auth.json key cannot resolve', () => {
    const auth: Record<string, PiAuthEntry> = { acme: { type: 'api_key', key: '$UNSET_VAR' } }
    const models: PiModelsFile = {
      providers: { acme: { baseUrl: 'https://acme.example/v1', api: 'openai-completions', apiKey: 'sk-from-models', models: [{ id: 'm' }] } },
    }
    const routes = buildRoutes(auth, models, defaults({
      resolve: (raw) => (raw.startsWith('$') ? undefined : raw),
    }))
    expect(routes[0]?.apiKey).toBe('sk-from-models')
  })

  it('bridges an unexpired OAuth access token as an api key', () => {
    const auth: Record<string, PiAuthEntry> = { anthropic: { type: 'oauth', access: 'acc-token', refresh: 'ref', expires: NOW + 60_000 } }
    const routes = buildRoutes(auth, undefined, defaults())
    expect(routes[0]).toMatchObject({ route: 'pi/anthropic', apiKey: 'acc-token' })
    expect(routes[0]?.oauth).toBeUndefined()
  })

  it('treats an OAuth entry without expires as unexpired', () => {
    const auth: Record<string, PiAuthEntry> = { anthropic: { type: 'oauth', access: 'acc-token' } }
    const routes = buildRoutes(auth, undefined, defaults())
    expect(routes[0]?.apiKey).toBe('acc-token')
  })

  it('hands an expired OAuth entry with a refresh token to pi-ai (in memory)', () => {
    const auth: Record<string, PiAuthEntry> = { anthropic: { type: 'oauth', access: 'old-acc', refresh: 'ref-token', expires: NOW - 60_000 } }
    const routes = buildRoutes(auth, undefined, defaults())
    expect(routes[0]?.apiKey).toBeUndefined()
    expect(routes[0]?.oauth).toEqual({ access: 'old-acc', refresh: 'ref-token', expires: NOW - 60_000 })
  })

  it('skips an expired OAuth entry without a refresh token, with a warn', () => {
    const warnings: string[] = []
    const auth: Record<string, PiAuthEntry> = { anthropic: { type: 'oauth', access: 'old-acc', expires: NOW - 60_000 } }
    const routes = buildRoutes(auth, undefined, defaults({ warn: (m) => warnings.push(m) }))
    expect(routes).toHaveLength(0)
    warned(warnings, 'expired')
  })

  it('skips OAuth entries when includeOAuth is false', () => {
    const warnings: string[] = []
    const auth: Record<string, PiAuthEntry> = { anthropic: { type: 'oauth', access: 'acc' } }
    const routes = buildRoutes(auth, undefined, defaults({ includeOAuth: false, warn: (m) => warnings.push(m) }))
    expect(routes).toHaveLength(0)
    warned(warnings, 'includeOAuth')
  })

  it('applies the providers whitelist', () => {
    const auth: Record<string, PiAuthEntry> = {
      openai: { type: 'api_key', key: 'sk-1' },
      anthropic: { type: 'api_key', key: 'sk-2' },
    }
    const routes = buildRoutes(auth, undefined, defaults({ providers: ['anthropic'] }))
    expect(routes.map((route) => route.route)).toEqual(['pi/anthropic'])
  })

  it('always names routes with the fixed pi/ prefix and brands the display name with Pi', () => {
    const auth: Record<string, PiAuthEntry> = { openai: { type: 'api_key', key: 'sk-1' } }
    const routes = buildRoutes(auth, undefined, defaults())
    expect(routes[0]?.route).toBe('pi/openai')
    expect(routes[0]?.providerId).toBe('openai')
    expect(routes[0]?.displayName).toBe('Pi · openai')
  })

  it('skips an auth-only provider whose key cannot resolve, with a warn', () => {
    const warnings: string[] = []
    const auth: Record<string, PiAuthEntry> = { openai: { type: 'api_key', key: '$UNSET_VAR' } }
    const routes = buildRoutes(auth, undefined, defaults({
      resolve: (raw) => (raw.startsWith('$') ? undefined : raw),
      warn: (m) => warnings.push(m),
    }))
    expect(routes).toHaveLength(0)
    warned(warnings, 'no usable credential')
  })

  it('keeps a keyless models.json provider (local endpoint) without a credential', () => {
    const models: PiModelsFile = {
      providers: { local: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', models: [{ id: 'llama3' }] } },
    }
    const routes = buildRoutes(undefined, models, defaults())
    expect(routes).toHaveLength(1)
    expect(routes[0]?.apiKey).toBeUndefined()
  })

  it('resolves header values and drops unresolvable ones with a warn', () => {
    const warnings: string[] = []
    const models: PiModelsFile = {
      providers: {
        acme: {
          baseUrl: 'https://acme.example/v1',
          api: 'openai-completions',
          headers: { 'x-team': '$TEAM', 'x-static': 'yes' },
          models: [{ id: 'm' }],
        },
      },
    }
    const routes = buildRoutes(undefined, models, defaults({
      resolve: (raw) => (raw === '$TEAM' ? undefined : raw),
      warn: (m) => warnings.push(m),
    }))
    expect(routes[0]?.headers).toEqual({ 'x-static': 'yes' })
    warned(warnings, 'x-team')
  })
})
