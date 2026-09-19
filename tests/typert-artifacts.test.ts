import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TYPERT } from '../src/typert.host.js'
import { TYPERT_REMOTE } from '../src/typert.remote-client.js'
import { statusInvocation } from '../src/typert-common.js'
import { bridgedStatus, emptyStatus } from '../src/status.js'
import type { RouteDef } from '../src/convert.js'

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
    await dispose()
    expect(ctx.typert.local.list()).toHaveLength(0)
  })

  it('remote contribution mounts the same descriptor the host registers', () => {
    expect(TYPERT_REMOTE.package).toBe('dsh-pi-auth-bridge')
    expect(TYPERT_REMOTE.descriptors).toEqual([statusInvocation])
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
})
