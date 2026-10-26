/**
 * 请求历史边界回归：合并开头 system 前拒绝非法内容，禁止静默丢块或读取附件。
 * 不变量：只使用内存图片 fixture，不访问用户配置或网络。
 */
import { describe, expect, it, vi } from 'vitest'
import { MessageId, type ContentBlock, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { toPiContext, toPiContextWithImages } from '../src/bridge/request.js'

const image: ContentBlock = {
  type: 'image',
  attachment: { attachmentId: AttachmentId('history-image'), mediaType: 'image/png', bytes: 3, width: 4, height: 4 },
}

function request(systemContent: ContentBlock[]): GenerateOptions {
  return {
    provider: 'test',
    model: 'test',
    messages: [
      { id: MessageId('system'), role: 'system', source: { kind: 'system-prompt' }, content: systemContent },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ],
  }
}

function imageReader() {
  return {
    readImageRequest: vi.fn(async () => ({
      data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', bytes: 3, width: 4, height: 4,
    })),
  }
}

const unsupported: { name: string; block: ContentBlock }[] = [
  { name: 'image', block: image },
  { name: 'reasoning', block: { type: 'reasoning', text: 'must not disappear' } },
  { name: 'tool addition', block: { type: 'tool-addition', toolName: 'new-tool' } },
]

describe.each(['text', 'image'] as const)('%s request history validation', (path) => {
  it.each(unsupported)('rejects leading system $name before reading attachments', async ({ block }) => {
    const attachments = imageReader()
    const options = request([{ type: 'text', text: 'base instructions' }, block])
    await expect(Promise.resolve().then(() => path === 'text'
      ? toPiContext(options)
      : toPiContextWithImages(options, { attachments }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(attachments.readImageRequest).not.toHaveBeenCalled()
  })
})

it('keeps valid leading system instructions while converting a user image', async () => {
  const attachments = imageReader()
  const options = request([{ type: 'text', text: 'base instructions' }])
  options.system = 'one-shot instructions'
  options.messages.push({ role: 'user', content: [image] })
  const context = await toPiContextWithImages(options, { attachments })
  expect(context.systemPrompt).toBe('one-shot instructions\n\nbase instructions')
  expect(context.messages.map((message) => message.role)).toEqual(['user', 'user'])
  expect(attachments.readImageRequest).toHaveBeenCalledOnce()
  const last = context.messages.at(-1)
  expect(last?.role === 'user' && Array.isArray(last.content) && last.content.some((block) => block.type === 'image')).toBe(true)
})
