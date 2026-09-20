import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PiAuthBridgeStatusService } from '../src/panel/status-service.js'
import { bridgedStatus, createStatusBox, emptyStatus } from '../src/panel/status.js'
import type { RouteDef } from '../src/bridge/convert.js'

const ROUTE: RouteDef = {
  route: 'pi/acme',
  providerId: 'acme',
  kind: 'custom',
  displayName: 'Pi · Acme',
  api: 'openai-completions',
  apiKey: 'sk-service-canary',
  models: [{ id: 'acme-large' }],
}

describe('PiAuthBridgeStatusService', () => {
  it('mounts into a real cordis composition and serves the box snapshot', async () => {
    const ctx = new Context()
    const box = createStatusBox(emptyStatus('pi-dir-not-found', 'not found'))
    const fiber = await ctx.plugin(PiAuthBridgeStatusService, box)
    await expect(ctx.piAuthBridge.status()).resolves.toMatchObject({ phase: 'empty', reason: 'pi-dir-not-found' })

    box.current = bridgedStatus({
      piDir: '/x',
      routes: [ROUTE],
      proxy: { enabled: true, detected: false },
      warnings: [],
    })
    const status = await ctx.piAuthBridge.status()
    expect(status).toMatchObject({ phase: 'bridged', routes: [{ id: 'pi/acme', credential: 'api_key' }] })
    expect(JSON.stringify(status)).not.toContain('sk-service-canary')
    await fiber.dispose()
  })

  it('exposes the typertRemote binding under the piAuthBridge key', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(PiAuthBridgeStatusService, createStatusBox(emptyStatus('llm-missing', 'x')))
    expect(ctx.piAuthBridge.typertRemote).toMatchObject({ serviceKey: 'piAuthBridge', namespace: 'piAuthBridge' })
    await fiber.dispose()
  })

  it('returns not-bridged for probe when the box has no probe handler', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(PiAuthBridgeStatusService, createStatusBox(emptyStatus('llm-missing', 'x')))
    await expect(ctx.piAuthBridge.probe({ route: 'pi/acme', model: 'acme-large' })).resolves.toMatchObject({
      ok: false,
      code: 'not-bridged',
    })
    await fiber.dispose()
  })

  it('delegates probe to the box handler when bridged', async () => {
    const ctx = new Context()
    const box = createStatusBox(emptyStatus('llm-missing', 'x'))
    box.probe = (request) =>
      Promise.resolve({
        ok: true,
        report: { route: request.route, model: request.model, at: 1, ok: true, latencyMs: 3, outcomes: [] },
      })
    const fiber = await ctx.plugin(PiAuthBridgeStatusService, box)
    await expect(ctx.piAuthBridge.probe({ route: 'pi/acme', model: 'acme-large' })).resolves.toMatchObject({
      ok: true,
      report: { route: 'pi/acme', model: 'acme-large' },
    })
    await fiber.dispose()
  })
})
