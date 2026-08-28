/**
 * pi-bridge: a dsh plugin that bridges the local pi (Pi coding agent)
 * installation's auth (`auth.json` + `models.json`) into dsh LLM routes.
 *
 * Zero configuration, in-memory only: credentials are read from pi's files at
 * mount time and never written anywhere — not to the dsh credential store,
 * not back to `~/.pi`, not to any temporary file. When pi is not installed
 * (or yields no servable route) the plugin mounts empty with a warning
 * instead of failing the composition.
 *
 * Follows the official dsh plugin (bundle) convention: exports
 * `name` / `inject: ['llm']` / `Config` / `apply`, and the package declares
 * `dsh.bundle.patch` → root `cordis.patch.yml`. It can also be inserted by
 * absolute path into any cordis layer for development:
 *
 * ```yaml
 * # cordis.yml
 * - insert: [{ id: pi-bridge, name: '/abs/path/pi-bridge/src/index.ts' }]
 * ```
 *
 * @module dsh-pi-bridge
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { locatePiDir } from './pi-locator.js'
import { createValueResolver, readPiAuth, readPiModels, type Warn } from './pi-auth.js'
import { buildRoutes } from './convert.js'
import { PiBridgeAdapter } from './adapter.js'

export { locatePiDir } from './pi-locator.js'
export { PiBridgeError, createValueResolver, readPiAuth, readPiModels, resolvePiValue } from './pi-auth.js'
export type { PiAuthEntry, PiModelDef, PiModelsFile, PiProviderDef } from './pi-auth.js'
export { buildRoutes } from './convert.js'
export type { RouteDef } from './convert.js'
export { buildPiModels, mapStopReason, mapUsage, PiBridgeAdapter, toPiContext, toStreamChunks } from './adapter.js'
export type { BuiltPiModels, PiModelsLike } from './adapter.js'

export const name = 'pi-bridge'

/**
 * LLM 适配器插件的官方约定：声明对 `llm` 服务（`@deepseek-ai/dsh-llm` 的
 * LlmRuntime）的依赖，cordis 会等 llm 就位后再调用 `apply`。`apply` 内部仍
 * 保留 ctx.llm 缺失时的空挂载兜底——直接 import 调用（如单测）不经 inject。
 */
export const inject = ['llm']

/** pi-bridge plugin configuration. */
export interface Config {
  /** Override the pi configuration directory (default: `$PI_CODING_AGENT_DIR` or `~/.pi/agent`). */
  piDir?: string
  /** Provider whitelist; empty/absent bridges every provider found. */
  providers?: string[]
  /** Route name prefix to avoid collisions with other adapters. */
  prefix?: string
  /** Whether OAuth credentials are bridged. */
  includeOAuth?: boolean
  /** Timeout for `!command` credential resolution, in milliseconds. */
  commandTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  piDir: z.string().description('覆盖 pi 配置目录（默认 $PI_CODING_AGENT_DIR 或 ~/.pi/agent）'),
  providers: z.array(z.string()).description('要桥接的 provider 白名单；留空表示全部'),
  prefix: z.string().default('').description('路由名前缀，用于避免与其他适配器的路由冲突'),
  includeOAuth: z.boolean().default(true).description('是否桥接 OAuth 凭据（过期时由 pi-ai 在内存中刷新，绝不回写）'),
  commandTimeoutMs: z.number().default(10000).description('!command 取值命令的超时时间（毫秒）'),
})

/** Mount the bridge: locate → read → convert → register. Never throws for a missing pi. */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(name)
  const warn: Warn = (message) => logger.warn(message)

  const llm = ctx.llm as LlmRuntime | undefined
  if (llm === undefined) {
    warn('pi-bridge: the llm service is not mounted in this composition; plugin mounted with no routes')
    return
  }

  const dir = locatePiDir(config.piDir === undefined ? {} : { piDir: config.piDir })
  if (dir === undefined) {
    warn('pi-bridge: pi configuration directory not found (looked at $PI_CODING_AGENT_DIR and ~/.pi/agent); plugin mounted with no routes')
    return
  }

  let auth: ReturnType<typeof readPiAuth>
  let models: ReturnType<typeof readPiModels>
  try {
    auth = readPiAuth(dir, { warn })
    models = readPiModels(dir, { warn })
  } catch (error) {
    // A corrupt pi file disables the bridge, never the composition.
    warn(`pi-bridge: cannot load pi configuration: ${(error as Error).message}; plugin mounted with no routes`)
    return
  }

  const resolve = createValueResolver({ timeoutMs: config.commandTimeoutMs ?? 10_000, warn })
  const whitelist = config.providers !== undefined && config.providers.length > 0 ? config.providers : undefined
  const routes = buildRoutes(auth, models, {
    ...(whitelist === undefined ? {} : { providers: whitelist }),
    prefix: config.prefix ?? '',
    includeOAuth: config.includeOAuth ?? true,
    resolve,
    warn,
  })
  if (routes.length === 0) {
    warn(`pi-bridge: no usable provider credentials found in ${dir}; plugin mounted with no routes`)
    return
  }

  const adapter = new PiBridgeAdapter(routes, undefined, { warn })
  if (adapter.routes.length === 0) {
    warn(`pi-bridge: none of the ${routes.length} candidate route(s) in ${dir} can be served; plugin mounted with no routes`)
    return
  }

  const handle = llm.registerAdapter([...adapter.routes], adapter)
  // cordis 4 has no typed 'dispose' event; an effect disposer is the
  // fiber-disposal hook (registerAdapter is also fiber-disposed itself).
  ctx.effect(() => () => {
    handle()
  }, 'pi-bridge: unregister llm adapter')
  logger.info(`pi-bridge: bridged ${adapter.routes.length} route(s) from ${dir}: ${adapter.routes.join(', ')}`)
}
