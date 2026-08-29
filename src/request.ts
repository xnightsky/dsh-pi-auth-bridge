/**
 * request.ts：把 dsh 的 GenerateOptions 转换为 pi-ai 的 Context 词汇。
 *
 * 不变量：
 * - 纯函数、无 I/O；v1 只支持文本（图片由 adapter 在进入本模块前拒绝）。
 * - 历史消息中 role 为 `system` 的消息降级拼平为 user 消息——pi-ai Context
 *   只有一个 systemPrompt 槽位，由 `options.system` 占用；降级保持消息顺序。
 * - 工具调用 arguments 在 pi-ai 历史里是解析后的对象；模型产生的畸形 JSON
 *   容忍为 `{}`，不让历史转换拖垮请求。
 *
 * @module dsh-pi-auth-bridge/request
 */
import type { ContentBlock, GenerateOptions, Message as DshMessage, ToolResultBlock } from '@deepseek-ai/dsh-llm'
import type {
  AssistantMessage as PiAssistantMessage,
  Context as PiContext,
  Message as PiMessage,
  Usage as PiUsage,
} from '@earendil-works/pi-ai'

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

/** 递归检测图片块（tool result 的内容会嵌套）。 */
export function containsImage(blocks: readonly ContentBlock[]): boolean {
  for (const block of blocks) {
    if (block.type === 'image') return true
    if (block.type === 'tool-result' && containsImage(block.content)) return true
  }
  return false
}

/** 拼接一条 dsh 消息的全部文本块。 */
function flattenText(message: DshMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('')
}

/** 递归拼平一个 tool result 内的文本。 */
function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool-result') return toolResultText(block.content)
      return ''
    })
    .join('')
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

/** 把一个 dsh 请求转换为 pi-ai 的 Context 词汇（仅文本）。 */
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
