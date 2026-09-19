/**
 * 能力探测：模型 × 能力交叉矩阵（text / image / reasoning / toolCall）。
 * 所有探测都走 `PiAuthBridgeAdapter` 的完整管线（dsh GenerateOptions →
 * 请求转换 → 流翻译），逐一回归历史故障点：图片 offload 契约（09-19 事故）、
 * reasoning 档位、tool-call argumentsDelta、usage→finish 协议。
 *
 * 探测是用户点击触发的真实 API 调用（maxTokens 极小），不是后台轮询；
 * 支持按维度单测（`ProbeRequest.capability`）。每个 outcome 携带 `detail`
 * 诊断串（终态/usage/回复预览/target 形状/异常类型），并同步写 host 日志
 * ——出问题时不必重跑即可回溯。
 *
 * @module dsh-pi-auth-bridge/probe
 */
import { Buffer } from 'node:buffer'
import {
  LlmError,
  MessageId,
  type ContentBlock,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type Message as DshMessage,
  type ReasoningEffortId,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import type { PiAuthBridgeAdapter } from './adapter.js'
import type { ImageAttachmentReader } from './request.js'
import type { CapabilityProbeOutcome, ModelProbeReport, ProbeCapability, ProbeRequest, ProbeResult, ProbeVerdict } from './status.js'

/** 文本/图片/工具探测超时（毫秒）。 */
const PROBE_TIMEOUT_MS = 45_000
/** 推理探测超时（毫秒，思考链更长）。 */
const REASONING_TIMEOUT_MS = 90_000

/** 1×1 红色 PNG：图片探测的固定输入（恒定、极小、合法）。 */
const PROBE_IMAGE_BYTES: Uint8Array = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 探测日志汇（host logger 的 info/warn 子集）。 */
export interface ProbeLogger {
  info: (message: string) => void
  warn: (message: string) => void
}

/** 图片探测 reader + 最近一次收到的 target（诊断用）。 */
interface ProbeImageReader {
  reader: ImageAttachmentReader
  lastTarget: () => ImageRequestTarget | undefined
}

/**
 * 图片探测的附件 reader：返回固定 1×1 PNG；并校验桥换算出的 target 形状
 * ——dsh-attachment 0.1.6 契约要求 `{width, height, maxBytes}` 正整数
 * （2026-09-19 事故：target 形状漂移导致全部图片请求失败）。形状不对时
 * 图片探测必失败，绝不静默通过。
 */
function createProbeImageReader(): ProbeImageReader {
  let last: ImageRequestTarget | undefined
  return {
    reader: {
      readImageRequest: (_ref, target: ImageRequestTarget) => {
        last = target
        const valid =
          Number.isInteger(target.width) && target.width > 0 &&
          Number.isInteger(target.height) && target.height > 0 &&
          Number.isInteger(target.maxBytes) && target.maxBytes > 0
        if (!valid) {
          throw new Error(`malformed image request target: ${JSON.stringify(target)}`)
        }
        return Promise.resolve({
          data: new Uint8Array(PROBE_IMAGE_BYTES),
          mediaType: 'image/png',
          bytes: PROBE_IMAGE_BYTES.length,
          width: 1,
          height: 1,
        })
      },
    },
    lastTarget: () => last,
  }
}

let messageSeq = 0

/** 构造探测用的 dsh user 消息。 */
function probeMessage(content: ContentBlock[]): DshMessage {
  messageSeq += 1
  return { id: MessageId(`probe-${messageSeq}`), role: 'user', content, source: { kind: 'user' } }
}

/** 探测用的图片块（durable ref 指向固定 1×1 PNG）。 */
function probeImageBlock(): ContentBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: 'probe-image',
      mediaType: 'image/png',
      bytes: PROBE_IMAGE_BYTES.length,
      width: 1,
      height: 1,
      name: 'probe.png',
    },
  } as unknown as ContentBlock
}

/** 探测用的回声工具定义。 */
const PROBE_TOOL: ToolSchema = {
  name: 'probe_echo',
  description: 'Echo probe: call it exactly once with the requested value.',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
}

/** 流消费结果（协议校验与诊断的原始材料）。 */
interface Consumption {
  text: string
  toolCalls: number
  sawUsage: boolean
  finishKind: string | undefined
  failure: { code: string; message: string } | undefined
}

/** 消费一条 dsh 流，采集文本/工具调用/usage/终态。 */
async function consume(stream: AsyncIterable<StreamChunk>): Promise<Consumption> {
  const result: Consumption = { text: '', toolCalls: 0, sawUsage: false, finishKind: undefined, failure: undefined }
  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta':
        result.text += chunk.text
        break
      case 'block-start':
        // 每次工具调用一个 block-start（delta 计数会重复）。
        if (chunk.blockType === 'tool-call') result.toolCalls += 1
        break
      case 'usage':
        result.sawUsage = true
        break
      case 'finish':
        result.finishKind = chunk.reason.kind
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          result.failure = { code: chunk.reason.failure.code ?? chunk.reason.kind, message: chunk.reason.failure.message }
        }
        break
      default:
        break
    }
  }
  return result
}

