/**
 * PiBridgeAdapter: a minimal pi-ai-backed specialization of the dsh LLM
 * adapter seam. Compared with the official `@deepseek-ai/dsh-llm-pi-ai` this
 * adapter has no settings seam, no login flow, no retry policy, and holds
 * every credential in memory only.
 *
 * Protocol obligations honored here (see dsh cookbook "adding an llm adapter"):
 * - `usage` is emitted before the terminal `finish`; nothing follows `finish`.
 * - Tool-call `arguments` stay raw JSON strings; streaming uses `argumentsDelta`.
 * - Block `index` values are assigned in first-appearance order and reused.
 * - Failures surface exactly two ways: `stream()` throws `LlmError` with a
 *   stable code, or a terminal `finish { kind: 'error' | 'aborted' }` chunk.
 * - `options.signal` is honored; early consumer exit aborts the upstream.
 * - Unsupported options throw `LlmError(..., 'UNSUPPORTED_OPTION')`.
 *
 * @module dsh-pi-bridge/adapter
 */
import {
  createModels,
  createProvider,
  defaultProviderAuthContext,
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  isContextOverflow,
  type Api,
  type ApiKeyAuth,
  type AssistantMessage as PiAssistantMessage,
  type AssistantMessageEvent,
  type Context as PiContext,
  type CredentialStore,
  type Message as PiMessage,
  type Model,
  type ModelThinkingLevel,
  type MutableModels,
  type Provider,
  type ProviderAuth,
  type ProviderStreams,
  type SimpleStreamOptions,
  type Usage as PiUsage,
} from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import {
  attributionHeaders,
  CallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message as DshMessage,
  type StreamChunk,
  type TokenUsage,
  type ToolResultBlock,
} from '@deepseek-ai/dsh-llm'
import type { PiModelDef, Warn } from './pi-auth.js'
import type { RouteDef } from './convert.js'

/** Context capacity assumed for a model pi does not size. */
const DEFAULT_CONTEXT_WINDOW = 262_144
/** Output capability assumed for a model pi does not size. */
const DEFAULT_MAX_TOKENS = 32_768

/**
 * The slice of pi-ai's `Models` collection the adapter depends on. Structural,
 * so tests can inject a fake stream without touching pi-ai or the network.
 */
export interface PiModelsLike {
  getModel(provider: string, id: string): Model<Api> | undefined
  getModels(provider: string): readonly Model<Api>[]
  streamSimple(model: Model<Api>, context: PiContext, options?: SimpleStreamOptions): AsyncIterable<AssistantMessageEvent>
}

/** Result of building pi-ai providers for a route set. */
export interface BuiltPiModels {
  models: PiModelsLike
  /** Routes that could actually be served, in input order. */
  served: string[]
}

/* ------------------------------------------------------------------------ */
/* Provider construction (pi-ai side)                                       */
/* ------------------------------------------------------------------------ */

/**
 * Wire protocols a `models.json` custom provider may name, mapped to pi-ai's
 * lazily loaded implementations — the same factories pi-ai's own provider
 * factories use, so a hand-declared route reaches exactly the implementation
 * a catalog route would.
 */
const PROTOCOLS: Record<string, () => ProviderStreams> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi,
}

let catalogIndex: Map<string, Provider> | undefined

/** Installed pi-ai catalog providers by id, constructed once. */
function catalogProviders(): Map<string, Provider> {
  catalogIndex ??= new Map(builtinProviders().map((provider) => [provider.id, provider]))
  return catalogIndex
}

/**
 * Api-key auth for a route the bridge authenticates itself. `Models` calls
 * this after the request-level `apiKey` override has been applied, so a
 * missing key here simply reports "unauthenticated" and lets the wire
 * protocol decide (keyless local endpoints legitimately reach it).
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
 * The auth one route resolves its credential through. A catalog route keeps
 * the installed provider's own auth (preserving its OAuth refresh and ambient
 * discovery); the bridge only adds an api-key method when the catalog
 * provider lacks one but the route names a credential. Non-catalog routes get
 * the bridge's api-key method alone.
 */
function routeAuth(route: RouteDef, catalog: Provider | undefined): ProviderAuth {
  const namesCredential = route.apiKey !== undefined || route.oauth !== undefined
  if (catalog === undefined) return { apiKey: bridgeApiKeyAuth(route.displayName) }
  if (catalog.auth.apiKey !== undefined || !namesCredential) return catalog.auth
  return { ...catalog.auth, apiKey: bridgeApiKeyAuth(route.displayName) }
}

/** Zero pricing for a model the pi catalog does not describe (the harness never reads cost). */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** The one wire protocol a catalog provider's shipped models agree on, when they do. */
function sharedCatalogApi(models: readonly Model<Api>[]): Api | undefined {
  const apis = new Set(models.map((model) => model.api))
  return apis.size === 1 ? apis.values().next().value : undefined
}

