/**
 * 桥状态模型：插件面板（§5）的唯一数据契约，也是 Typert Remote 的返回
 * 类型。本模块只有纯数据与纯函数，不 import cordis/pi-ai，可单元测试。
 *
 * 安全不变量：状态快照绝不包含凭据本体（api key / OAuth token / refresh
 * token），也不含 `$ENV` / `!cmd` 原始表达式——只记录凭据类型。
 *
 * @module dsh-pi-auth-bridge/status
 */
import type { RouteDef } from './convert.js'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'

/** 空挂载原因：面板据此向用户解释「为什么没有路由」。 */
export type BridgeEmptyReason =
  /** 组合中没有 llm 服务（`@deepseek-ai/dsh-llm` 未挂载）。 */
  | 'llm-missing'
  /** pi 配置目录未找到（`$PI_CODING_AGENT_DIR` 与 `~/.pi/agent` 都不存在）。 */
  | 'pi-dir-not-found'
  /** pi 配置文件存在但不可读/已损坏。 */
  | 'pi-config-unreadable'
  /** pi 目录里没有任何可用凭据。 */
  | 'no-credentials'
  /** 候选路由存在但没有一条可服务。 */
  | 'no-servable-routes'

/** 一个可服务模型的面板视图。 */
export interface BridgeModelStatus {
  /** 模型 id（请求时使用的标识）。 */
  id: string
  /** 人类可读名称。 */
  name?: string
  /** 上下文窗口（token）；未知时缺省。 */
  contextWindow?: number
  /** 输入模态（如 `['text', 'image']`）。 */
  input: string[]
}

/** 一条已注册路由的面板视图（凭据本体已被剔除）。 */
export interface BridgeRouteStatus {
  /** 注册到 LLM 接缝的路由 id（固定 `pi/` 前缀）。 */
  id: string
  /** pi 原始 provider id。 */
  provider: string
  /** `builtin`：元数据来自 pi-ai 目录；`custom`：由 `models.json` 声明。 */
  kind: 'builtin' | 'custom'
  /** 线协议（仅 custom 路由在桥侧可知）。 */
  api?: string
  /** 凭据类型；`none` 表示无需密钥的本地端点。 */
  credential: 'api_key' | 'oauth' | 'none'
  /** models.json 声明的模型数；0 表示使用 pi-ai 目录。 */
  models: number
  /** 完整模型清单（注册后异步填充；填充完成前缺省）。 */
  modelList?: BridgeModelStatus[]
}

/** 面板展示用的生效配置回显。 */
export interface BridgeConfigEcho {
  /** provider 白名单；缺省表示桥接全部。 */
  providers?: string[]
  /** 是否桥接 OAuth 凭据。 */
  includeOAuth: boolean
  /** `!command` 取值命令超时（毫秒）。 */
  commandTimeoutMs: number
}

/** 插件面板的桥状态快照。 */
export interface BridgeStatus {
  /** `bridged`：桥接成功；`empty`：空挂载（原因见 `reason`）。 */
  phase: 'bridged' | 'empty'
  /** 空挂载原因（仅 `phase: 'empty'` 时存在）。 */
  reason?: BridgeEmptyReason
  /** 人类可读的补充说明。 */
  detail?: string
  /** 实际使用的 pi 配置目录。 */
  piDir?: string
  /** 已注册路由的面板视图。 */
  routes: BridgeRouteStatus[]
  /** 代理嗅探：`enabled` 为配置开关，`detected` 为是否嗅探到代理变量。 */
  proxy: { enabled: boolean; detected: boolean }
  /** 桥接过程收集的全部警告（与 logger.warn 同源）。 */
  warnings: string[]
  /** 生效配置回显。 */
  config?: BridgeConfigEcho
  /** 启动自检结果（本地契约检查）。 */
  selfChecks?: BridgeSelfCheck[]
  /** 近期请求错误（新→旧，上限 MAX_RECENT_ERRORS 条）。 */
  recentErrors?: BridgeRequestError[]
  /** 关键组件版本表。 */
  versions?: BridgeVersions
  /** 探测报告缓存：`{route}\0{model}` → 最近一次报告。 */
  probes?: Record<string, ModelProbeReport>
}

