/**
 * proxy.ts：HTTP 代理环境变量嗅探与注入式代理 fetch。
 *
 * 背景：pi-ai 的所有线路直接用 `globalThis.fetch`，不读 `http_proxy` 等
 * 变量；dsh 宿主进程也不做 pi CLI 的 `configureHttpDispatcher()` 全局补丁，
 * 桥接出的请求因此裸连。本模块补上这一环，但刻意与 pi CLI 的做法不同：
 * 绝不 `setGlobalDispatcher`、绝不重装 `globalThis.fetch`——桥是 dsh 进程内
 * 的插件，动全局状态会波及宿主与其他适配器。代理 fetch 只作为
 * `SimpleStreamOptions.fetch` 注入本桥自己的请求。
 *
 * 已知边界：`google-generative-ai` / `google-vertex` 线路的 pi-ai adapter
 * 显式拒绝自定义 fetch，注入在 adapter 侧按 `model.api` 跳过；这两条线路的
 * 代理需求由 `NODE_USE_ENV_PROXY=1`（Node ≥ 24.5）启动 dsh 兜底。
 *
 * @module dsh-pi-auth-bridge/proxy
 */
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'
import type { FetchFunction } from '@earendil-works/pi-ai'

/** 嗅探的代理变量族（小写优先，大写兜底；`all_proxy` 作 http/https 公共兜底）。 */
const HTTP_PROXY_VARS = ['http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'] as const
const HTTPS_PROXY_VARS = ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'] as const
const NO_PROXY_VARS = ['no_proxy', 'NO_PROXY'] as const

/** 按优先级取第一个非空环境变量值。 */
function envValue(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

/**
 * 环境中是否配置了代理。仅设 `no_proxy` 不算配置代理；空串视为未设置。
 * env 可注入以便测试。
 */
export function hasProxyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return envValue(env, HTTP_PROXY_VARS) !== undefined || envValue(env, HTTPS_PROXY_VARS) !== undefined
}

/**
 * 嗅探环境变量并构造带 `EnvHttpProxyAgent` dispatcher 的 fetch；未配置代理
 * 时返回 `undefined`（调用方不注入，行为与无代理一致）。
 *
 * dispatcher 参数对齐 pi CLI 的 `configureHttpDispatcher()`
 * （`allowH2: false, proxyTunnel: true`），代理地址与 `no_proxy` 从传入的
 * env 显式映射；未显式给出的项由 undici 回落 `process.env`（生产路径传入的
 * 即 `process.env`，语义一致）。
 */
export function createEnvProxyFetch(env: NodeJS.ProcessEnv = process.env): FetchFunction | undefined {
  if (!hasProxyEnv(env)) return undefined
  const httpProxy = envValue(env, HTTP_PROXY_VARS)
  const httpsProxy = envValue(env, HTTPS_PROXY_VARS)
  const noProxy = envValue(env, NO_PROXY_VARS)
  const dispatcher = new EnvHttpProxyAgent({
    ...(httpProxy !== undefined ? { httpProxy } : {}),
    ...(httpsProxy !== undefined ? { httpsProxy } : {}),
    ...(noProxy !== undefined ? { noProxy } : {}),
    allowH2: false,
    proxyTunnel: true,
  })
  // undici 的 fetch/RequestInit/Dispatcher 与全局及 @types/node 自带
  // undici-types 的类型互不兼容（运行时无差）；类型在边界处一次性断言。
  const undiciStyleFetch = undiciFetch as unknown as (input: unknown, init?: unknown) => Promise<Response>
  return ((input, init) => undiciStyleFetch(input, { ...init, dispatcher })) as FetchFunction
}