/** Materialize pi `models.json` model entries into pi-ai model descriptors. */
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
      warn(`pi-bridge: provider "${route.providerId}": model "${def.id}" has no api and the pi-ai catalog cannot supply one; model skipped`)
      continue
    }
    const baseUrl = fallback.baseUrl ?? base?.baseUrl
    if (baseUrl === undefined) {
      warn(`pi-bridge: provider "${route.providerId}": model "${def.id}" has no baseUrl; model skipped`)
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

/** Reuse an installed catalog provider with this route's identity, models, and auth. */
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
    warn(`pi-bridge: provider "${route.providerId}": no servable models; route skipped`)
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

/** Build the pi-ai provider for one route, or undefined (with a warn) when unservable. */
function buildProvider(route: RouteDef, warn: Warn): Provider | undefined {
  const catalog = catalogProviders().get(route.providerId)
  // A catalog route without a protocol override reuses the installed provider,
  // keeping its API implementations, compatibility quirks, and ambient auth.
  if (catalog !== undefined && route.api === undefined) return reuseCatalogProvider(catalog, route, warn)
  if (catalog === undefined && route.kind === 'builtin') {
    warn(`pi-bridge: provider "${route.providerId}" has credentials but is unknown to the pi-ai catalog and not described by models.json; route skipped`)
    return undefined
  }
  const factory = route.api === undefined ? undefined : PROTOCOLS[route.api]
  if (factory === undefined) {
    warn(`pi-bridge: provider "${route.providerId}" names api "${route.api ?? '(none)'}", which this bridge cannot serve; supported protocols are ${Object.keys(PROTOCOLS).join(', ')}; route skipped`)
    return undefined
  }
  if (route.baseURL === undefined) {
    warn(`pi-bridge: provider "${route.providerId}" is a custom provider without a baseUrl; route skipped`)
    return undefined
  }
  if (route.models.length === 0) {
    warn(`pi-bridge: provider "${route.providerId}" declares no models in models.json; route skipped`)
    return undefined
  }
  const models = materializeModels(route, route.models, { api: route.api as Api, baseUrl: route.baseURL }, warn)
  if (models.length === 0) {
    warn(`pi-bridge: provider "${route.providerId}": no servable models; route skipped`)
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
 * Build the pi-ai `Models` collection for a route set, seeding OAuth
 * credentials into pi-ai's **in-memory** credential store so its own refresh
 * mechanism can rotate expired tokens. Nothing is written to disk, to the dsh
 * credential plane, or back to `~/.pi`.
 */
export function buildPiModels(routes: readonly RouteDef[], options: { warn?: Warn; env?: NodeJS.ProcessEnv } = {}): BuiltPiModels {
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
      // Seed-and-forget: pi-ai refreshes inside the store lock; the rotated
      // token lives and dies in this process's memory.
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

/* ------------------------------------------------------------------------ */
/* Request conversion (dsh -> pi-ai)                                        */
/* ------------------------------------------------------------------------ */

/** Parse tool-call argument JSON; tolerate model malformations with {}. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* fall through */
  }
  return {}
}

/** The zero usage value required by historical pi-ai assistant messages. */
function emptyPiUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/** Recursively detect image blocks (tool results nest content). */
function containsImage(blocks: readonly ContentBlock[]): boolean {
  for (const block of blocks) {
    if (block.type === 'image') return true
    if (block.type === 'tool-result' && containsImage(block.content)) return true
  }
  return false
}

/** Join the text blocks of a dsh message. */
function flattenText(message: DshMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('')
}

/** Flatten text recursively inside one tool result. */
function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool-result') return toolResultText(block.content)
      return ''
    })
    .join('')
}

/** Convert one dsh assistant message into provider-neutral pi-ai history. */
function toPiAssistant(message: DshMessage): PiAssistantMessage {
  const source = message.source.kind === 'model' ? message.source : undefined
  const content: PiAssistantMessage['content'] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        content.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call':
        content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) })
        break
      default:
        break
    }
  }
  return {
    role: 'assistant',
    content,
    api: 'dsh-foreign',
    provider: (source?.provider ?? 'dsh-foreign') as PiAssistantMessage['provider'],
    model: source?.model ?? 'dsh-foreign',
    usage: emptyPiUsage(),
    stopReason: content.some((piece) => piece.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

/** Convert a dsh request into pi-ai's Context vocabulary (text only). */
export function toPiContext(options: GenerateOptions): PiContext {
  const toolNames = new Map<string, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }
    const text = flattenText(message)
    const results = message.content.filter((block): block is ToolResultBlock => block.type === 'tool-result')
    if (text.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content: text, timestamp: 0 })
    }
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{ type: 'text', text: toolResultText(result.content) || '(no output)' }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  const tools = options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  return {
    ...(options.system !== undefined ? { systemPrompt: options.system } : {}),
    messages,
    ...(tools !== undefined && tools.length > 0 ? { tools: tools as NonNullable<PiContext['tools']> } : {}),
  }
}

/* ------------------------------------------------------------------------ */
/* Stream translation (pi-ai events -> dsh chunks)                          */
/* ------------------------------------------------------------------------ */

