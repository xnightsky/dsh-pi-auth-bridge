// @vitest-environment jsdom
/// <reference lib="dom" />
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, PiAuthBridgeSection } from '../src/client/index.js'
import { bridgedStatus, emptyStatus } from '../src/status.js'
import type { BridgeStatus } from '../src/status.js'
import type { RouteDef } from '../src/convert.js'

afterEach(cleanup)

const ROUTE: RouteDef = {
  route: 'pi/acme',
  providerId: 'acme',
  kind: 'custom',
  displayName: 'Pi · Acme',
  api: 'openai-completions',
  apiKey: 'sk-client-canary',
  models: [{ id: 'acme-large' }, { id: 'acme-small' }],
}

function bridged(): BridgeStatus {
  return bridgedStatus({
    piDir: '/home/u/.pi/agent',
    routes: [ROUTE],
    proxy: { enabled: true, detected: true },
    warnings: ['pi-auth-bridge: sample warning'],
  })
}

describe('PiAuthBridgeSection', () => {
  it('renders the bridged snapshot: badge, routes, proxy, and warnings', async () => {
    const { container } = render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(bridged())} />)
    await waitFor(() => screen.getByText('已桥接'))
    expect(screen.getByText('pi/acme')).toBeTruthy()
    expect(screen.getByText('models.json')).toBeTruthy()
    expect(screen.getByText('API Key')).toBeTruthy()
    expect(screen.getByText('/home/u/.pi/agent')).toBeTruthy()
    expect(screen.getByText(/已检测到代理变量/)).toBeTruthy()
    expect(screen.getByText('pi-auth-bridge: sample warning')).toBeTruthy()
    // 凭据本体绝不进面板。
    expect(container.textContent).not.toContain('sk-client-canary')
  })

  it('renders the empty phase with the localized reason', async () => {
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(emptyStatus('pi-dir-not-found', 'not found'))} />)
    await waitFor(() => screen.getByText('空挂载'))
    expect(screen.getByText(/未找到 pi 配置目录/)).toBeTruthy()
  })

  it('renders the failure state when the remote call rejects', async () => {
    render(<PiAuthBridgeSection loadStatus={() => Promise.reject(new Error('carrier down'))} />)
    await waitFor(() => screen.getByText(/carrier down/))
  })
})

describe('client apply', () => {
  it('declares service inject, mounts the contribution, and parks the panel on the namespace service', () => {
    expect(inject).toEqual(['slots', 'remote'])
    const mounted: unknown[] = []
    const plugged: { name: string; inject: string[]; apply: (ctx: Context) => void }[] = []
    const ctx = {
      logger: () => ({ warn: () => {} }),
      remote: {
        $mount: (contribution: unknown) => {
          mounted.push(contribution)
          return Promise.resolve(() => Promise.resolve())
        },
      },
      plugin: (plugin: { name: string; inject: string[]; apply: (ctx: Context) => void }) => {
        plugged.push(plugin)
      },
    } as unknown as Context

    apply(ctx)

    // 主插件只挂载贡献；面板注册在 park 于 remote.piAuthBridge 的子插件里。
    expect(mounted).toHaveLength(1)
    expect((mounted[0] as { package: string }).package).toBe('dsh-pi-auth-bridge')
    expect(plugged).toHaveLength(1)
    expect(plugged[0]?.inject).toContain('remote.piAuthBridge')
  })

  it('registers the settings section once the namespace service is available', () => {
    const status: BridgeStatus = bridged()
    const registered: { options: Record<string, unknown>; component: unknown }[] = []
    let child: { apply: (ctx: Context) => void } | undefined
    const ctx = {
      logger: () => ({ warn: () => {} }),
      remote: { $mount: () => Promise.resolve(() => Promise.resolve()) },
      plugin: (plugin: { apply: (ctx: Context) => void }) => {
        child = plugin
      },
    } as unknown as Context
    apply(ctx)

    const panelCtx = {
      remote: {
        piAuthBridge: { status: () => Promise.resolve({ ok: true, value: status }) },
      },
      slots: {
        inject: (_slot: string, callback: () => void) => callback(),
        register: (options: Record<string, unknown>, component: unknown) => {
          registered.push({ options, component })
          return () => {}
        },
      },
    } as unknown as Context
    child?.apply(panelCtx)

    expect(registered).toHaveLength(1)
    expect(registered[0]?.options).toMatchObject({ name: 'settings.section', id: 'pi-auth-bridge' })
    expect(typeof registered[0]?.component).toBe('function')
    // loadStatus 解包 RemoteResult。
    const face = (registered[0]?.options.inject as () => { loadStatus: () => Promise<BridgeStatus> })()
    return expect(face.loadStatus()).resolves.toBe(status)
  })
})
