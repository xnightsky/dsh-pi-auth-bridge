/**
 * pi-auth-bridge：一个 dsh 插件，把本机 pi（Pi coding agent）安装的认证信息
 * （`auth.json` + `models.json`）桥接为 dsh 的 LLM 路由。
 *
 * 零配置、仅存于内存：凭据在挂载时从 pi 的文件读取，绝不写到任何地方
 * —— 不写 dsh 凭据存储、不回写 `~/.pi`、不写任何临时文件。当 pi 未安装
 * （或没有任何可提供的路由）时，插件以警告空挂载，而不是让组合失败。
 *
 * 遵循官方 dsh 插件（bundle）约定：导出 `name` / `inject: ['llm']` /
 * `Config` / `apply`，并在包中声明 `dsh.bundle.patch` → 根目录
 * `cordis.patch.yml`。开发时也可以按绝对路径插入任意 cordis 层：
 *
 * ```yaml
 * # cordis.yml
 * - insert: [{ id: pi-auth-bridge, name: '/abs/path/pi-auth-bridge/src/index.ts' }]
 * ```
 *
 * @module dsh-pi-auth-bridge
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { locatePiDir } from './pi-locator.js'
import { createValueResolver, readPiAuth, readPiModels, type Warn } from './pi-auth.js'
import { buildRoutes } from './convert.js'
import { PiAuthBridgeAdapter } from './adapter.js'

export { locatePiDir } from './pi-locator.js'
export { PiAuthBridgeError, createValueResolver, readPiAuth, readPiModels, resolvePiValue } from './pi-auth.js'
export type { PiAuthEntry, PiModelDef, PiModelsFile, PiProviderDef } from './pi-auth.js'
export { buildRoutes, PI_ROUTE_PREFIX } from './convert.js'
export type { RouteDef } from './convert.js'
export { buildPiModels } from './provider.js'
export type { BuiltPiModels, PiModelsLike } from './provider.js'
export { toPiContext } from './request.js'
export { mapStopReason, mapUsage, toStreamChunks } from './stream.js'
export { PiAuthBridgeAdapter } from './adapter.js'

export const name = 'pi-auth-bridge'

/**
 * LLM 适配器插件的官方约定：声明对 `llm` 服务（`@deepseek-ai/dsh-llm` 的
 * LlmRuntime）的依赖，cordis 会等 llm 就位后再调用 `apply`。`apply` 内部仍
 * 保留 ctx.llm 缺失时的空挂载兜底——直接 import 调用（如单测）不经 inject。
 */
export const inject = ['llm']

/** pi-auth-bridge 插件配置。 */
export interface Config {
  /** 覆盖 pi 配置目录（默认 `$PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）。 */
  piDir?: string
  /** provider 白名单；留空/缺省表示桥接找到的每个 provider。 */
  providers?: string[]
  /** 是否桥接 OAuth 凭据。 */
  includeOAuth?: boolean
  /** `!command` 凭据解析的超时时间（毫秒）。 */
  commandTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  piDir: z.string().description('覆盖 pi 配置目录（默认 $PI_CODING_AGENT_DIR 或 ~/.pi/agent）'),
  providers: z.array(z.string()).description('要桥接的 provider 白名单；留空表示全部'),
  includeOAuth: z.boolean().default(true).description('是否桥接 OAuth 凭据（过期时由 pi-ai 在内存中刷新，绝不回写）'),
  commandTimeoutMs: z.number().default(10000).description('!command 取值命令的超时时间（毫秒）'),
})

/** 挂载桥接器：定位 → 读取 → 转换 → 注册。pi 缺失时绝不抛错。 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(name)
  const warn: Warn = (message) => logger.warn(message)

  const llm = ctx.llm as LlmRuntime | undefined
  if (llm === undefined) {
    warn('pi-auth-bridge: the llm service is not mounted in this composition; plugin mounted with no routes')
    return
  }

  const dir = locatePiDir(config.piDir === undefined ? {} : { piDir: config.piDir })
  if (dir === undefined) {
    warn('pi-auth-bridge: pi configuration directory not found (looked at $PI_CODING_AGENT_DIR and ~/.pi/agent); plugin mounted with no routes')
    return
  }

  let auth: ReturnType<typeof readPiAuth>
  let models: ReturnType<typeof readPiModels>
  try {
    auth = readPiAuth(dir, { warn })
    models = readPiModels(dir, { warn })
  } catch (error) {
    // 损坏的 pi 文件只会禁用桥接器，绝不影响组合。
    warn(`pi-auth-bridge: cannot load pi configuration: ${(error as Error).message}; plugin mounted with no routes`)
    return
  }

  const resolve = createValueResolver({ timeoutMs: config.commandTimeoutMs ?? 10_000, warn })
  const whitelist = config.providers !== undefined && config.providers.length > 0 ? config.providers : undefined
  const routes = buildRoutes(auth, models, {
    ...(whitelist === undefined ? {} : { providers: whitelist }),
    includeOAuth: config.includeOAuth ?? true,
    resolve,
    warn,
  })
  if (routes.length === 0) {
    warn(`pi-auth-bridge: no usable provider credentials found in ${dir}; plugin mounted with no routes`)
    return
  }

  const adapter = new PiAuthBridgeAdapter(routes, undefined, { warn })
  if (adapter.routes.length === 0) {
    warn(`pi-auth-bridge: none of the ${routes.length} candidate route(s) in ${dir} can be served; plugin mounted with no routes`)
    return
  }

  const handle = llm.registerAdapter([...adapter.routes], adapter)
  // cordis 4 has no typed 'dispose' event; an effect disposer is the
  // fiber-disposal hook (registerAdapter is also fiber-disposed itself).
  ctx.effect(() => () => {
    handle()
  }, 'pi-auth-bridge: unregister llm adapter')
  logger.info(`pi-auth-bridge: bridged ${adapter.routes.length} route(s) from ${dir}: ${adapter.routes.join(', ')}`)
}