/** 探测请求：对指定路由的指定模型发一组极简真实请求（能力矩阵）。 */
export interface ProbeRequest {
  /** 路由 id（如 `pi/openai`）。 */
  route: string
  /** 模型 id。 */
  model: string
  /** 只测指定维度；缺省跑全部适用维度。 */
  capability?: ProbeCapability
}

/** 探测覆盖的能力维度（与历史故障点一一对应）。 */
export type ProbeCapability = 'text' | 'image' | 'reasoning' | 'toolCall'

/** 单项能力结论：`skipped` 模型不声明该能力；`inconclusive` 无法判定（如工具未被触发）。 */
export type ProbeVerdict = 'ok' | 'failed' | 'skipped' | 'inconclusive'

/** 一项能力的探测结果。 */
export interface CapabilityProbeOutcome {
  capability: ProbeCapability
  verdict: ProbeVerdict
  latencyMs: number
  /** 失败原因或补充说明（回复预览、跳过原因等）。 */
  message?: string
  /**
   * 诊断细节（日志同源）：终态、usage 是否到达、回复预览、工具调用次数、
   * 图片 target 形状、异常类型等——出问题时据此回溯，不用重跑。
   */
  detail?: string
}

/** 一个模型的完整探测报告。 */
export interface ModelProbeReport {
  route: string
  model: string
  /** 探测时间（epoch 毫秒）。 */
  at: number
  /** 总体结论：没有任何 `failed` 项（skipped/inconclusive 不算失败）。 */
  ok: boolean
  /** 总耗时（毫秒）。 */
  latencyMs: number
  outcomes: CapabilityProbeOutcome[]
}

/**
 * 探测结果（业务判别联合；传输层的 `RemoteResult` 包在其外）。探测是
 * 用户点击触发的真实 API 调用：逐项证明「凭据 + 网络 + 模型 × 能力」端到端可用。
 */
export type ProbeResult =
  | { ok: true; report: ModelProbeReport }
  | { ok: false; route: string; model: string; code: string; message: string }

/** 探测处理器：由 apply 在桥接成功后装配。 */
export type ProbeHandler = (request: ProbeRequest) => Promise<ProbeResult>

/** 插件自身的一项启动自检（本地契约检查，无网络）。 */
export interface BridgeSelfCheck {
  /** 检查项 id（如 `dsh-attachment-contract`）。 */
  id: string
  ok: boolean
  /** 失败原因或补充说明。 */
  message?: string
}

/** 一条近期请求错误（桥运行时的真实健康信号）。 */
export interface BridgeRequestError {
  at: number
  route: string
  model?: string
  /** 稳定错误码（LlmError code 或 PROBE_FAILED 等）。 */
  code: string
  message: string
}

/** 关键组件版本表（升级后兼容性排查的第一现场）。 */
export interface BridgeVersions {
  /** 本插件版本。 */
  plugin: string
  dshLlm?: string
  dshAttachment?: string
  piAi?: string
}

/** apply 与服务之间共享的可变状态盒：apply 回填，服务读取。 */
export interface BridgeStatusBox {
  current: BridgeStatus
  /** 探测处理器；桥接成功前缺省，此时 probe 返回 `not-bridged`。 */
  probe?: ProbeHandler
}

/** 创建状态盒，初始快照通常为「尚未桥接」的 empty 状态。 */
export function createStatusBox(initial: BridgeStatus): BridgeStatusBox {
  return { current: initial }
}

/**
 * 从路由定义提取面板视图。凭据判定只读字段存在性，绝不复制字段值——
 * 这是「快照不含凭据本体」不变量的唯一执行点。
 */
export function routeStatusOf(route: RouteDef): BridgeRouteStatus {
  return {
    id: route.route,
    provider: route.providerId,
    kind: route.kind,
    ...(route.api !== undefined ? { api: route.api } : {}),
    credential: route.apiKey !== undefined ? 'api_key' : route.oauth !== undefined ? 'oauth' : 'none',
    models: route.models.length,
  }
}

/**
 * 把适配器的模型清单与逐模型解析结果合并为面板视图。`resolved` 用于
 * 补充 `contextWindow`；按 `provider + id` 对齐，缺失的解析结果只省略
 * contextWindow，不丢模型。
 */
