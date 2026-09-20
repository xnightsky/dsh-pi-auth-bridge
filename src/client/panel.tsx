/**
 * pi-auth-bridge Settings 区块的呈现层：桥状态、配置回显、模型 × 能力
 * 交叉探测矩阵（每模型行内测试 / 全部测试）、插件自健康（版本表、启动
 * 自检、近期请求错误）。面板只读，探测是用户点击触发的真实 API 调用。
 *
 * @module dsh-pi-auth-bridge/client-panel
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { mergeProbeReport, probeKey, type BridgeModelStatus, type BridgeRouteStatus, type BridgeStatus, type ModelProbeReport, type ProbeCapability, type ProbeRequest, type ProbeResult, type ProbeVerdict } from '../panel/status.js'

/** 面板的数据拉取面（由入口经 slot inject 注入）。 */
export interface PiAuthBridgePanelFace {
  /** 等待 Remote 挂载完成后拉取桥状态快照。 */
  loadStatus: () => Promise<BridgeStatus>
  /** 对指定路由的指定模型跑能力探测（真实 API 调用，耗时数秒）。 */
  probe: (request: ProbeRequest) => Promise<ProbeResult>
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

const CAPABILITY_LABEL: Record<string, string> = {
  text: '文本',
  image: '图片',
  reasoning: '推理',
  toolCall: '工具',
}

const CAPABILITY_ORDER = ['text', 'image', 'reasoning', 'toolCall'] as const

const VERDICT_STYLE: Record<ProbeVerdict, { symbol: string; color: string }> = {
  ok: { symbol: '✓', color: '#2da44e' },
  failed: { symbol: '✗', color: '#cf222e' },
  skipped: { symbol: '—', color: '#8c959f' },
  inconclusive: { symbol: '?', color: '#9a6700' },
}

const styles = {
  badge: (ok: boolean): CSSProperties => ({
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
  error: { fontSize: 12, color: '#cf222e' },
  button: { fontSize: 12, padding: '2px 8px', cursor: 'pointer' } as const,
  routeSummary: { cursor: 'pointer', padding: '4px 0', fontSize: 13 } as const,
  checkOk: { color: '#2da44e' } as const,
  checkFailed: { color: '#cf222e' } as const,
  badgeButton: { background: 'none', border: 'none', padding: '0 6px 0 0', fontSize: 12, cursor: 'pointer', color: 'inherit' } as const,
} satisfies Record<string, unknown>

/** 单模型的能力徽章：4 个固定维度，按报告 outcome 着色；点击徽章按维度单测。 */
function CapabilityBadges({ report, busy, onProbe }: { report: ModelProbeReport | undefined; busy: boolean; onProbe: (capability: ProbeCapability) => void }): ReactNode {
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {CAPABILITY_ORDER.map((capability) => {
        const outcome = report?.outcomes.find((item) => item.capability === capability)
        const style = outcome === undefined ? { symbol: '·', color: '#8c959f' } : VERDICT_STYLE[outcome.verdict]
        const title = outcome === undefined ? '未探测' : `${outcome.verdict}${outcome.message !== undefined ? `：${outcome.message}` : ''}（${outcome.latencyMs}ms）`
        return (
          <button
            key={capability}
            style={styles.badgeButton}
            disabled={busy}
            onClick={() => onProbe(capability)}
            title={`${CAPABILITY_LABEL[capability]} ${title}；点击单测此维度`}
          >
            {CAPABILITY_LABEL[capability]}
            <span style={{ color: style.color, fontWeight: 600 }}>{style.symbol}</span>
          </button>
        )
      })}
    </span>
  )
}

/** 探测详情行：与 host 日志同源的诊断串，出问题不必重跑即可回溯。 */
function OutcomeDetails({ report }: { report: ModelProbeReport }): ReactNode {
  const lines = report.outcomes.filter((outcome) => outcome.detail !== undefined || outcome.message !== undefined)
  if (lines.length === 0) return null
  return (
    <div style={{ ...styles.muted, marginTop: 2 }}>
      {lines.map((outcome) => (
        <div key={outcome.capability}>
          {CAPABILITY_LABEL[outcome.capability]}{' '}
          <span style={{ color: VERDICT_STYLE[outcome.verdict].color }}>{VERDICT_STYLE[outcome.verdict].symbol}</span>{' '}
          {outcome.latencyMs}ms
          {outcome.detail !== undefined && ` · ${outcome.detail}`}
          {outcome.detail === undefined && outcome.message !== undefined && ` · ${outcome.message}`}
        </div>
      ))}
    </div>
  )
}

/** 面板侧的探测编排面（由 Section 下发给路由块）。 */
export interface ProbeActions {
  reports: Record<string, ModelProbeReport>
  probing: Record<string, boolean>
  probeErrors: Record<string, string>
  /** 触发探测；`capability` 缺省跑全部适用维度，指定时按维度单测。 */
  runProbe: (route: string, model: string, capability?: ProbeCapability) => void
}

/** 一条路由的模型子表。 */
function ModelTable({ route, actions }: { route: BridgeRouteStatus; actions: ProbeActions }): ReactNode {
  const models = route.modelList ?? []
  if (models.length === 0) {
    return <p style={styles.muted}>模型清单尚未就绪（注册后异步填充），请稍后刷新面板。</p>
  }
  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.cell}>模型</th>
          <th style={styles.cell}>上下文</th>
          <th style={styles.cell}>输入</th>
          <th style={styles.cell}>能力探测</th>
          <th style={styles.cell}></th>
        </tr>
      </thead>
      <tbody>
        {models.map((model) => (
          <ModelRow key={model.id} route={route.id} model={model} actions={actions} />
        ))}
      </tbody>
    </table>
  )
}

