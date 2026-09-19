/**
 * pi-auth-bridge 浏览器半区：Settings 面板的「Pi Auth Bridge」区块。
 * 挂载本包的 Typert Remote 贡献（`../typert.remote-client.js`），经
 * `piAuthBridge/status` 拉取桥状态快照并渲染；另附静态能力说明。
 * 面板只读——本插件没有任何写操作面。
 *
 * @module dsh-pi-auth-bridge/client
 */
import type { Context } from '@deepseek-ai/cordis'
// 类型合并来源：ctx.remote（gateway）、ctx.slots（renderer）、settings.section（settings）。
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { useEffect, useState, type ReactNode } from 'react'
import { TYPERT_REMOTE } from '../typert.remote-client.js'
import type { BridgeRouteStatus, BridgeStatus } from '../status.js'

/** Client 半区所需服务：slot 注册表与 Remote 装配面。 */
export const inject = ['slots', 'remote']

/** 浏览器半区插件名（logger 用）。 */
export const name = 'pi-auth-bridge'

/** 面板的数据拉取面（由 apply 经 slot inject 注入）。 */
export interface PiAuthBridgePanelFace {
  /** 等待 Remote 挂载完成后拉取桥状态快照。 */
  loadStatus: () => Promise<BridgeStatus>
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; status: BridgeStatus }
  | { phase: 'failed'; message: string }

const CREDENTIAL_LABEL: Record<BridgeRouteStatus['credential'], string> = {
  api_key: 'API Key',
  oauth: 'OAuth',
  none: '无需密钥',
}

const EMPTY_REASON_LABEL: Record<NonNullable<BridgeStatus['reason']>, string> = {
  'llm-missing': '组合中没有 llm 服务',
  'pi-dir-not-found': '未找到 pi 配置目录',
  'pi-config-unreadable': 'pi 配置不可读或已损坏',
  'no-credentials': 'pi 中没有可用凭据',
  'no-servable-routes': '候选路由均不可服务',
}

const styles = {
  badge: (ok: boolean): React.CSSProperties => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: 12,
    color: '#fff',
    background: ok ? '#2da44e' : '#9a6700',
  }),
  table: { borderCollapse: 'collapse', width: '100%', fontSize: 13 } as const,
  cell: { borderBottom: '1px solid rgba(128,128,128,.3)', padding: '4px 8px', textAlign: 'left' } as const,
  muted: { opacity: 0.7, fontSize: 12 },
  warning: { fontSize: 12, color: '#9a6700' },
} satisfies Record<string, unknown>

