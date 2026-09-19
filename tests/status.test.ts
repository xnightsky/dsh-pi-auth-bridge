import { describe, expect, it } from 'vitest'
import {
  bridgedStatus,
  createStatusBox,
  emptyStatus,
  routeStatusOf,
  type BridgeStatus,
} from '../src/status.js'
import type { RouteDef } from '../src/convert.js'

function route(overrides: Partial<RouteDef> = {}): RouteDef {
  return {
    route: 'pi/acme',
    providerId: 'acme',
    kind: 'custom',
    displayName: 'Pi · Acme',
    api: 'openai-completions',
    models: [{ id: 'acme-large' }, { id: 'acme-small' }],
    ...overrides,
  }
}

describe('routeStatusOf', () => {
  it('summarizes a custom api_key route without leaking the key', () => {
    const status = routeStatusOf(route({ apiKey: 'sk-canary-secret' }))
    expect(status).toEqual({
      id: 'pi/acme',
      provider: 'acme',
      kind: 'custom',
      api: 'openai-completions',
      credential: 'api_key',
      models: 2,
    })
    expect(JSON.stringify(status)).not.toContain('sk-canary-secret')
  })

  it('marks oauth routes and never copies token material', () => {
    const status = routeStatusOf(route({ oauth: { access: 'access-canary', refresh: 'refresh-canary' } }))
    expect(status.credential).toBe('oauth')
    const json = JSON.stringify(status)
    expect(json).not.toContain('access-canary')
    expect(json).not.toContain('refresh-canary')
  })

  it('marks credential-less local endpoints as none', () => {
    expect(routeStatusOf(route()).credential).toBe('none')
  })

  it('omits api for builtin catalog routes and reports zero declared models', () => {
    const builtin = route({ kind: 'builtin', models: [] })
    delete builtin.api
    const status = routeStatusOf(builtin)
    expect(status.kind).toBe('builtin')
    expect('api' in status).toBe(false)
    expect(status.models).toBe(0)
  })
})

describe('emptyStatus', () => {
  it('records the reason and detail for an empty mount', () => {
    const status = emptyStatus('pi-dir-not-found', 'looked at $PI_CODING_AGENT_DIR and ~/.pi/agent')
    expect(status).toEqual({
      phase: 'empty',
      reason: 'pi-dir-not-found',
      detail: 'looked at $PI_CODING_AGENT_DIR and ~/.pi/agent',
      routes: [],
      proxy: { enabled: false, detected: false },
      warnings: [],
    })
  })

  it('keeps partial information gathered before the bailout', () => {
    const status = emptyStatus('no-credentials', 'no usable provider credentials', {
      piDir: '/home/u/.pi/agent',
      proxy: { enabled: true, detected: true },
      warnings: ['w1'],
    })
    expect(status.piDir).toBe('/home/u/.pi/agent')
    expect(status.proxy).toEqual({ enabled: true, detected: true })
    expect(status.warnings).toEqual(['w1'])
  })
})

describe('bridgedStatus', () => {
  it('assembles the full snapshot and never leaks credential material', () => {
    const status = bridgedStatus({
      piDir: '/home/u/.pi/agent',
      routes: [route({ apiKey: 'sk-canary-secret' })],
      proxy: { enabled: true, detected: false },
      warnings: ['pi-auth-bridge: sample warning'],
    })
    expect(status.phase).toBe('bridged')
    expect(status.piDir).toBe('/home/u/.pi/agent')
    expect(status.routes).toHaveLength(1)
    expect(status.warnings).toEqual(['pi-auth-bridge: sample warning'])
    expect(JSON.stringify(status)).not.toContain('sk-canary-secret')
  })
})

describe('createStatusBox', () => {
  it('holds a mutable current snapshot', () => {
    const box = createStatusBox(emptyStatus('llm-missing', 'no llm service'))
    expect(box.current.phase).toBe('empty')
    const next: BridgeStatus = bridgedStatus({
      piDir: '/x',
      routes: [],
      proxy: { enabled: false, detected: false },
      warnings: [],
    })
    box.current = next
    expect(box.current.phase).toBe('bridged')
  })
})
