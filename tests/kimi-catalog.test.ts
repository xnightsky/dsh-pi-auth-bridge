/** Kimi 目录回归：使用真实 pi-ai 验证桥接与面板清单，不读用户配置或调用网络。 */
import { describe, expect, it, vi } from 'vitest'
import { PiAuthBridgeAdapter } from '../src/bridge/adapter.js'
import type { RouteDef } from '../src/bridge/convert.js'
import { fillModelLists } from '../src/panel/model-list.js'
import { bridgedStatus, createStatusBox } from '../src/panel/status.js'

const routes: RouteDef[] = [{
  route: 'pi/kimi-coding',
  providerId: 'kimi-coding',
  kind: 'builtin',
  displayName: 'Pi · kimi-coding',
  apiKey: 'test-kimi-key',
  models: [],
}]
const k31Models = ['k3.1-pro', 'k3.1-pro-highspeed']

describe('Kimi K3.1 catalog', () => {
  it.each(k31Models)('lists and resolves %s through the real SDK', async (id) => {
    const warn = vi.fn()
    const adapter = new PiAuthBridgeAdapter(routes, undefined, { warn })
    expect(adapter.routes).toContain('pi/kimi-coding')
    expect(await adapter.listModels('pi/kimi-coding')).toContainEqual(expect.objectContaining({
      provider: 'pi/kimi-coding', id, inputModalities: ['text', 'image'],
    }))
    const resolved = await adapter.resolveModel('pi/kimi-coding', id)
    expect(resolved).toMatchObject({ provider: 'pi/kimi-coding', id, inputModalities: ['text', 'image'] })
    expect(resolved.context?.contextWindow).toBeGreaterThan(0)
    expect(resolved.reasoning?.efforts.length).toBeGreaterThan(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('fills the panel model list with both K3.1 models and existing Kimi models', async () => {
    const warn = vi.fn()
    const adapter = new PiAuthBridgeAdapter(routes, undefined, { warn })
    const box = createStatusBox(bridgedStatus({
      piDir: 'fixture', routes, proxy: { enabled: false, detected: false }, warnings: [],
    }))
    await fillModelLists(adapter, box, warn)
    expect(box.current.routes[0]?.modelList).toEqual(expect.arrayContaining(
      [...k31Models, 'k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'].map((id) =>
        expect.objectContaining({ id, contextWindow: expect.any(Number), input: ['text', 'image'] }),
      ),
    ))
    expect(warn).not.toHaveBeenCalled()
    expect(JSON.stringify(box.current)).not.toContain('test-kimi-key')
  })
})