/** 路由表。 */
function RouteTable({ routes }: { routes: BridgeRouteStatus[] }): ReactNode {
  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.cell}>路由</th>
          <th style={styles.cell}>来源</th>
          <th style={styles.cell}>协议</th>
          <th style={styles.cell}>凭据</th>
          <th style={styles.cell}>模型数</th>
        </tr>
      </thead>
      <tbody>
        {routes.map((route) => (
          <tr key={route.id}>
            <td style={styles.cell}><code>{route.id}</code></td>
            <td style={styles.cell}>{route.kind === 'builtin' ? 'pi-ai 目录' : 'models.json'}</td>
            <td style={styles.cell}>{route.api ?? '—'}</td>
            <td style={styles.cell}>{CREDENTIAL_LABEL[route.credential]}</td>
            <td style={styles.cell}>{route.models === 0 ? '目录' : route.models}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** 静态能力说明。 */
function CapabilityNotes(): ReactNode {
  return (
    <div style={styles.muted}>
      <p>
        本插件把本机 pi（Pi coding agent）的认证（auth.json + models.json）在内存中桥接为
        dsh 的 LLM 路由：零配置、即转即用，凭据绝不落地（不写 dsh 凭据存储、不回写 ~/.pi）。
      </p>
      <ul>
        <li>支持 api_key 与 OAuth 凭据（过期 OAuth 由 pi-ai 在内存中刷新，绝不回写）</li>
        <li>支持 $ENV / !command 取值表达式；自动嗅探代理环境变量并注入代理 fetch</li>
        <li>google 线路不注入代理 fetch，需以 NODE_USE_ENV_PROXY=1 启动 dsh 兜底</li>
      </ul>
    </div>
  )
}

/** Settings 区块组件：挂载时拉取一次快照。 */
export function PiAuthBridgeSection({ loadStatus }: PiAuthBridgePanelFace): ReactNode {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  useEffect(() => {
    let alive = true
    loadStatus().then(
      (status) => {
        if (alive) setState({ phase: 'ready', status })
      },
      (error: unknown) => {
        if (alive) setState({ phase: 'failed', message: (error as Error).message })
      },
    )
    return () => {
      alive = false
    }
  }, [loadStatus])

  if (state.phase === 'loading') return <p style={styles.muted}>正在读取桥状态…</p>
  if (state.phase === 'failed') return <p style={styles.warning}>桥状态读取失败：{state.message}</p>

  const { status } = state
  const bridged = status.phase === 'bridged'
  return (
    <section>
      <h3>
        Pi Auth Bridge <span style={styles.badge(bridged)}>{bridged ? '已桥接' : '空挂载'}</span>
      </h3>
      {!bridged && status.reason !== undefined && (
        <p>
          {EMPTY_REASON_LABEL[status.reason]}
          {status.detail !== undefined && <span style={styles.muted}>（{status.detail}）</span>}
        </p>
      )}
      {status.piDir !== undefined && <p style={styles.muted}>pi 配置目录：<code>{status.piDir}</code></p>}
      <p style={styles.muted}>
        代理嗅探：{status.proxy.enabled ? (status.proxy.detected ? '已检测到代理变量，桥接请求走代理' : '未检测到代理变量') : '已关闭（proxy: false）'}
      </p>
      {status.routes.length > 0 && <RouteTable routes={status.routes} />}
      {status.warnings.length > 0 && (
        <div>
          <h4>警告</h4>
          <ul style={styles.warning}>
            {status.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
          </ul>
        </div>
      )}
      <h4>能力说明</h4>
      <CapabilityNotes />
    </section>
  )
}

/**
 * 浏览器半区入口：挂载 Remote 贡献，然后派生一个 park 在
 * `remote.piAuthBridge` 命名空间服务上的子插件——cordis 对点分服务键强制
 * 检查 fiber 的 inject 声明，而命名空间服务由 $mount 异步创建，所以面板
 * 注册必须放在子插件里：服务出现后子插件才启动，此时访问合法（这是
 * gateway 为第三方 Remote 设计的官方等待模式）。
 */
export function apply(ctx: Context): void {
  const mounted = ctx.remote.$mount(TYPERT_REMOTE)
  mounted.catch((error: unknown) => {
    // 挂载失败时子插件永远 park（面板不出现），必须显式报出，禁止静默失败。
    ctx.logger(name).warn(`pi-auth-bridge: failed to mount the remote contribution: ${(error as Error).message}`)
  })
  ctx.plugin({
    name: 'pi-auth-bridge-panel',
    inject: ['slots', 'remote.piAuthBridge'],
    apply: (panelCtx: Context) => {
      const loadStatus = async (): Promise<BridgeStatus> => {
        const result = await panelCtx.remote.piAuthBridge.status()
        if (!result.ok) throw new Error(`remote status failed: ${JSON.stringify(result.error)}`)
        return result.value
      }
      panelCtx.slots.inject('settings.section', () =>
        panelCtx.slots.register({
          name: 'settings.section',
          id: 'pi-auth-bridge',
          order: 100,
          label: () => 'Pi Auth Bridge',
          inject: (): PiAuthBridgePanelFace => ({ loadStatus }),
        }, PiAuthBridgeSection),
      )
    },
  })
}