function ModelRow({ route, model, actions }: { route: string; model: BridgeModelStatus; actions: ProbeActions }): ReactNode {
  const key = probeKey(route, model.id)
  const busy = actions.probing[key] === true
  const error = actions.probeErrors[key]
  return (
    <tr>
      <td style={styles.cell}>
        <code>{model.id}</code>
        {model.name !== undefined && model.name !== model.id && <span style={styles.muted}>（{model.name}）</span>}
        {error !== undefined && <div style={styles.error}>{error}</div>}
      </td>
      <td style={styles.cell}>{model.contextWindow ?? '—'}</td>
      <td style={styles.cell}>{model.input.join(', ')}</td>
      <td style={styles.cell}>
        <CapabilityBadges report={actions.reports[key]} busy={busy} onProbe={(capability) => actions.runProbe(route, model.id, capability)} />
        {actions.reports[key] !== undefined && <OutcomeDetails report={actions.reports[key]!} />}
      </td>
      <td style={styles.cell}>
        <button style={styles.button} disabled={busy} onClick={() => actions.runProbe(route, model.id)}>
          {busy ? '测试中…' : '测试'}
        </button>
      </td>
    </tr>
  )
}

/** 路由列表：每条路由一个可展开的模型子表。 */
function RouteList({ routes, actions }: { routes: BridgeRouteStatus[]; actions: ProbeActions }): ReactNode {
  return (
    <div>
      {routes.map((route) => (
        <details key={route.id}>
          <summary style={styles.routeSummary}>
            <code>{route.id}</code>
            <span style={styles.muted}>
              {'　'}
              {route.kind === 'builtin' ? 'pi-ai 目录' : 'models.json'} · {route.api ?? '协议未知'} ·{' '}
              {CREDENTIAL_LABEL[route.credential]} · {route.modelList !== undefined ? `${route.modelList.length} 个模型` : route.models === 0 ? '目录' : `${route.models} 个模型`}
            </span>
          </summary>
          <ModelTable route={route} actions={actions} />
        </details>
      ))}
    </div>
  )
}

/** 生效配置回显。 */
function ConfigEcho({ status }: { status: BridgeStatus }): ReactNode {
  if (status.config === undefined) return null
  const { providers, includeOAuth, commandTimeoutMs } = status.config
  return (
    <p style={styles.muted}>
      生效配置：白名单 {providers === undefined ? '全部 provider' : providers.join(', ')} · OAuth{' '}
      {includeOAuth ? '桥接' : '不桥接'} · 取值命令超时 {commandTimeoutMs}ms
    </p>
  )
}