/** 一次探测判定的产出。 */
interface Verdict {
  verdict: ProbeVerdict
  message?: string
  detail?: string
}

/** 诊断串：终态、usage 是否到达、回复预览、工具调用次数。 */
function consumptionDetail(consumption: Consumption): string {
  const parts = [
    `finish=${consumption.finishKind ?? 'none'}`,
    consumption.sawUsage ? 'usage ✓' : 'usage ✗',
  ]
  if (consumption.toolCalls > 0) parts.push(`calls=${consumption.toolCalls}`)
  const preview = consumption.text.trim().slice(0, 80)
  if (preview.length > 0) parts.push(`回复 "${preview}"`)
  return parts.join(' · ')
}

/** 通用生成判定：终态正常 + usage 先于 finish（协议义务）。 */
function generationVerdict(consumption: Consumption): Verdict {
  const detail = consumptionDetail(consumption)
  if (consumption.failure !== undefined) {
    return { verdict: 'failed', message: `${consumption.failure.code}: ${consumption.failure.message}`, detail }
  }
  if (consumption.finishKind !== 'stop' && consumption.finishKind !== 'max-tokens') {
    return { verdict: 'failed', message: `unexpected finish kind: ${consumption.finishKind ?? '(stream ended without finish)'}`, detail }
  }
  if (!consumption.sawUsage) {
    return { verdict: 'failed', message: 'usage chunk missing before finish (protocol violation)', detail }
  }
  const preview = consumption.text.trim().slice(0, 80)
  return preview.length > 0 ? { verdict: 'ok', message: preview, detail } : { verdict: 'ok', detail }
}

/** 单项能力的异常兜底：探测本身绝不向上抛；detail 记录异常类型（区分超时/上游错误）。 */
function failedOutcome(capability: ProbeCapability, started: number, error: unknown): CapabilityProbeOutcome {
  const cause = error as Error
  return {
    capability,
    verdict: 'failed',
    latencyMs: Date.now() - started,
    message: error instanceof LlmError ? `${error.code}: ${error.message}` : cause.message,
    detail: `exception=${cause.name}`,
  }
}

/** 包一层耗时统计与异常兜底。 */
async function runProbe(capability: ProbeCapability, body: () => Promise<Verdict>): Promise<CapabilityProbeOutcome> {
  const started = Date.now()
  try {
    const { verdict, message, detail } = await body()
    return {
      capability,
      verdict,
      latencyMs: Date.now() - started,
      ...(message !== undefined ? { message } : {}),
      ...(detail !== undefined ? { detail } : {}),
    }
  } catch (error) {
    return failedOutcome(capability, started, error)
  }
}

function textProbe(adapter: PiAuthBridgeAdapter, route: string, model: string): () => Promise<CapabilityProbeOutcome> {
  return () => runProbe('text', async () => {
    const consumption = await consume(adapter.stream({
      provider: route,
      model,
      messages: [probeMessage([{ type: 'text', text: 'Ping. Reply with exactly one word.' }])],
      maxTokens: 16,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }))
    return generationVerdict(consumption)
  })
}

function imageProbe(adapter: PiAuthBridgeAdapter, route: string, model: string): () => Promise<CapabilityProbeOutcome> {
  return () => runProbe('image', async () => {
    const probeReader = createProbeImageReader()
    const consumption = await consume(adapter.streamWithAttachments({
      provider: route,
      model,
      messages: [probeMessage([probeImageBlock(), { type: 'text', text: 'What color is this image? Answer with one word.' }])],
      maxTokens: 16,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }, probeReader.reader))
    const verdict = generationVerdict(consumption)
    const target = probeReader.lastTarget()
    const targetDetail = target === undefined ? 'target=未到达 reader' : `target=${target.width}×${target.height}/${target.maxBytes}B`
    return { ...verdict, detail: `${targetDetail} · ${verdict.detail ?? ''}` }
  })
}

function reasoningProbe(adapter: PiAuthBridgeAdapter, route: string, model: string, effort: ReasoningEffortId): () => Promise<CapabilityProbeOutcome> {
  return () => runProbe('reasoning', async () => {
    const consumption = await consume(adapter.stream({
      provider: route,
      model,
      messages: [probeMessage([{ type: 'text', text: 'What is 17 + 25? Think briefly, then answer with the number only.' }])],
      reasoningEffort: effort,
      // 推理模型会先烧思考预算；给足下限避免必然 max-tokens。
      maxTokens: 1024,
      signal: AbortSignal.timeout(REASONING_TIMEOUT_MS),
    }))
    const verdict = generationVerdict(consumption)
    return { ...verdict, detail: `effort=${effort} · ${verdict.detail ?? ''}` }
  })
}

