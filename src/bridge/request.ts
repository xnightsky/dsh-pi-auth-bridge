/**
 * request.ts：把 dsh 的 GenerateOptions 转换为 pi-ai 的 Context 词汇。
 *
 * 不变量：
 * - 除注入的附件读取器外无 I/O；文本路径（toPiContext）保持同步纯函数。
 * - 图片只在拿到 dsh 持久附件服务时转换：durable 引用经 `readImageRequest`
 *   生成请求版本后以 base64 内联为 pi-ai image 块；缺服务或非 user/tool 角色携带
 *   图片时显式抛 `UNSUPPORTED_CONTENT`，绝不静默丢弃。
 * - dsh-attachment 0.2.1 契约：`readImageRequest` 的 target 是逐附件的
 *   `{width, height, maxBytes}`（由 `requestImageDimensions` 按像素预算换算），
 *   宿主 `validateTarget` 校验正整数——传 `{maxPixels, maxBytes}` 会直接抛错。
 * - 请求级图片字节超预算时不自行卸载：以真实版本字节经 `requiredImageOffload`
 *   计量，抛 `LlmError(IMAGE_OFFLOAD_REQUIRED, { offloadImages })` 由宿主把最老
 *   N 处标记 `offloaded` 后重试；已卸载块经 `projectOffloadedImages` 投影为占位文本。
 * - 开头 system 历史与 options.system 合并；后续 system 与 developer 工具更新
 *   映射为 pi-ai 原生 system 消息，tool 角色映射为 toolResult，保持消息顺序。
 * - 工具调用 arguments 在 pi-ai 历史里是解析后的对象；模型产生的畸形 JSON
 *   容忍为 `{}`，不让历史转换拖垮请求。
 *
 * @module dsh-pi-auth-bridge/request
 */
import {
  contentHasImage,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  requiredImageOffload,
  type ContentBlock,
  type GenerateOptions,
  type RequestMessage as DshMessage,
} from '@deepseek-ai/dsh-llm'
import { requestImageDimensions, type ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import type {
  AssistantMessage as PiAssistantMessage,
  Context as PiContext,
  ImageContent as PiImageContent,
  Message as PiMessage,
  TextContent as PiTextContent,
  JsonObject,
  Usage as PiUsage,
} from '@earendil-works/pi-ai'

/** dsh image 块的持久引用类型（从 ContentBlock 联合抽取，避免直接依赖 dsh-attachment 包）。 */
type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']

/** 单张图片的请求版本：`AttachmentStore.readImageRequest` 返回值的结构性子集。 */
export interface RequestImageVersion {
  /** 编码后的请求字节。 */
  data: Uint8Array
  mediaType: string
  bytes: number
  width: number
  height: number
}

/** 单张图片请求版本的投影策略（像素与编码字节上限）。 */
export interface RequestImagePolicy {
  maxPixels: number
  maxBytes: number
}

/** dsh 持久附件服务的结构性子集：桥接器只读取请求版本，绝不保存或回写。
 * target 直接用契约包类型——2026-09-19 事故证明自造参数类型会与宿主校验静默漂移。 */
export interface ImageAttachmentReader {
  readImageRequest(ref: ImageRef, target: ImageRequestTarget, signal?: AbortSignal): Promise<RequestImageVersion>
}

/** `toPiContextWithImages` 的图片支撑。 */
export interface PiImageSupport {
  /** dsh 组合的持久附件服务（`ctx.get('attachments')`）。 */
  attachments: ImageAttachmentReader
  /** 单次请求全部图片 base64 字节上限（默认 20 MiB；超出时抛 `IMAGE_OFFLOAD_REQUIRED` 由宿主标记卸载后重试）。 */
  maxRequestImageBytes?: number
  /** 单张图片的请求版本策略（默认 2048×2048 像素 / 1 MiB，与官方 dsh-llm-pi-ai 的默认值一致）。 */
  requestImagePolicy?: RequestImagePolicy
}

/** 已准备的请求版本，按 attachmentId 索引。 */
type ImageVersions = ReadonlyMap<string, RequestImageVersion>

const DEFAULT_REQUEST_IMAGE_POLICY: RequestImagePolicy = { maxPixels: 4_194_304, maxBytes: 1_048_576 }
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20_971_520

/** 解析工具调用参数 JSON；容忍模型产出的畸形 JSON，回退为 {}。 */
function parseArguments(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as JsonObject
    }
  } catch {
    /* fall through */
  }
  return {}
}

