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
}

/** apply 与服务之间共享的可变状态盒：apply 回填，服务读取。 */
export interface BridgeStatusBox {
  current: BridgeStatus
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

const EMPTY_PROXY: BridgeStatus['proxy'] = { enabled: false, detected: false }

/** 组装空挂载快照；`partial` 回填早退前已收集的信息（piDir/警告等）。 */
export function emptyStatus(
  reason: BridgeEmptyReason,
  detail: string,
  partial: Partial<Pick<BridgeStatus, 'piDir' | 'proxy' | 'warnings'>> = {},
): BridgeStatus {
  return {
    phase: 'empty',
    reason,
    detail,
    ...(partial.piDir !== undefined ? { piDir: partial.piDir } : {}),
    routes: [],
    proxy: partial.proxy ?? EMPTY_PROXY,
    warnings: partial.warnings ?? [],
  }
}

/** 组装桥接成功快照。 */
export function bridgedStatus(input: {
  piDir: string
  routes: RouteDef[]
  proxy: BridgeStatus['proxy']
  warnings: string[]
}): BridgeStatus {
  return {
    phase: 'bridged',
    piDir: input.piDir,
    routes: input.routes.map(routeStatusOf),
    proxy: input.proxy,
    warnings: input.warnings,
  }
}
