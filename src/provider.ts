/**
 * provider.ts：由冻结的 RouteDef 集合构建 pi-ai 侧的 Provider 与 Models 集合。
 *
 * 不变量：
 * - 目录 provider（pi-ai 内置）整体复用，保留其 API 实现、兼容 quirks 与
 *   环境认证发现；桥只在目录缺少 apiKey 认证而路由持凭据时补一个 apiKey 方法。
 * - 自定义 provider（models.json 声明）使用与目录完全相同的懒加载协议工厂。
 * - OAuth 凭据只播种进 pi-ai 的**内存** Credential Store，由 pi-ai 自己的刷新
 *   机制轮换；绝不写盘、不写 dsh 凭据面、不回写 `~/.pi`。
 * - 任何不可服务的路由都跳过并 warn，绝不静默失败。
 *
 * @module dsh-pi-auth-bridge/provider
 */
import {
  createModels,
  createProvider,
  defaultProviderAuthContext,
  InMemoryCredentialStore,
  type Api,
  type ApiKeyAuth,
  type AssistantMessageEvent,
  type Context as PiContext,
  type CredentialStore,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderAuth,
  type ProviderStreams,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import type { PiModelDef, Warn } from './pi-auth.js'
import type { RouteDef } from './convert.js'

/** pi 未标注上下文容量时假定的默认值。 */
const DEFAULT_CONTEXT_WINDOW = 262_144
/** pi 未标注输出上限时假定的默认值。 */
const DEFAULT_MAX_TOKENS = 32_768

/**
 * 适配器依赖的 pi-ai `Models` 集合切片。结构化类型，
 * 测试可以注入假流而不触碰 pi-ai 与网络。
 */
export interface PiModelsLike {
  getModel(provider: string, id: string): Model<Api> | undefined
  getModels(provider: string): readonly Model<Api>[]
  streamSimple(model: Model<Api>, context: PiContext, options?: SimpleStreamOptions): AsyncIterable<AssistantMessageEvent>
}

/** 为一组路由构建 pi-ai provider 的结果。 */
export interface BuiltPiModels {
  models: PiModelsLike
  /** 实际可服务的路由名，按输入顺序。 */
  served: string[]
}

/**
 * `models.json` 自定义 provider 可指名的线路协议，映射到 pi-ai 的懒加载
 * 实现——与 pi-ai 自己的 provider 工厂使用同一批工厂，手写路由到达的
 * 实现与目录路由完全一致。
 */
const PROTOCOLS: Record<string, () => ProviderStreams> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi,
}

let catalogIndex: Map<string, Provider> | undefined

/** 已安装的 pi-ai 目录 provider（按 id），只构造一次。 */
function catalogProviders(): Map<string, Provider> {
  catalogIndex ??= new Map(builtinProviders().map((provider) => [provider.id, provider]))
  return catalogIndex
}

/**
 * 桥自身认证路由的 api-key 认证。`Models` 在应用请求级 `apiKey`
 * override 之后调用它，此处缺 key 只是报告「未认证」，交给线路协议
 * 自行决定（无 key 的本机端点是合法情形）。
 */
function bridgeApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) =>
      Promise.resolve({
        auth: credential?.key === undefined ? {} : { apiKey: credential.key },
        source: name,
      }),
  }
}

/**
 * 一条路由解析凭据所用的认证。目录路由保留已安装 provider 自己的认证
 * （保住它的 OAuth 刷新与环境发现）；仅当目录 provider 缺少 apiKey 方法
 * 而路由持凭据时，桥才补一个 apiKey 方法。非目录路由只给桥的 apiKey 方法。
 */
function routeAuth(route: RouteDef, catalog: Provider | undefined): ProviderAuth {
  const namesCredential = route.apiKey !== undefined || route.oauth !== undefined
  if (catalog === undefined) return { apiKey: bridgeApiKeyAuth(route.displayName) }
  if (catalog.auth.apiKey !== undefined || !namesCredential) return catalog.auth
  return { ...catalog.auth, apiKey: bridgeApiKeyAuth(route.displayName) }
}

/** pi 目录未描述的模型使用零定价（harness 从不读 cost）。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** 目录 provider 自带模型一致同意的唯一线路协议（当它们一致时）。 */
function sharedCatalogApi(models: readonly Model<Api>[]): Api | undefined {
  const apis = new Set(models.map((model) => model.api))
  return apis.size === 1 ? apis.values().next().value : undefined
}

/** 把 pi `models.json` 的模型条目物化为 pi-ai 模型描述符。 */
function materializeModels(
  route: RouteDef,
  defs: readonly PiModelDef[],
  fallback: { api?: Api; baseUrl?: string; catalog?: readonly Model<Api>[] },
  warn: Warn,
): Model<Api>[] {
  const byId = new Map((fallback.catalog ?? []).map((model) => [model.id, model]))
  const models: Model<Api>[] = []
  for (const def of defs) {
    const base = byId.get(def.id)
    const api = (fallback.api ?? base?.api) as Api | undefined
    if (api === undefined) {
      warn(`pi-auth-bridge: provider "${route.providerId}": model "${def.id}" has no api and the pi-ai catalog cannot supply one; model skipped`)
      continue
    }
    const baseUrl = fallback.baseUrl ?? base?.baseUrl
    if (baseUrl === undefined) {
      warn(`pi-auth-bridge: provider "${route.providerId}": model "${def.id}" has no baseUrl; model skipped`)
      continue
    }
    models.push({
      id: def.id,
      name: def.name ?? base?.name ?? def.id,
      api,
      provider: route.route as Model<Api>['provider'],
      baseUrl,
      reasoning: def.reasoning ?? base?.reasoning ?? false,
      input: base ? [...base.input] : ['text'],
      cost: def.cost ?? base?.cost ?? { ...NO_COST },
      contextWindow: def.contextWindow ?? base?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: def.maxTokens ?? base?.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(base?.headers !== undefined ? { headers: { ...base.headers } } : {}),
    })
  }
  return models
}