/** 历史 pi-ai assistant 消息需要的零值 usage。 */
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

/** 拼接一条 dsh 消息的全部文本块。 */
function flattenText(message: DshMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('')
}

/** 把一个图片块展开为 pi-ai 的句柄文本 + base64 图片块。 */
function toPiImage(block: Extract<ContentBlock, { type: 'image' }>, images: ImageVersions | undefined): [PiTextContent, PiImageContent] {
  const version = images?.get(block.attachment.attachmentId)
  if (version === undefined) {
    throw new LlmError('pi-auth-bridge image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  return [
    { type: 'text', text: requestImageHandleText(block.attachment, version) },
    { type: 'image', data: Buffer.from(version.data).toString('base64'), mimeType: version.mediaType },
  ]
}

/** 把一组 dsh 内容块转成 pi-ai 的 user/toolResult 内容；全文本时退化为字符串。 */
function toPiUserContent(blocks: readonly ContentBlock[], images: ImageVersions | undefined): string | (PiTextContent | PiImageContent)[] {
  const content: (PiTextContent | PiImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image':
        content.push(...toPiImage(block, images))
        break
      default:
        break
    }
  }
  if (content.every((piece) => piece.type === 'text')) return content.map((piece) => (piece as PiTextContent).text).join('')
  return content
}

/** 把一条 dsh assistant 消息转换为 provider 中立的 pi-ai 历史消息。 */
function toPiAssistant(message: Extract<DshMessage, { role: 'assistant' }>): PiAssistantMessage {
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

/** 合并请求级系统提示与开头 system 历史；后续 system 保留在历史顺序中。 */
function splitLeadingSystem(options: GenerateOptions): GenerateOptions {
  const prompts = [options.system]
  let end = 0
  for (const message of options.messages) {
    if (message.role !== 'system') break
    prompts.push(flattenText(message))
    end += 1
  }
  const system = prompts.filter(Boolean).join('\n\n')
  const { system: _system, ...rest } = options
  return { ...rest, messages: options.messages.slice(end), ...(system ? { system } : {}) }
}

/** 去除 dsh 工具声明的宿主控制字段。 */
function piTool(tool: NonNullable<GenerateOptions['tools']>[number]) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

/** 把一条 developer 消息映射为 pi-ai 的原生 system update。 */
function appendDeveloper(message: Extract<DshMessage, { role: 'developer' }>, options: GenerateOptions, messages: PiMessage[]): void {
  const content: PiTextContent[] = []
  const toolsAdded: ReturnType<typeof piTool>[] = []
  const toolsRemoved: { name: string }[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'tool-addition': {
        const tool = options.tools?.find((candidate) => candidate.name === block.toolName)
        if (tool === undefined) throw new LlmError(`pi-auth-bridge tool update references undeclared tool "${block.toolName}"`, 'INVALID_REQUEST')
        toolsAdded.push(piTool(tool))
        break
      }
      case 'tool-removal':
        toolsRemoved.push({ name: block.toolName })
        break
      default:
        throw new LlmError(`pi-auth-bridge cannot represent developer content ${block.type}`, 'UNSUPPORTED_CONTENT')
    }
  }
  if (content.length === 0 && toolsAdded.length === 0 && toolsRemoved.length === 0) return
  messages.push({
    role: 'system',
    content,
    timestamp: 0,
    ...(toolsAdded.length > 0 ? { toolsAdded } : {}),
    ...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
  })
}

/** 消息循环主体：images 为 undefined 时任何图片块都在 toPiImage 处显式抛错。 */
function buildMessages(options: GenerateOptions, images: ImageVersions | undefined): PiMessage[] {
  const toolNames = new Map<string, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      const content = flattenText(message)
      if (content.length > 0) messages.push({ role: 'system', content, timestamp: 0 })
      continue
    }
    if (message.role === 'developer') {
      appendDeveloper(message, options, messages)
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
    if (message.role === 'tool') {
      const resultContent = toPiUserContent(message.content, images)
      messages.push({
        role: 'toolResult',
        toolCallId: message.toolCallId,
        toolName: toolNames.get(message.toolCallId) ?? 'unknown',
        content: typeof resultContent === 'string' ? [{ type: 'text', text: resultContent || '(no output)' }] : resultContent,
        isError: message.isError ?? false,
        timestamp: 0,
      })
      continue
    }
    const content = toPiUserContent(message.content, images)
    messages.push({ role: 'user', content, timestamp: 0 })
  }
  return messages
}