/** Map pi-ai usage (reasoning folded into output by pi-ai); cache fields appear only when non-zero. */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  }
}

/** Stable provider-neutral failure code for one pi-ai error text. */
function classifyPiAiError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b413\b|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)) return 'TRANSPORT'
  return 'PI_AI_ERROR'
}

/** Map a terminal pi-ai event message to the dsh finish reason. */
export function mapStopReason(message: PiAssistantMessage, contextWindow?: number): FinishReason {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow =
    message.stopReason === 'error' && message.errorMessage !== undefined && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }
  switch (message.stopReason) {
    case 'stop':
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: { message: `model "${message.model}" returned a completed response with no content`, code: EMPTY_RESPONSE_CODE },
        }
      }
      return { kind: 'stop' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'toolUse':
      return { kind: 'tool-calls' }
    case 'aborted':
      return { kind: 'aborted', failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' } }
    default: {
      const text = message.errorMessage ?? 'pi-ai stream error'
      return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
    }
  }
}

/**
 * Translate the pi-ai event stream into StreamChunks, ending with `usage`
 * then `finish`. pi-ai reports failures as terminal `error` events, which map
 * to error/aborted finish chunks — the harness protocol's second error path.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
): AsyncGenerator<StreamChunk> {
  const toolIds = new Map<number, { id: string; name: string }>()
  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: CallId(known?.id ?? ''),
          ...(known !== undefined && known.name.length > 0 ? { name: known.name } : {}),
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: CallId(event.toolCall.id),
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield { type: 'finish', reason: mapStopReason(event.message, contextWindow) }
        return
      case 'error':
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield { type: 'finish', reason: mapStopReason(event.error, contextWindow) }
        return
    }
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}

/* ------------------------------------------------------------------------ */
/* The adapter                                                              */
/* ------------------------------------------------------------------------ */

/** Merge route headers with dsh attribution, removing case-insensitive collisions. */
function requestHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/** Validate an explicit reasoning effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(model: Model<Api>, effort: string | undefined): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  if (getSupportedThinkingLevels(model).some((level) => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(`pi-bridge provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
}

/** Selectable reasoning efforts for one model, or nothing at all. */
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

export interface PiBridgeAdapterOptions {
  /** Warn sink (construction-time skips are reported through it). */
  warn?: Warn
}

/**
 * The frozen-route pi-ai adapter this plugin registers. Routes and the
 * `Models` collection are fixed at construction — pi-bridge has no settings
 * seam, so there is no configuration generation to snapshot.
 */
export class PiBridgeAdapter extends LlmAdapter {
  /** Served route names, in registration order. */
  readonly routes: readonly string[]
  private readonly routeMap: ReadonlyMap<string, RouteDef>
  private readonly models: PiModelsLike

  /**
   * @param routes - frozen route definitions (defensively copied).
   * @param models - pi-ai collection; inject a fake in tests. When omitted,
   *   providers are built from the routes via pi-ai (see {@link buildPiModels}).
   */
  constructor(routes: readonly RouteDef[], models?: PiModelsLike, options: PiBridgeAdapterOptions = {}) {
    super()
    const frozen = routes.map((route) => Object.freeze({ ...route, models: Object.freeze([...route.models]) }) as RouteDef)
    this.routeMap = new Map(frozen.map((route) => [route.route, route]))
    if (models === undefined) {
      const built = buildPiModels(frozen, { warn: options.warn ?? (() => {}) })
      this.models = built.models
      this.routes = Object.freeze(built.served)
    } else {
      this.models = models
      this.routes = Object.freeze(frozen.map((route) => route.route))
    }
  }

  private routeOf(provider: string): RouteDef {
    const route = this.routeMap.get(provider)
    if (route === undefined) throw new LlmError(`pi-bridge adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    return route
  }

  private modelOf(provider: string, model: string): Model<Api> {
    this.routeOf(provider)
    const resolved = this.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-bridge provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
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

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamRoute(options)
  }

  private async *streamRoute(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('pi-bridge does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    const route = this.routeOf(options.provider)
    const model = this.modelOf(options.provider, options.model)
    const effort = resolveReasoningLevel(model, options.reasoningEffort)
    const reasoning = effort === 'off' ? undefined : effort
    if (options.messages.some((message) => containsImage(message.content))) {
      throw new LlmError('pi-bridge v1 does not support image attachments', 'UNSUPPORTED_OPTION')
    }
    const context = toPiContext(options)

    const consumer = new AbortController()
    const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
    const streamOptions: SimpleStreamOptions = {
      ...(route.apiKey === undefined ? {} : { apiKey: route.apiKey }),
      ...(reasoning === undefined ? {} : { reasoning: reasoning as NonNullable<SimpleStreamOptions['reasoning']> }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
      headers: requestHeaders(route.headers),
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
        throw new LlmError('pi-bridge request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      if (!exhausted) {
        consumer.abort('pi-bridge stream consumer stopped')
        try {
          await iterator.return(undefined)
        } catch {
          /* upstream teardown failures after abort are noise */
        }
      }
    }
  }
}