/** 复用已安装的目录 provider，套上本路由的标识、模型与认证。 */
function reuseCatalogProvider(catalog: Provider, route: RouteDef, warn: Warn): Provider | undefined {
  const catalogModels = catalog.getModels()
  const api = route.api ?? sharedCatalogApi(catalogModels)
  const baseUrl = route.baseURL ?? catalog.baseUrl
  const models = route.models.length === 0
    ? catalogModels
    : materializeModels(
        route,
        route.models,
        {
          ...(api !== undefined ? { api } : {}),
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          catalog: catalogModels,
        },
        warn,
      )
  if (models.length === 0) {
    warn(`pi-auth-bridge: provider "${route.providerId}": no servable models; route skipped`)
    return undefined
  }
  return {
    id: route.route,
    name: route.displayName,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    auth: routeAuth(route, catalog),
    getModels: () => models,
    stream: (model, context, options) => catalog.stream(model, context, options),
    streamSimple: (model, context, options) => catalog.streamSimple(model, context, options),
  }
}

/** 为一条路由构建 pi-ai provider；不可服务时返回 undefined（并 warn）。 */
function buildProvider(route: RouteDef, warn: Warn): Provider | undefined {
  const catalog = catalogProviders().get(route.providerId)
  // 无协议覆盖的目录路由复用已安装 provider，保留其 API 实现、兼容 quirks 与环境认证。
  if (catalog !== undefined && route.api === undefined) return reuseCatalogProvider(catalog, route, warn)
  if (catalog === undefined && route.kind === 'builtin') {
    warn(`pi-auth-bridge: provider "${route.providerId}" has credentials but is unknown to the pi-ai catalog and not described by models.json; route skipped`)
    return undefined
  }
  if (catalog === undefined && route.apiKey === undefined && route.oauth !== undefined) {
    // pi-ai 的 OAuth 刷新机制只存在于目录 provider；只持过期 OAuth 的自定义
    // provider 若注册，会得到一条必然 401 的死路由。
    warn(`pi-auth-bridge: provider "${route.providerId}": expired OAuth credential cannot be refreshed for a custom provider (no pi-ai catalog auth); route skipped`)
    return undefined
  }
  const factory = route.api === undefined ? undefined : PROTOCOLS[route.api]
  if (factory === undefined) {
    warn(`pi-auth-bridge: provider "${route.providerId}" names api "${route.api ?? '(none)'}", which this bridge cannot serve; supported protocols are ${Object.keys(PROTOCOLS).join(', ')}; route skipped`)
    return undefined
  }
  if (route.baseURL === undefined) {
    warn(`pi-auth-bridge: provider "${route.providerId}" is a custom provider without a baseUrl; route skipped`)
    return undefined
  }
  if (route.models.length === 0) {
    warn(`pi-auth-bridge: provider "${route.providerId}" declares no models in models.json; route skipped`)
    return undefined
  }
  const models = materializeModels(route, route.models, { api: route.api as Api, baseUrl: route.baseURL }, warn)
  if (models.length === 0) {
    warn(`pi-auth-bridge: provider "${route.providerId}": no servable models; route skipped`)
    return undefined
  }
  return createProvider({
    id: route.route,
    name: route.displayName,
    baseUrl: route.baseURL,
    auth: routeAuth(route, catalog),
    models,
    api: factory(),
  })
}

/**
 * 为一组路由构建 pi-ai `Models` 集合，把 OAuth 凭据播种进 pi-ai 的
 * **内存**凭据存储，让它自己的刷新机制轮换过期 token。什么都不写盘，
 * 不进 dsh 凭据面，也不回写 `~/.pi`。
 */
export function buildPiModels(routes: readonly RouteDef[], options: { warn?: Warn } = {}): BuiltPiModels {
  const warn = options.warn ?? (() => {})
  const credentials: CredentialStore = new InMemoryCredentialStore()
  const models: MutableModels = createModels({
    credentials,
    authContext: defaultProviderAuthContext(),
  })
  const served: string[] = []
  for (const route of routes) {
    const provider = buildProvider(route, warn)
    if (provider === undefined) continue
    models.setProvider(provider)
    served.push(route.route)
    if (route.oauth !== undefined) {
      const oauth = route.oauth
      // 播种后即忘：pi-ai 在存储锁内刷新；轮换出的 token 只活在当前进程内存中。
      void credentials.modify(route.route, () =>
        Promise.resolve({
          type: 'oauth',
          access: oauth.access,
          refresh: oauth.refresh,
          expires: oauth.expires ?? 0,
        }),
      )
    }
  }
  return { models, served }
}