/** 插件自健康：版本表、启动自检、近期请求错误。 */
function SelfHealth({ status }: { status: BridgeStatus }): ReactNode {
  const versions = status.versions
  const selfChecks = status.selfChecks ?? []
  const recentErrors = status.recentErrors ?? []
  if (versions === undefined && selfChecks.length === 0 && recentErrors.length === 0) return null
  return (
    <div>
      <h4>插件自健康</h4>
      {versions !== undefined && (
        <p style={styles.muted}>
          版本：插件 {versions.plugin} · dsh-llm {versions.dshLlm ?? '未知'} · dsh-attachment{' '}
          {versions.dshAttachment ?? '未知'} · pi-ai {versions.piAi ?? '未知'}
        </p>
      )}
      {selfChecks.length > 0 && (
        <ul style={{ fontSize: 12, listStyle: 'none', paddingLeft: 0 }}>
          {selfChecks.map((check) => (
            <li key={check.id}>
              <span style={check.ok ? styles.checkOk : styles.checkFailed}>{check.ok ? '✓' : '✗'}</span> {check.id}
              {check.message !== undefined && <span style={styles.muted}>（{check.message}）</span>}
            </li>
          ))}
        </ul>
      )}
      {recentErrors.length > 0 && (
        <div>
          <p style={styles.muted}>近期请求错误（新→旧，最多 20 条）：</p>
          <table style={styles.table}>
            <tbody>
              {recentErrors.map((error, index) => (
                <tr key={index}>
                  <td style={styles.cell}>{new Date(error.at).toLocaleTimeString()}</td>
                  <td style={styles.cell}><code>{error.route}</code></td>
                  <td style={styles.cell}>{error.model ?? '—'}</td>
                  <td style={styles.cell}><span style={styles.error}>{error.code}: {error.message}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
        <li>能力探测逐模型走本桥完整管线（请求转换 + 流翻译），覆盖文本/图片/推理/工具调用；「测试」跑全维度，点击某个能力徽章可只测该维度；「?」表示模型未触发工具调用（不确定），「—」表示该能力不适用；每维详情与 host 日志同源，可事后回溯</li>
      </ul>
    </div>
  )
}

/** Settings 区块组件：挂载时拉取一次快照，探测结果缓存在组件内。 */
export function PiAuthBridgeSection({ loadStatus, probe }: PiAuthBridgePanelFace): ReactNode {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [reports, setReports] = useState<Record<string, ModelProbeReport>>({})
  const [probing, setProbing] = useState<Record<string, boolean>>({})
  const [probeErrors, setProbeErrors] = useState<Record<string, string>>({})

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
  const allReports = { ...(status.probes ?? {}), ...reports }

  const runProbe = (route: string, model: string, capability?: ProbeCapability): void => {
    const key = probeKey(route, model)
    setProbing((map) => ({ ...map, [key]: true }))
    setProbeErrors((map) => {
      const next = { ...map }
      delete next[key]
      return next
    })
    void probe({ route, model, ...(capability === undefined ? {} : { capability }) }).then(
      (result) => {
        if (result.ok) {
          // 按维度合并：单测只覆盖该维度，保留其余维度的历史结果（与 host 缓存同语义）。
          setReports((map) => ({ ...map, [key]: mergeProbeReport(map[key] ?? status.probes?.[key], result.report) }))
        } else {
          setProbeErrors((map) => ({ ...map, [key]: `${result.code}: ${result.message}` }))
        }
        setProbing((map) => ({ ...map, [key]: false }))
      },
      (error: unknown) => {
        setProbeErrors((map) => ({ ...map, [key]: (error as Error).message }))
        setProbing((map) => ({ ...map, [key]: false }))
      },
    )
  }

  const actions: ProbeActions = { reports: allReports, probing, probeErrors, runProbe }

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
      <ConfigEcho status={status} />
      {status.routes.length > 0 && (
        <div>
          <h4>路由与模型</h4>
          <RouteList routes={status.routes} actions={actions} />
        </div>
      )}
      <SelfHealth status={status} />
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