export function modelListOf(
  listed: readonly LlmModelInfo[],
  resolved: readonly LlmResolvedModelInfo[],
): BridgeModelStatus[] {
  const contextOf = new Map(resolved.map((info) => [`${info.provider}\0${info.id}`, info.context?.contextWindow]))
  return listed.map((info) => {
    const contextWindow = contextOf.get(`${info.provider}\0${info.id}`)
    return {
      id: info.id,
      ...(info.name !== undefined ? { name: info.name } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      input: [...(info.inputModalities ?? [])],
    }
  })
}

/** 近期错误环形缓冲上限。 */
export const MAX_RECENT_ERRORS = 20

/** 探测报告缓存键。 */
export function probeKey(route: string, model: string): string {
  return `${route}\0${model}`
}

/** 记录一条近期请求错误（新→旧，截断到上限）。 */
export function recordRequestError(box: BridgeStatusBox, entry: BridgeRequestError): void {
  const current = box.current
  box.current = {
    ...current,
    recentErrors: [entry, ...(current.recentErrors ?? [])].slice(0, MAX_RECENT_ERRORS),
  }
}

/** 合并探测报告：按维度单测只覆盖该维度的 outcome，保留其余维度的
   * 历史结果；`ok` 按合并后重算，`at`/`latencyMs` 取本次。host 快照缓存与
   * 面板本地合并共用。 */
export function mergeProbeReport(existing: ModelProbeReport | undefined, report: ModelProbeReport): ModelProbeReport {
  const outcomes = [...(existing?.outcomes ?? [])]
  for (const outcome of report.outcomes) {
    const index = outcomes.findIndex((item) => item.capability === outcome.capability)
    if (index >= 0) {
      outcomes[index] = outcome
    } else {
      outcomes.push(outcome)
    }
  }
  return {
    ...report,
    ok: outcomes.every((outcome) => outcome.verdict !== 'failed'),
    outcomes,
  }
}

/** 缓存一份探测报告（面板重开可见；合并语义见 `mergeProbeReport`）。 */
export function recordProbeReport(box: BridgeStatusBox, report: ModelProbeReport): void {
  const current = box.current
  const key = probeKey(report.route, report.model)
  box.current = {
    ...current,
    probes: { ...(current.probes ?? {}), [key]: mergeProbeReport(current.probes?.[key], report) },
  }
}

const EMPTY_PROXY: BridgeStatus['proxy'] = { enabled: false, detected: false }

/** 组装空挂载快照；`partial` 回填早退前已收集的信息（piDir/警告/自健康等）。 */
export function emptyStatus(
  reason: BridgeEmptyReason,
  detail: string,
  partial: Partial<Pick<BridgeStatus, 'piDir' | 'proxy' | 'warnings' | 'versions' | 'selfChecks'>> = {},
): BridgeStatus {
  return {
    phase: 'empty',
    reason,
    detail,
    ...(partial.piDir !== undefined ? { piDir: partial.piDir } : {}),
    routes: [],
    proxy: partial.proxy ?? EMPTY_PROXY,
    warnings: partial.warnings ?? [],
    ...(partial.versions !== undefined ? { versions: partial.versions } : {}),
    ...(partial.selfChecks !== undefined ? { selfChecks: partial.selfChecks } : {}),
  }
}

/** 组装桥接成功快照。 */
export function bridgedStatus(input: {
  piDir: string
  routes: RouteDef[]
  proxy: BridgeStatus['proxy']
  warnings: string[]
  config?: BridgeConfigEcho
  versions?: BridgeVersions
  selfChecks?: BridgeSelfCheck[]
}): BridgeStatus {
  return {
    phase: 'bridged',
    piDir: input.piDir,
    routes: input.routes.map(routeStatusOf),
    proxy: input.proxy,
    warnings: input.warnings,
    ...(input.config !== undefined ? { config: input.config } : {}),
    ...(input.versions !== undefined ? { versions: input.versions } : {}),
    ...(input.selfChecks !== undefined ? { selfChecks: input.selfChecks } : {}),
  }
}
