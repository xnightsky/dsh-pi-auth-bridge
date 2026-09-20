import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TYPERT } from '../src/typert/host.js'
import { TYPERT_REMOTE } from '../src/typert/remote-client.js'
import { probeInvocation, statusInvocation } from '../src/typert/common.js'
import { bridgedStatus, emptyStatus } from '../src/panel/status.js'
import type { RouteDef } from '../src/bridge/convert.js'

const ROUTE: RouteDef = {
  route: 'pi/acme',
  providerId: 'acme',
  kind: 'custom',
  displayName: 'Pi · Acme',
  api: 'openai-completions',
  apiKey: 'sk-artifact-canary',
  models: [{ id: 'acme-large' }],
}

describe('typert artifacts', () => {
  it('host manifest registers into a real TypertRegistry without rejection', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    // register() 重复注册会拒绝；真实 loader 的逐项字段校验先于 registry，
    // 这里至少锁定 registry 侧（包身份/schema/invocation/endpoint 唯一性与结构）。
    const dispose = ctx.typert.register(TYPERT as never)
    const endpoints = ctx.typert.local.list().map((descriptor) => descriptor.id)
    expect(endpoints).toContain('dsh-pi-auth-bridge#piAuthBridge/status')
    expect(endpoints).toContain('dsh-pi-auth-bridge#piAuthBridge/probe')
    await dispose()
    expect(ctx.typert.local.list()).toHaveLength(0)
  })

  it('remote contribution mounts the same descriptors the host registers', () => {
    expect(TYPERT_REMOTE.package).toBe('dsh-pi-auth-bridge')
    expect(TYPERT_REMOTE.descriptors).toEqual([statusInvocation, probeInvocation])
  })

  it('result codec round-trips every real BridgeStatus shape without drift', () => {
    const schema = statusInvocation.result.mode === 'strict' ? statusInvocation.result.create() : undefined
    expect(schema).toBeDefined()
    const snapshots = [
      bridgedStatus({
        piDir: '/home/u/.pi/agent',
        routes: [ROUTE],
        proxy: { enabled: true, detected: true },
        warnings: ['w1'],
      }),
      emptyStatus('llm-missing', 'no llm'),
      emptyStatus('pi-dir-not-found', 'not found', { proxy: { enabled: false, detected: false }, warnings: ['w2'] }),
      emptyStatus('pi-config-unreadable', 'bad json', { piDir: '/x' }),
      emptyStatus('no-credentials', 'none', { piDir: '/x' }),
      emptyStatus('no-servable-routes', 'none servable', { piDir: '/x' }),
    ]
    for (const snapshot of snapshots) {
      // 严格编解码过边界后必须与原快照深度一致（防 status.ts 与产物漂移）。
      expect(schema!.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
    }
  })

  it('result codec never carries credential material across the boundary', () => {
    const schema = statusInvocation.result.mode === 'strict' ? statusInvocation.result.create() : undefined
    const snapshot = bridgedStatus({
      piDir: '/x',
      routes: [ROUTE],
      proxy: { enabled: false, detected: false },
      warnings: [],
    })
    expect(JSON.stringify(schema!.parse(JSON.parse(JSON.stringify(snapshot))))).not.toContain('sk-artifact-canary')
  })

  it('probe codecs round-trips request and both result variants without drift', () => {
    const requestSchema = probeInvocation.parameters[0]?.codec.mode === 'strict' ? probeInvocation.parameters[0].codec.create() : undefined
    expect(requestSchema!.parse({ route: 'pi/acme', model: 'acme-large' })).toEqual({ route: 'pi/acme', model: 'acme-large' })
    // 按维度单测：可选 capability 过边界不丢失。
    expect(requestSchema!.parse({ route: 'pi/acme', model: 'acme-large', capability: 'image' })).toEqual({
      route: 'pi/acme',
      model: 'acme-large',
      capability: 'image',
    })

    const resultSchema = probeInvocation.result.mode === 'strict' ? probeInvocation.result.create() : undefined
    const report = {
      route: 'pi/acme',
      model: 'acme-large',
      at: 1_700_000_000_000,
      ok: false,
      latencyMs: 123,
      outcomes: [
        { capability: 'text', verdict: 'ok', latencyMs: 100, message: 'pong', detail: 'finish=stop · usage ✓ · 回复 "pong"' },
        { capability: 'image', verdict: 'skipped', latencyMs: 0 },
        { capability: 'reasoning', verdict: 'failed', latencyMs: 20, message: 'timeout', detail: 'exception=TimeoutError' },
        { capability: 'toolCall', verdict: 'inconclusive', latencyMs: 3 },
      ],
    }
    expect(resultSchema!.parse(JSON.parse(JSON.stringify({ ok: true, report })))).toEqual({ ok: true, report })
    const failure = { ok: false, route: 'pi/acme', model: 'acme-large', code: 'not-bridged', message: 'empty mount' }
    expect(resultSchema!.parse(JSON.parse(JSON.stringify(failure)))).toEqual(failure)
    // 判别联合拒绝未知形状。
    expect(() => resultSchema!.parse({ ok: true })).toThrow()
  })

  it('status codec round-trips model lists, self-health and cached probe reports', () => {
    const schema = statusInvocation.result.mode === 'strict' ? statusInvocation.result.create() : undefined
    const snapshot = {
      ...bridgedStatus({ piDir: '/x', routes: [ROUTE], proxy: { enabled: true, detected: false }, warnings: [] }),
      config: { includeOAuth: true, commandTimeoutMs: 10_000 },
      selfChecks: [{ id: 'dsh-llm-contract', ok: true }],
      recentErrors: [{ at: 1, route: 'pi/acme', code: 'REQUEST_FAILED', message: 'boom' }],
      versions: { plugin: '0.4.0' },
      probes: {
        'pi/acme\0acme-large': {
          route: 'pi/acme',
          model: 'acme-large',
          at: 2,
          ok: true,
          latencyMs: 9,
          outcomes: [{ capability: 'text', verdict: 'ok', latencyMs: 9 }],
        },
      },
    }
    expect(schema!.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
  })
})