/** 组装 pi-ai Context 信封（systemPrompt + messages + tools）。 */
function piContext(options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = options.tools?.filter((tool) => tool.deferLoading !== true).map(piTool)
  return {
    ...(options.system !== undefined ? { systemPrompt: options.system } : {}),
    messages,
    ...(tools !== undefined && tools.length > 0 ? { tools: tools as NonNullable<PiContext['tools']> } : {}),
  }
}

/** 拒绝工具更新错位及 pi-ai 无法表示的图片角色，禁止静默丢块。 */
function assertSupportedHistory(messages: readonly DshMessage[]): void {
  for (const message of messages) {
    if (message.role !== 'developer' && message.content.some((block) => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      throw new LlmError('Tool-change blocks require developer role', 'UNSUPPORTED_CONTENT')
    }
    if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
      throw new LlmError(`pi-auth-bridge cannot represent an image in an in-history ${message.role} message`, 'UNSUPPORTED_CONTENT')
    }
  }
}

/** 收集全部保留图片的引用（按首次出现去重，顺序稳定；宿主已卸载的块不取字节）。 */
function collectImageRefs(blocks: readonly ContentBlock[], refs: Map<string, ImageRef>): void {
  for (const block of blocks) {
    if (block.type === 'image' && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
  }
}

/** 按 ref 各自尺寸换算实际请求 target；小图不放大，适配器与附件读取共用。 */
export function requestImageTarget(ref: ImageRef, policy: RequestImagePolicy = DEFAULT_REQUEST_IMAGE_POLICY): ImageRequestTarget {
  return { ...requestImageDimensions(ref.width, ref.height, policy.maxPixels), maxBytes: policy.maxBytes }
}

/** 为保留的图片并行准备请求版本。 */
async function prepareRequestImages(
  messages: readonly DshMessage[],
  reader: ImageAttachmentReader,
  policy: RequestImagePolicy,
  signal: AbortSignal | undefined,
): Promise<ImageVersions> {
  const refs = new Map<string, ImageRef>()
  for (const message of messages) collectImageRefs(message.content, refs)
  const ordered = [...refs.values()]
  const prepared = await Promise.all(ordered.map((ref) => reader.readImageRequest(ref, requestImageTarget(ref, policy), signal)))
  return new Map(ordered.map((ref, index) => [ref.attachmentId, prepared[index] as RequestImageVersion]))
}

/**
 * 把一个 dsh 请求转换为 pi-ai 的 Context 词汇（同步文本路径）。
 * 含图片时必须走 {@link toPiContextWithImages}；直接调用会显式抛错而非静默丢图。
 */
export function toPiContext(options: GenerateOptions): PiContext {
  assertSupportedHistory(options.messages)
  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError('pi-auth-bridge image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
  }
  const split = splitLeadingSystem(options)
  return piContext(split, buildMessages(split, undefined))
}

/**
 * 把一个含图片的 dsh 请求转换为 pi-ai 的 Context 词汇。持久引用经附件服务
 * 生成请求版本（默认 2048×2048 / 1 MiB 投影）后以 base64 内联；请求级总量
 * 超预算时抛 `IMAGE_OFFLOAD_REQUIRED` 由宿主标记卸载后重试（dsh-llm 0.2.1
 * 契约，路由不自行卸载）；已卸载块投影为稳定的占位文本。
 */
export async function toPiContextWithImages(options: GenerateOptions, images: PiImageSupport): Promise<PiContext> {
  const split = splitLeadingSystem(options)
  assertSupportedHistory(split.messages)
  const policy = images.requestImagePolicy ?? DEFAULT_REQUEST_IMAGE_POLICY
  const maxBytes = images.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
  const versions = await prepareRequestImages(split.messages, images.attachments, policy, split.signal)
  const offloadCount = requiredImageOffload(
    split.messages,
    { representation: 'base64', maxBytes },
    (block) => versions.get(block.attachment.attachmentId)?.bytes ?? block.attachment.bytes,
  )
  if (offloadCount > 0) {
    throw new LlmError(
      `pi-auth-bridge request images exceed the ${maxBytes}-byte base64 bound; ${offloadCount} more oldest occurrence(s) must be offloaded.`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages: offloadCount },
    )
  }
  const exact = { ...split, messages: [...projectOffloadedImages(split.messages, (ref) => offloadedImageText(ref))] }
  return piContext(exact, buildMessages(exact, versions))
}
