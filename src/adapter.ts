/**
 * PiAuthBridgeAdapter：dsh LLM 适配器缝的极简 pi-ai 特化。与官方
 * `@deepseek-ai/dsh-llm-pi-ai` 相比，本适配器没有 settings 缝、没有登录
 * 流程、没有 retry 策略，所有凭据只存在于内存。
 *
 * 本模块只是组合层：provider 构建在 provider.ts，请求转换在 request.ts，
 * 流翻译在 stream.ts。此处履行的协议义务（见 dsh cookbook「adding an llm
 * adapter」与 @deepseek-ai/dsh-llm 的归因强制约定）：
 * - 失败只有两条路径：`stream()` 抛带稳定 code 的 `LlmError`，或终态
 *   `finish { kind: 'error' | 'aborted' }` chunk。
 * - 不支持的 option 抛 `LlmError(..., 'UNSUPPORTED_OPTION')`，不静默丢弃。
 * - 遵守 `options.signal`；消费方提前退出会中止上游。
 * - 每次请求都带 `attributionHeaders()` 的 harness 归因头（可替换不可抑制）；
 *   同名自定义头让位，并在构建期 warn。
 * - `authHeader: true` 的路由以 `Authorization: Bearer <key>` 头发送 key，
 *   不再走 pi-ai 的 apiKey override。
 *
 * @module dsh-pi-auth-bridge/adapter
 */
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Warn } from './pi-auth.js'
import type { RouteDef } from './convert.js'
import { buildPiModels, type PiModelsLike } from './provider.js'
import { containsImage, toPiContext } from './request.js'
import { toStreamChunks } from './stream.js'

/**
 * 合并一条路由的自定义头与 dsh 强制归因头。归因永远胜出（dsh-llm 禁止
 * 抑制）；撞名的自定义头在适配器构建期已 warn。`authHeader: true` 的路由
 * 把 key 放进 `Authorization: Bearer`，替代 pi-ai 协议自己的认证头。
 */
function requestHeaders(route: RouteDef): Record<string, string> {
  const headers = { ...route.headers }
  if (route.authHeader === true && route.apiKey !== undefined) {
    headers['Authorization'] = `Bearer ${route.apiKey}`
  }
  return { ...headers, ...attributionHeaders() }
}

/** 校验显式指定的 reasoning effort，不调用 pi-ai 的钳制。 */
function resolveReasoningLevel(model: Model<Api>, effort: string | undefined): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  if (getSupportedThinkingLevels(model).some((level) => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(`pi-auth-bridge provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`, 'UNSUPPORTED_OPTION')
}

/** 一个模型可选的 reasoning effort 列表；不支持 reasoning 则为空。 */
function reasoningInfo(model: Model<Api>): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  return {
    reasoning: {
      efforts: getSupportedThinkingLevels(model).map((level) => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
    },
  }
}

/** PiAuthBridgeAdapter 的构造选项。 */
export interface PiAuthBridgeAdapterOptions {
  /** warn 汇（构建期跳过与请求期异常都经它上报）。 */
  warn?: Warn
}

/**
 * 本插件注册的冻结路由 pi-ai 适配器。路由与 `Models` 集合在构造时固定——
 * pi-auth-bridge 没有 settings 缝，因此没有需要快照的配置代际。
 */
export class PiAuthBridgeAdapter extends LlmAdapter {
  /** 已服务的路由名，按注册顺序。 */
  readonly routes: readonly string[]
  private readonly routeMap: ReadonlyMap<string, RouteDef>
  private readonly models: PiModelsLike
  private readonly warn: Warn

  /**
   * @param routes - 冻结的路由定义（防御性拷贝）。
   * @param models - pi-ai 集合；测试中注入假实现。省略时由路由经 pi-ai
   *   构建 provider（见 {@link buildPiModels}）。
   */
  constructor(routes: readonly RouteDef[], models?: PiModelsLike, options: PiAuthBridgeAdapterOptions = {}) {
    super()
    this.warn = options.warn ?? (() => {})
    const reserved = new Set(Object.keys(attributionHeaders()).map((name) => name.toLowerCase()))
    const frozen = routes.map((route) => {
      if (route.headers !== undefined) {
        const collisions = Object.keys(route.headers).filter((name) => reserved.has(name.toLowerCase()))
        if (collisions.length > 0) {
          this.warn(`pi-auth-bridge: route "${route.route}": header(s) ${collisions.join(', ')} collide with mandatory harness attribution headers and will be overridden`)
        }
      }
      return Object.freeze({ ...route, models: Object.freeze([...route.models]) }) as RouteDef
    })
    this.routeMap = new Map(frozen.map((route) => [route.route, route]))
    if (models === undefined) {
      const built = buildPiModels(frozen, { warn: this.warn })
      this.models = built.models
      this.routes = Object.freeze(built.served)
    } else {
      this.models = models
      this.routes = Object.freeze(frozen.map((route) => route.route))
    }
  }

  private routeOf(provider: string): RouteDef {
    const route = this.routeMap.get(provider)
    if (route === undefined) throw new LlmError(`pi-auth-bridge adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    return route
  }

  private modelOf(provider: string, model: string): Model<Api> {
    this.routeOf(provider)
    const resolved = this.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-auth-bridge provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.routeMap.get(provider)?.displayName ?? provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      this.routeOf(provider)
      return this.models.getModels(provider).map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const resolved = this.modelOf(provider, model)
      return {
        provider,
        id: model,
        name: resolved.name,
        inputModalities: [...resolved.input],
        context: { contextWindow: resolved.contextWindow },
        ...reasoningInfo(resolved),
      }
    })
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('pi-auth-bridge does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    const route = this.routeOf(options.provider)
    const model = this.modelOf(options.provider, options.model)
    const effort = resolveReasoningLevel(model, options.reasoningEffort)
    const reasoning = effort === 'off' ? undefined : effort
    if (options.messages.some((message) => containsImage(message.content))) {
      throw new LlmError('pi-auth-bridge v1 does not support image attachments', 'UNSUPPORTED_OPTION')
    }
    const context = toPiContext(options)

    const consumer = new AbortController()
    const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
    const streamOptions: SimpleStreamOptions = {
      // authHeader 路由的 key 在 Authorization 头里携带，不再走 apiKey override。
      ...(route.apiKey === undefined || route.authHeader === true ? {} : { apiKey: route.apiKey }),
      ...(reasoning === undefined ? {} : { reasoning: reasoning as NonNullable<SimpleStreamOptions['reasoning']> }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
      headers: requestHeaders(route),
      signal: upstream,
      maxRetries: 0,
    }
    const iterator = toStreamChunks(this.models.streamSimple(model, context, streamOptions), model.contextWindow)[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await iterator.next()
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw new LlmError('pi-auth-bridge request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      if (!exhausted) {
        consumer.abort('pi-auth-bridge stream consumer stopped')
        try {
          await iterator.return(undefined)
        } catch (error) {
          // 流已拆除，这里的失败只上报，不向外抛（finally 里抛出会掩盖主错误）。
          this.warn(`pi-auth-bridge: upstream teardown failed after abort: ${(error as Error).message}`)
        }
      }
    }
  }
}
