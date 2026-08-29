/**
 * 将 pi 的 `auth.json` + `models.json` 纯转换为适配器可提供的路由定义。
 * 不 import pi-ai，除注入的取值解析器外无任何 I/O，整个映射可单元测试。
 *
 * @module dsh-pi-auth-bridge/convert
 */
import type { PiAuthEntry, PiModelDef, PiModelsFile, PiValueResolver, Warn } from './pi-auth.js'

/**
 * 路由名固定前缀：每条路由都是 `pi/<providerId>`。dsh web 的模型选择器
 * 只有「分组 → 模型」两级，分组 key 即路由 id 原样——此前缀让 PI 转发
 * 的模型在 key 层面与 dsh 原生及其他适配器的路由明确分开，不可配置。
 */
export const PI_ROUTE_PREFIX = 'pi/'

/** 桥接器可向 dsh LLM 接缝注册的一条 provider 路由。 */
export interface RouteDef {
  /** 注册到 `ctx.llm.registerAdapter` 的路由名（固定 `pi/` 前缀）。 */
  route: string
  /** pi 原始 provider id（用于 pi-ai 目录查询）。 */
  providerId: string
  /** `builtin`：元数据来自 pi-ai 内置目录；`custom`：由 `models.json` 声明。 */
  kind: 'builtin' | 'custom'
  /** 人类可读的 provider 名称，恒以 `Pi · ` 冠名标出出处。 */
  displayName: string
  /** 解析后的 api key（当该路由以 key 鉴权时）。仅存于内存。 */
  apiKey?: string
  /**
   * 交给 pi-ai 内存凭据存储的 OAuth 凭据，使其自身的刷新机制可以轮换过期
   * token。绝不回写到任何地方。
   */
  oauth?: { access: string; refresh: string; expires?: number }
  /** 自定义 provider 的线协议（`openai-completions` 等）。 */
  api?: string
  /** 自定义 provider 的端点覆盖。 */
  baseURL?: string
  /** 额外请求头（值已解析）。 */
  headers?: Record<string, string>
  /** pi 的 `authHeader` 标志：以 `Authorization: Bearer` 头发送 key。 */
  authHeader?: boolean
  /** 自定义模型声明；为空表示「使用 pi-ai 目录」。 */
  models: PiModelDef[]
}

export interface BuildRoutesOptions {
  /** pi provider id 白名单；缺省表示「找到的每个 provider」。 */
  providers?: readonly string[]
  /** 是否桥接 OAuth 条目。默认 true。 */
  includeOAuth?: boolean
  /** `$ENV` / `!cmd` / 字面量值的解析器。 */
  resolve: PiValueResolver
  /** warn 输出槽。 */
  warn: Warn
  /** 当前时间（epoch 毫秒，可注入以便测试）。 */
  now?: number
}

/** 解析一个可能含模板的值；失败时解析器内部已发出 warn。 */
function resolved(resolve: PiValueResolver, raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : resolve(raw)
}

/**
 * 从 pi 的配置构建路由集合。
 *
 * 每个 provider 的凭据优先级：`auth.json` 同名条目 >
 * `models.json` 的 `apiKey` 字段。OAuth 条目：未过期的 access token 直接
 * 当作普通 api key 桥接；已过期但带 refresh token 的交给 pi-ai 自身
 * （内存中）刷新；其余情况发出 warn 并跳过。
 */
export function buildRoutes(
  auth: Record<string, PiAuthEntry> | undefined,
  models: PiModelsFile | undefined,
  options: BuildRoutesOptions,
): RouteDef[] {
  const { resolve, warn } = options
  const includeOAuth = options.includeOAuth ?? true
  const now = options.now ?? Date.now()
  const whitelist = options.providers === undefined ? undefined : new Set(options.providers)

  const ids = new Set<string>([...Object.keys(auth ?? {}), ...Object.keys(models?.providers ?? {})])
  const routes: RouteDef[] = []

  for (const providerId of ids) {
    if (whitelist !== undefined && !whitelist.has(providerId)) continue
    const custom = models?.providers?.[providerId]
    const entry = auth?.[providerId]
    const route = `${PI_ROUTE_PREFIX}${providerId}`
    // 选择器分组标题只能来自 displayName，恒冠以「Pi · 」标明 PI 出处。
    const displayName = `Pi · ${custom?.name ?? providerId}`

    let apiKey: string | undefined
    let oauth: RouteDef['oauth']

    if (entry?.type === 'api_key') {
      apiKey = resolved(resolve, entry.key)
      if (apiKey === undefined) {
        warn(`pi-auth-bridge: provider "${providerId}": auth.json api key could not be resolved; trying models.json apiKey`)
      }
    } else if (entry?.type === 'oauth') {
      if (!includeOAuth) {
        warn(`pi-auth-bridge: provider "${providerId}": OAuth entry ignored because includeOAuth is false`)
      } else {
        const expired = entry.expires !== undefined && entry.expires <= now
        if (!expired) {
          // 未过期的 access token：可直接当作普通 bearer key 使用。
          apiKey = entry.access
        } else if (entry.refresh !== undefined && entry.refresh.length > 0) {
          // 已过期但可刷新：pi-ai 在内存中刷新；不回写任何内容。
          oauth = {
            access: entry.access,
            refresh: entry.refresh,
            ...(entry.expires !== undefined ? { expires: entry.expires } : {}),
          }
        } else {
          warn(`pi-auth-bridge: provider "${providerId}": OAuth token expired and has no refresh token; provider skipped`)
          continue
        }
      }
    }

    if (apiKey === undefined && custom?.apiKey !== undefined) {
      apiKey = resolved(resolve, custom.apiKey)
      if (apiKey === undefined) {
        warn(`pi-auth-bridge: provider "${providerId}": models.json apiKey could not be resolved`)
      }
    }

    if (apiKey === undefined && oauth === undefined) {
      if (custom === undefined) {
        // 仅在 auth.json 中出现且凭据无法解析的 provider 无法提供服务。
        warn(`pi-auth-bridge: provider "${providerId}": no usable credential; provider skipped`)
        continue
      }
      // 没有任何 key 的 models.json provider 仍可能是无需密钥的本地端点；
      // 保留它，交给线协议自行决定。
    }

    let headers: Record<string, string> | undefined
    if (custom?.headers !== undefined) {
      headers = {}
      for (const [name, raw] of Object.entries(custom.headers)) {
        const value = resolve(raw)
        if (value === undefined) {
          warn(`pi-auth-bridge: provider "${providerId}": header "${name}" could not be resolved; header dropped`)
          continue
        }
        headers[name] = value
      }
      if (Object.keys(headers).length === 0) headers = undefined
    }

    routes.push({
      route,
      providerId,
      kind: custom === undefined ? 'builtin' : 'custom',
      displayName,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(oauth !== undefined ? { oauth } : {}),
      ...(custom?.api !== undefined ? { api: custom.api } : {}),
      ...(custom?.baseUrl !== undefined ? { baseURL: custom.baseUrl } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(custom?.authHeader !== undefined ? { authHeader: custom.authHeader } : {}),
      models: custom?.models ?? [],
    })
  }
  return routes
}
