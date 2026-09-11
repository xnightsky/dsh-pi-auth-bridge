/**
 * request.ts：把 dsh 的 GenerateOptions 转换为 pi-ai 的 Context 词汇。
 *
 * 不变量：
 * - 除注入的附件读取器外无 I/O；文本路径（toPiContext）保持同步纯函数。
 * - 图片只在拿到 dsh 持久附件服务时转换：durable 引用经 `readImageRequest`
 *   生成请求版本后以 base64 内联为 pi-ai image 块；缺服务或非 user 角色携带
 *   图片时显式抛 `UNSUPPORTED_CONTENT`，绝不静默丢弃。
 * - 历史消息中 role 为 `system` 的消息降级拼平为 user 消息——pi-ai Context
 *   只有一个 systemPrompt 槽位，由 `options.system` 占用；降级保持消息顺序。
 * - 工具调用 arguments 在 pi-ai 历史里是解析后的对象；模型产生的畸形 JSON
 *   容忍为 `{}`，不让历史转换拖垮请求。
 *
 * @module dsh-pi-auth-bridge/request
 */
import {
  contentHasImage,
  LlmError,
  offloadedImageText,
  offloadRequestImagesWithPolicy,
  requestImageHandleText,
  type ContentBlock,
  type GenerateOptions,
  type Message as DshMessage,
  type ToolResultBlock,
} from '@deepseek-ai/dsh-llm'
import type {
  AssistantMessage as PiAssistantMessage,
  Context as PiContext,
  ImageContent as PiImageContent,
  Message as PiMessage,
  TextContent as PiTextContent,
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

/** dsh 持久附件服务的结构性子集：桥接器只读取请求版本，绝不保存或回写。 */
export interface ImageAttachmentReader {
  readImageRequest(ref: ImageRef, policy: RequestImagePolicy, signal?: AbortSignal): Promise<RequestImageVersion>
}

/** `toPiContextWithImages` 的图片支撑。 */
export interface PiImageSupport {
  /** dsh 组合的持久附件服务（`ctx.get('attachments')`）。 */
  attachments: ImageAttachmentReader
  /** 单次请求全部图片 base64 字节上限（默认 20 MiB；超出按 dsh-llm 量化策略从最老图片起替换为占位文本）。 */
  maxRequestImageBytes?: number
  /** 单张图片的请求版本策略（默认 2048×2048 像素 / 1 MiB，与官方 dsh-llm-pi-ai 的默认值一致）。 */
  requestImagePolicy?: RequestImagePolicy
}

/** 已准备的请求版本，按 attachmentId 索引。 */
type ImageVersions = ReadonlyMap<string, RequestImageVersion>

const DEFAULT_REQUEST_IMAGE_POLICY: RequestImagePolicy = { maxPixels: 4_194_304, maxBytes: 1_048_576 }
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20_971_520

/** 解析工具调用参数 JSON；容忍模型产出的畸形 JSON，回退为 {}。 */
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
      case 'tool-result': {
        const nested = toPiUserContent(block.content, images)
        if (typeof nested === 'string') {
          if (nested.length > 0) content.push({ type: 'text', text: nested })
        } else {
          content.push(...nested)
        }
        break
      }
      default:
        break
    }
  }
  if (content.every((piece) => piece.type === 'text')) return content.map((piece) => (piece as PiTextContent).text).join('')
  return content
}

/** 把一条 dsh assistant 消息转换为 provider 中立的 pi-ai 历史消息。 */
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

/** 消息循环主体：images 为 undefined 时任何图片块都在 toPiImage 处显式抛错。 */
function buildMessages(options: GenerateOptions, images: ImageVersions | undefined): PiMessage[] {
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
    const content = toPiUserContent(message.content.filter((block) => block.type !== 'tool-result'), images)
    const results = message.content.filter((block): block is ToolResultBlock => block.type === 'tool-result')
    if (content.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content, timestamp: 0 })
    }
    for (const result of results) {
      const resultContent = toPiUserContent(result.content, images)
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: typeof resultContent === 'string' ? [{ type: 'text', text: resultContent || '(no output)' }] : resultContent,
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  return messages
}

/** 组装 pi-ai Context 信封（systemPrompt + messages + tools）。 */
function piContext(options: GenerateOptions, messages: PiMessage[]): PiContext {
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

/** pi-ai 只能回放 user 角色里的图片；其他角色携带图片提前显式拒绝。 */
function assertSupportedImageRoles(messages: readonly DshMessage[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(`pi-auth-bridge cannot represent an image in an in-history ${message.role} message`, 'UNSUPPORTED_CONTENT')
    }
  }
}

/** 收集全部图片引用（按首次出现去重，顺序稳定；tool result 的内容会嵌套）。 */
function collectImageRefs(blocks: readonly ContentBlock[], refs: Map<string, ImageRef>): void {
  for (const block of blocks) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

/** 为卸载后保留的图片并行准备请求版本。 */
async function prepareRequestImages(
  messages: readonly DshMessage[],
  reader: ImageAttachmentReader,
  policy: RequestImagePolicy,
  signal: AbortSignal | undefined,
): Promise<ImageVersions> {
  const refs = new Map<string, ImageRef>()
  for (const message of messages) collectImageRefs(message.content, refs)
  const ordered = [...refs.values()]
  const prepared = await Promise.all(ordered.map((ref) => reader.readImageRequest(ref, policy, signal)))
  return new Map(ordered.map((ref, index) => [ref.attachmentId, prepared[index] as RequestImageVersion]))
}

/** 以 base64 表示按请求级字节预算卸载最老的图片（两遍：先按估值，再按真实版本长度）。 */
function offloadImages(messages: readonly DshMessage[], maxBytes: number, byteLength: (ref: ImageRef) => number): readonly DshMessage[] {
  return offloadRequestImagesWithPolicy(messages, {
    representation: 'base64',
    maxBytes,
    byteQuantum: 1,
    byteLength,
    placeholder: (ref) => offloadedImageText(ref),
  })
}

/**
 * 把一个 dsh 请求转换为 pi-ai 的 Context 词汇（同步文本路径）。
 * 含图片时必须走 {@link toPiContextWithImages}；直接调用会显式抛错而非静默丢图。
 */
export function toPiContext(options: GenerateOptions): PiContext {
  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError('pi-auth-bridge image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
  }
  return piContext(options, buildMessages(options, undefined))
}

/**
 * 把一个含图片的 dsh 请求转换为 pi-ai 的 Context 词汇。持久引用经附件服务
 * 生成请求版本（默认 2048×2048 / 1 MiB 投影）后以 base64 内联；请求级总量
 * 超预算时按 dsh-llm 量化策略把最老图片替换为稳定的占位文本。
 */
export async function toPiContextWithImages(options: GenerateOptions, images: PiImageSupport): Promise<PiContext> {
  assertSupportedImageRoles(options.messages)
  const policy = images.requestImagePolicy ?? DEFAULT_REQUEST_IMAGE_POLICY
  const maxBytes = images.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
  const bound = offloadImages(options.messages, maxBytes, (ref) => Math.min(ref.bytes, policy.maxBytes))
  const versions = await prepareRequestImages(bound, images.attachments, policy, options.signal)
  const exact = offloadImages(bound, maxBytes, (ref) => versions.get(ref.attachmentId)?.bytes ?? ref.bytes)
  return piContext({ ...options, messages: exact as DshMessage[] }, buildMessages({ ...options, messages: exact as DshMessage[] }, versions))
}
