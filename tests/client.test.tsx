// @vitest-environment jsdom
/// <reference lib="dom" />
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, PiAuthBridgeSection } from '../src/client/index.js'
import type { PiAuthBridgePanelFace } from '../src/client/index.js'
import { bridgedStatus, emptyStatus, probeKey } from '../src/panel/status.js'
import type { BridgeStatus, ModelProbeReport, ProbeRequest, ProbeResult } from '../src/panel/status.js'
import type { RouteDef } from '../src/bridge/convert.js'
import { subagentForm } from './subagent-form-fixture.js'

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
    warnings: ['dsh-pi-auth-bridge: sample warning'],
  })
}

const noProbe = () => Promise.reject<ProbeResult>(new Error('probe not expected'))

describe('PiAuthBridgeSection', () => {
  it('edits model authorization through the shared Host form without probing', async () => {
    const other = { provider: 'native', model: 'keep-me' }
    const fixture = subagentForm({ enabled: true, allowedModels: [other] })
    const status = bridged()
    status.routes[0]!.modelList = [{ id: 'acme-large', input: ['text'] }]
    const probe = vi.fn(noProbe)
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(status)} probe={probe} getSubagentForm={() => fixture.form} />)
    const toggle = await screen.findByLabelText('允许子智能体使用 pi/acme/acme-large') as HTMLInputElement
    await waitFor(() => expect(toggle.disabled).toBe(false))
    fireEvent.click(toggle)
    expect(toggle.checked).toBe(true)
    expect(fixture.mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存子智能体授权' }))
    await waitFor(() => expect(fixture.form.getSnapshot().value?.allowedModels).toEqual([other, { provider: 'pi/acme', model: 'acme-large' }]))
    expect(probe).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: '保存子智能体授权' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables authorization editing on a read-only Host but retains bridge diagnostics', async () => {
    const fixture = subagentForm({ enabled: false, allowedModels: [] })
    fixture.update({ writable: false })
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(bridged())} probe={noProbe} getSubagentForm={() => fixture.form} />)
    await screen.findByText(/授权设置只读/)
    expect((screen.getByRole('switch', { name: '允许 Agent 为子智能体选择模型' }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText('已桥接')).toBeTruthy()
    expect(fixture.mutate).not.toHaveBeenCalled()
  })

  it('shows settings-service failures without losing bridge status', async () => {
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(bridged())} probe={noProbe} getSubagentForm={() => { throw new Error('settings offline') }} />)
    await screen.findByText(/无法读取子智能体授权：settings offline/)
    expect(screen.getByText('已桥接')).toBeTruthy()
  })

  it('surfaces concurrent official-page edits and discards stale grants', async () => {
    const fixture = subagentForm({ enabled: true, allowedModels: [{ provider: 'native', model: 'existing' }] })
    const status = bridged()
    status.routes[0]!.modelList = [{ id: 'acme-large', input: ['text'] }]
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(status)} probe={noProbe} getSubagentForm={() => fixture.form} />)
    const toggle = await screen.findByLabelText('允许子智能体使用 pi/acme/acme-large') as HTMLInputElement
    fireEvent.click(toggle)
    act(() => { fixture.update({ revision: 8, value: { enabled: true, allowedModels: [{ provider: 'native', model: 'updated' }] } }) })
    expect(screen.getByRole('alert').textContent).toContain('授权已在其他页面更新')
    expect((screen.getByRole('button', { name: '保存子智能体授权' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消授权修改' }))
    expect(toggle.checked).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fixture.mutate).not.toHaveBeenCalled()
  })

  it('does not save an enabled policy with an empty allowlist', async () => {
    const fixture = subagentForm({ enabled: false, allowedModels: [] })
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(bridged())} probe={noProbe} getSubagentForm={() => fixture.form} />)
    await screen.findByText('当前显示宿主已保存的授权。')
    fireEvent.click(screen.getByRole('switch', { name: '允许 Agent 为子智能体选择模型' }))
    expect((screen.getByRole('button', { name: '保存子智能体授权' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: '允许 Agent 为子智能体选择模型' }))
    expect(fixture.mutate).not.toHaveBeenCalled()
    expect(screen.getByText('当前显示宿主已保存的授权。')).toBeTruthy()
  })

  it('shows a failed native save without losing the draft', async () => {
    const fixture = subagentForm({ enabled: true, allowedModels: [{ provider: 'native', model: 'existing' }] })
    fixture.mutate.mockRejectedValueOnce(new Error('save offline'))
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(bridged())} probe={noProbe} getSubagentForm={() => fixture.form} />)
    await screen.findByText('当前显示宿主已保存的授权。')
    fireEvent.click(screen.getByRole('switch', { name: '允许 Agent 为子智能体选择模型' }))
    fireEvent.click(screen.getByRole('button', { name: '保存子智能体授权' }))
    await screen.findByText('授权保存失败：save offline')
    expect(fixture.form.getSnapshot().value?.enabled).toBe(true)
    expect((screen.getByRole('switch', { name: '允许 Agent 为子智能体选择模型' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: '取消授权修改' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('explains scoped tool discovery without promising a magic keyword or auto invocation', async () => {
    const fixture = subagentForm({ enabled: false, allowedModels: [] })
    const probe = vi.fn(noProbe)
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(bridged())} probe={probe} getSubagentForm={() => fixture.form} />)
    await screen.findByText('请调用 list_subagent_models，先列出 provider，再逐个查询模型，汇总本会话的子智能体候选清单。')
    const hint = screen.getByText(/这是工具名，不是输入即执行的命令/).textContent
    expect(hint).toContain('当前会话提供该工具')
    expect(hint).toContain('本会话授权下可发现的候选')
    expect(hint).toContain('不保证实际调用成功')
    expect(hint).toContain('修改授权后请新建会话再查询')
    expect(fixture.mutate).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  it('guides users to official model authorization and only navigates on click', async () => {
    const order: string[] = []
    const openPlugins = vi.fn(() => { order.push('navigate') })
    const close = vi.fn(() => { order.push('close') })
    const loadStatus = vi.fn(() => Promise.resolve(bridged()))
    const probe = vi.fn(noProbe)
    render(<PiAuthBridgeSection loadStatus={loadStatus} probe={probe} openPlugins={openPlugins} close={close} />)
    await screen.findByText('子智能体模型选择')
    expect(screen.getByText(/插件 → 子智能体 → 模型选择/)).toBeTruthy()
    expect(screen.getByText(/框内滚动/)).toBeTruthy()
    expect(screen.getByText(/仅对新会话生效/)).toBeTruthy()
    expect(openPlugins).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '打开插件' }))
    expect(openPlugins).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['navigate', 'close'])
    expect(loadStatus).toHaveBeenCalledTimes(1)
    expect(probe).not.toHaveBeenCalled()
  })

  it('keeps manual instructions available without navigation support', async () => {
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(emptyStatus('llm-missing', 'missing llm'))} probe={noProbe} />)
    await screen.findByText('子智能体模型选择')
    expect((screen.getByRole('button', { name: '打开插件' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/从侧边栏打开/)).toBeTruthy()
    expect(screen.getByText('空挂载')).toBeTruthy()
  })

  it('reports navigation failures without losing the bridge panel', async () => {
    const openPlugins = () => { throw new Error('navigation unavailable') }
    const close = vi.fn()
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(bridged())} probe={noProbe} openPlugins={openPlugins} close={close} />)
    await screen.findByText('子智能体模型选择')
    fireEvent.click(screen.getByRole('button', { name: '打开插件' }))
    expect(screen.getByRole('alert').textContent).toContain('navigation unavailable')
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByText('已桥接')).toBeTruthy()
  })

  it('renders the bridged snapshot: badge, routes, proxy, and warnings', async () => {
    const { container } = render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(bridged())} probe={noProbe} />)
    await waitFor(() => screen.getByText('已桥接'))
    expect(screen.getByText('pi/acme')).toBeTruthy()
    expect(screen.getAllByText(/models\.json/).length).toBeGreaterThan(0)
    expect(screen.getByText(/API Key/)).toBeTruthy()
    expect(screen.getByText('/home/u/.pi/agent')).toBeTruthy()
    expect(screen.getByText(/已检测到代理变量/)).toBeTruthy()
    expect(screen.getByText('dsh-pi-auth-bridge: sample warning')).toBeTruthy()
    // 凭据本体绝不进面板。
    expect(container.textContent).not.toContain('sk-client-canary')
  })

  it('renders the empty phase with the localized reason', async () => {
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(emptyStatus('pi-dir-not-found', 'not found'))} probe={noProbe} />)
    await waitFor(() => screen.getByText('空挂载'))
    expect(screen.getByText(/未找到 pi 配置目录/)).toBeTruthy()
  })

  it('renders the failure state when the remote call rejects', async () => {
    render(<PiAuthBridgeSection loadStatus={() => Promise.reject(new Error('carrier down'))} probe={noProbe} />)
    await waitFor(() => screen.getByText(/carrier down/))
  })

  it('renders model lists, config echo and self-health sections', async () => {
    const status: BridgeStatus = {
      ...bridged(),
      warnings: [],
      config: { providers: ['acme'], includeOAuth: false, commandTimeoutMs: 5000 },
      versions: { plugin: '0.4.0', dshLlm: '0.1.6-alpha.2' },
      selfChecks: [
        { id: 'dsh-llm-contract', ok: true },
        { id: 'attachments-service', ok: false, message: '附件服务未挂载' },
      ],
      recentErrors: [{ at: 1_700_000_000_000, route: 'pi/acme', model: 'acme-large', code: 'REQUEST_FAILED', message: 'boom' }],
    }
    status.routes[0] = {
      ...status.routes[0]!,
      modelList: [
        { id: 'acme-large', contextWindow: 200_000, input: ['text', 'image'] },
        { id: 'acme-small', input: ['text'] },
      ],
    }
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(status)} probe={noProbe} />)
    await waitFor(() => screen.getAllByText('acme-large'))
    expect(screen.getByText('200000')).toBeTruthy()
    expect(screen.getByText('text, image')).toBeTruthy()
    // 未探测时徽章为占位。
    expect(screen.getAllByTitle(/^文本 未探测/).length).toBeGreaterThan(0)
    expect(screen.getByText(/白名单 acme/)).toBeTruthy()
    expect(screen.getByText(/插件 0\.4\.0/)).toBeTruthy()
    expect(screen.getByText('dsh-llm-contract')).toBeTruthy()
    expect(screen.getByText(/附件服务未挂载/)).toBeTruthy()
    expect(screen.getByText(/REQUEST_FAILED: boom/)).toBeTruthy()
  })

  it('runs a model probe on click and paints the capability verdicts', async () => {
    const status: BridgeStatus = bridged()
    status.warnings = []
    status.routes[0] = { ...status.routes[0]!, modelList: [{ id: 'acme-large', input: ['text'] }] }
    const report: ModelProbeReport = {
      route: 'pi/acme',
      model: 'acme-large',
      at: 1,
      ok: true,
      latencyMs: 500,
      outcomes: [
        { capability: 'text', verdict: 'ok', latencyMs: 100, message: 'pong' },
        { capability: 'image', verdict: 'skipped', latencyMs: 0 },
        { capability: 'reasoning', verdict: 'skipped', latencyMs: 0 },
        { capability: 'toolCall', verdict: 'inconclusive', latencyMs: 300 },
      ],
    }
    const requests: ProbeRequest[] = []
    const probe = (request: ProbeRequest): Promise<ProbeResult> => {
      requests.push(request)
      return Promise.resolve({ ok: true, report })
    }
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(status)} probe={probe} />)
    await waitFor(() => screen.getByText('测试'))
    fireEvent.click(screen.getByText('测试'))
    await waitFor(() => screen.getByTitle(/^文本 ok/))
    expect(requests).toEqual([{ route: 'pi/acme', model: 'acme-large' }])
    expect(screen.getByTitle(/^图片 skipped/)).toBeTruthy()
    expect(screen.getByTitle(/^工具 inconclusive/)).toBeTruthy()
  })

  it('shows business failures from probe inline', async () => {
    const status: BridgeStatus = bridged()
    status.warnings = []
    status.routes[0] = { ...status.routes[0]!, modelList: [{ id: 'acme-large', input: ['text'] }] }
    const probe = (): Promise<ProbeResult> =>
      Promise.resolve({ ok: false, route: 'pi/acme', model: 'acme-large', code: 'not-bridged', message: 'empty mount' })
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(status)} probe={probe} />)
    await waitFor(() => screen.getByText('测试'))
    fireEvent.click(screen.getByText('测试'))
    await waitFor(() => screen.getByText(/not-bridged: empty mount/))
  })

  it('renders cached probe reports from the snapshot', async () => {
    const status: BridgeStatus = bridged()
    status.warnings = []
    status.routes[0] = { ...status.routes[0]!, modelList: [{ id: 'acme-large', input: ['text'] }] }
    status.probes = {
      [probeKey('pi/acme', 'acme-large')]: {
        route: 'pi/acme',
        model: 'acme-large',
        at: 1,
        ok: true,
        latencyMs: 10,
        outcomes: [{ capability: 'text', verdict: 'ok', latencyMs: 10 }],
      },
    }
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(status)} probe={noProbe} />)
    await waitFor(() => screen.getByTitle(/^文本 ok/))
  })

  it('probes a single dimension when its badge is clicked, and renders the detail line', async () => {
    const status: BridgeStatus = bridged()
    status.warnings = []
    status.routes[0] = { ...status.routes[0]!, modelList: [{ id: 'acme-large', input: ['text'] }] }
    const requests: ProbeRequest[] = []
    const probe = (request: ProbeRequest): Promise<ProbeResult> => {
      requests.push(request)
      return Promise.resolve({
        ok: true,
        report: {
          route: 'pi/acme',
          model: 'acme-large',
          at: 1,
          ok: true,
          latencyMs: 9,
          outcomes: [{ capability: 'toolCall', verdict: 'ok', latencyMs: 9, detail: 'calls=1 · finish=tool-calls · usage ✓' }],
        },
      })
    }
    render(<PiAuthBridgeSection loadStatus={() => Promise.resolve(status)} probe={probe} />)
    await waitFor(() => screen.getByTitle(/^工具 未探测/))
    fireEvent.click(screen.getByTitle(/^工具 未探测/))
    await waitFor(() => screen.getByTitle(/^工具 ok/))
    expect(requests).toEqual([{ route: 'pi/acme', model: 'acme-large', capability: 'toolCall' }])
    // 诊断详情渲染（与 host 日志同源）。
    expect(screen.getByText(/calls=1 · finish=tool-calls/)).toBeTruthy()
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
    expect((mounted[0] as { package: string }).package).toBe('@xnightsky/dsh-pi-auth-bridge')
    expect(plugged).toHaveLength(1)
    expect(plugged[0]?.inject).toContain('remote.piAuthBridge')
  })

  it('registers the settings section once the namespace service is available', async () => {
    const status: BridgeStatus = bridged()
    const registered: { options: Record<string, unknown>; component: unknown }[] = []
    const openList = vi.fn()
    let navigation: { openList: () => void } | undefined
    const fixture = subagentForm()
    const getForm = vi.fn(() => fixture.form)
    let forms: { get: typeof getForm } | undefined
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
      get: (service: string) => service === 'pluginNavigation' ? navigation : service === 'configForms' ? forms : undefined,
      remote: {
        piAuthBridge: {
          status: () => Promise.resolve({ ok: true, value: status }),
          probe: (request: ProbeRequest) => Promise.resolve({ ok: true, value: { ok: false, route: request.route, model: request.model, code: 'x', message: 'y' } }),
        },
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
    expect(registered[0]?.options).toMatchObject({ name: 'settings.section', id: 'dsh-pi-auth-bridge' })
    expect(typeof registered[0]?.component).toBe('function')
    // loadStatus 解包 RemoteResult。
    const face = (registered[0]?.options.inject as () => PiAuthBridgePanelFace)()
    await expect(face.loadStatus()).resolves.toBe(status)
    await expect(face.probe({ route: 'pi/acme', model: 'acme-large' })).resolves.toMatchObject({ ok: false, code: 'x' })
    expect(face.getSubagentForm?.()).toBeUndefined()
    forms = { get: getForm }
    expect(face.getSubagentForm?.()).toBe(fixture.form)
    expect(getForm).toHaveBeenCalledWith('subagent-model-selection-settings')
    // 导航服务按点击时查询：晚出现可用，卸载后明确报错。
    navigation = { openList }
    face.openPlugins?.()
    expect(openList).toHaveBeenCalledTimes(1)
    navigation = undefined
    expect(() => face.openPlugins?.()).toThrow('从侧边栏打开')
  })
})