function toolCallProbe(adapter: PiAuthBridgeAdapter, route: string, model: string): () => Promise<CapabilityProbeOutcome> {
  return () => runProbe('toolCall', async () => {
    const consumption = await consume(adapter.stream({
      provider: route,
      model,
      messages: [probeMessage([{ type: 'text', text: 'Call the probe_echo tool exactly once with value "ok". Do not reply with plain text.' }])],
      tools: [PROBE_TOOL],
      maxTokens: 128,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }))
    const detail = consumptionDetail(consumption)
    if (consumption.failure !== undefined) {
      return { verdict: 'failed', message: `${consumption.failure.code}: ${consumption.failure.message}`, detail }
    }
    if (!consumption.sawUsage) {
      return { verdict: 'failed', message: 'usage chunk missing before finish (protocol violation)', detail }
    }
    if (consumption.toolCalls > 0 || consumption.finishKind === 'tool-calls') {
      return { verdict: 'ok', detail }
    }
    return { verdict: 'inconclusive', message: 'model answered with text instead of calling the tool', detail }
  })
}

/** 取探测用的 reasoning 档位：优先 `low`，否则第一个可用档。 */
function probeEffort(resolved: LlmResolvedModelInfo): ReasoningEffortId | undefined {
  const efforts = resolved.reasoning?.efforts ?? []
  if (efforts.length === 0) return undefined
  return (efforts.find((effort) => effort.id === 'low') ?? efforts[0])?.id
}

/** 不适用的维度直接产出 skipped（不发请求）。 */
function skipped(capability: ProbeCapability, message: string): CapabilityProbeOutcome {
  return { capability, verdict: 'skipped', latencyMs: 0, message, detail: '模型声明不支持该维度' }
}

/**
 * 对一个模型跑探测（顺序执行，避免并发触发限流）。`only` 指定时只跑该
 * 维度（按维度单测）。路由/模型不存在等前置错误向上抛（由 handler 映射）。
 */
export async function probeModel(
  adapter: PiAuthBridgeAdapter,
  route: string,
  model: string,
  only?: ProbeCapability,
): Promise<ModelProbeReport> {
  const started = Date.now()
  const resolved = await adapter.resolveModel(route, model)

  const input = resolved.inputModalities ?? []
  const effort = probeEffort(resolved)
  const plan: [ProbeCapability, () => Promise<CapabilityProbeOutcome>][] = [
    ['text', textProbe(adapter, route, model)],
    ['image', input.includes('image')
      ? imageProbe(adapter, route, model)
      : () => Promise.resolve(skipped('image', 'model declares no image input'))],
    ['reasoning', effort !== undefined
      ? reasoningProbe(adapter, route, model, effort)
      : () => Promise.resolve(skipped('reasoning', 'model has no reasoning support'))],
    ['toolCall', toolCallProbe(adapter, route, model)],
  ]
  const selected = only === undefined ? plan : plan.filter(([capability]) => capability === only)

  const outcomes: CapabilityProbeOutcome[] = []
  for (const [, run] of selected) {
    outcomes.push(await run())
  }
  return {
    route,
    model,
    at: Date.now(),
    ok: outcomes.every((outcome) => outcome.verdict !== 'failed'),
    latencyMs: Date.now() - started,
    outcomes,
  }
}

/**
 * 装配 Remote 探测处理器：前置错误（未知路由/模型）映射为业务失败；
 * 每次探测（开始 + 每维结果 + 失败）写 host 日志，事后可回溯。
 */
export function createProbeHandler(
  adapter: PiAuthBridgeAdapter,
  logger?: ProbeLogger,
): (request: ProbeRequest) => Promise<ProbeResult> {
  return async (request) => {
    const scope = request.capability === undefined ? '全维度' : `单维 ${request.capability}`
    logger?.info(`pi-auth-bridge: probe ${request.route}/${request.model}（${scope}）开始`)
    try {
      const report = await probeModel(adapter, request.route, request.model, request.capability)
      for (const outcome of report.outcomes) {
        const line =
          `pi-auth-bridge: probe ${report.route}/${report.model} ${outcome.capability} → ${outcome.verdict} ` +
          `(${outcome.latencyMs}ms)${outcome.detail !== undefined ? ` · ${outcome.detail}` : ''}`
        if (outcome.verdict === 'failed') {
          logger?.warn(line)
        } else {
          logger?.info(line)
        }
      }
      return { ok: true, report }
    } catch (error) {
      logger?.warn(`pi-auth-bridge: probe ${request.route}/${request.model} 启动失败: ${(error as Error).message}`)
      return {
        ok: false,
        route: request.route,
        model: request.model,
        code: error instanceof LlmError ? error.code : 'PROBE_FAILED',
        message: (error as Error).message,
      }
    }
  }
}
