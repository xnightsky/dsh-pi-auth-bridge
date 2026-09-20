/**
 * Typert 产物共享段：`BridgeStatus` 的 zod 投影与 `status` 调用描述符，
 * 被 host 面清单（typert.host.ts）与 client 面投影（typert.remote-client.ts）
 * 共同引用。
 *
 * 为什么手写而不是跑官方生成器：`@deepseek-ai/dsh-typert-generator` 的
 * 发现逻辑绑定 monorepo 布局（workspace 根 `tsconfig.host.json` + 包必须
 * 位于 `<root>/packages/` 下，0.1.6-alpha.2 实证），本仓是独立单包仓库，
 * 无法被其发现。产物改为手写并锚定在协议包的公开类型上
 * （`InvocationDescriptor` / `TypertRemoteContribution`，typecheck 期校验），
 * 另由 tests/typert-artifacts.test.ts 用真实 registry 与真实状态快照回归。
 *
 * @module dsh-pi-auth-bridge/typert-common
 */
import { z } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

/** 包名：TYPERT 清单的属主校验（`manifest.package === pkgName`）以此为准。 */
export const TYPERT_PACKAGE = 'dsh-pi-auth-bridge'

/** `BridgeModelStatus` 的 zod 投影。 */
const modelStatusSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().int().nonnegative().optional(),
  input: z.array(z.string()),
})

/** `BridgeRouteStatus` 的 zod 投影（与 status.ts 的接口逐字段对应）。 */
const routeStatusSchema = z.object({
  id: z.string(),
  provider: z.string(),
  kind: z.enum(['builtin', 'custom']),
  api: z.string().optional(),
  credential: z.enum(['api_key', 'oauth', 'none']),
  models: z.number(),
  modelList: z.array(modelStatusSchema).optional(),
})

/** `CapabilityProbeOutcome` 的 zod 投影。 */
const capabilityProbeOutcomeSchema = z.object({
  capability: z.enum(['text', 'image', 'reasoning', 'toolCall']),
  verdict: z.enum(['ok', 'failed', 'skipped', 'inconclusive']),
  latencyMs: z.number().nonnegative(),
  message: z.string().optional(),
  detail: z.string().optional(),
})

/** `ModelProbeReport` 的 zod 投影。 */
const modelProbeReportSchema = z.object({
  route: z.string(),
  model: z.string(),
  at: z.number(),
  ok: z.boolean(),
  latencyMs: z.number().nonnegative(),
  outcomes: z.array(capabilityProbeOutcomeSchema),
})

/** `BridgeStatus` 的 zod 投影（与 status.ts 的接口逐字段对应）。 */
const bridgeStatusSchema = z.object({
  phase: z.enum(['bridged', 'empty']),
  reason: z.enum(['llm-missing', 'pi-dir-not-found', 'pi-config-unreadable', 'no-credentials', 'no-servable-routes']).optional(),
  detail: z.string().optional(),
  piDir: z.string().optional(),
  routes: z.array(routeStatusSchema),
  proxy: z.object({ enabled: z.boolean(), detected: z.boolean() }),
  warnings: z.array(z.string()),
  config: z
    .object({
      providers: z.array(z.string()).optional(),
      includeOAuth: z.boolean(),
      commandTimeoutMs: z.number().int().nonnegative(),
    })
    .optional(),
  selfChecks: z.array(z.object({ id: z.string(), ok: z.boolean(), message: z.string().optional() })).optional(),
  recentErrors: z
    .array(z.object({ at: z.number(), route: z.string(), model: z.string().optional(), code: z.string(), message: z.string() }))
    .optional(),
  versions: z
    .object({
      plugin: z.string(),
      dshLlm: z.string().optional(),
      dshAttachment: z.string().optional(),
      piAi: z.string().optional(),
    })
    .optional(),
  probes: z.record(z.string(), modelProbeReportSchema).optional(),
})

/** `ProbeRequest` 的 zod 投影。 */
const probeRequestSchema = z.object({
  route: z.string(),
  model: z.string(),
  capability: z.enum(['text', 'image', 'reasoning', 'toolCall']).optional(),
})

/** `ProbeResult` 的 zod 投影（判别联合：成功带报告 / 失败带错误码）。 */
const probeResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), report: modelProbeReportSchema }),
  z.object({ ok: z.literal(false), route: z.string(), model: z.string(), code: z.string(), message: z.string() }),
])

/** `piAuthBridge/status` 调用描述符：无参数、直接接收者、严格结果编解码。 */
export const statusInvocation: InvocationDescriptor = {
  id: 'dsh-pi-auth-bridge#piAuthBridge/status',
  service: 'piAuthBridge',
  namespace: 'piAuthBridge',
  method: 'status',
  invocation: { kind: 'direct' },
  parameters: [],
  result: {
    mode: 'strict',
    typeSymbol: 'dsh-pi-auth-bridge#BridgeStatus',
    create: () => bridgeStatusSchema,
  },
  sourceLocation: { file: 'src/panel/status-service.ts', line: 38, column: 3 },
}

/** `piAuthBridge/probe` 调用描述符：单参数（JSON request）、直接接收者、严格编解码。 */
export const probeInvocation: InvocationDescriptor = {
  id: 'dsh-pi-auth-bridge#piAuthBridge/probe',
  service: 'piAuthBridge',
  namespace: 'piAuthBridge',
  method: 'probe',
  invocation: { kind: 'direct' },
  parameters: [
    {
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: 'dsh-pi-auth-bridge#ProbeRequest',
        create: () => probeRequestSchema,
      },
    },
  ],
  result: {
    mode: 'strict',
    typeSymbol: 'dsh-pi-auth-bridge#ProbeResult',
    create: () => probeResultSchema,
  },
  sourceLocation: { file: 'src/panel/status-service.ts', line: 50, column: 3 },
}
