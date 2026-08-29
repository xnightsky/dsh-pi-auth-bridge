/**
 * pi 的 `auth.json` / `models.json` 的读取侧模型，以及 pi 的三态取值解析
 * （字面量 / `$ENV_VAR` / `!shell command`）。
 *
 * 本模块对 pi 目录的一切操作都是只读的：绝不创建、修改或删除任何文件。
 * 解析出的机密只存在于内存中。
 *
 * @module dsh-pi-auth-bridge/pi-auth
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** pi 的 `auth.json` 中的一条条目。 */
export type PiAuthEntry =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh?: string; expires?: number }

/** `models.json` 中某 provider 的一条模型条目。 */
export interface PiModelDef {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/** pi 的 `models.json` 中的一个 provider 条目。 */
export interface PiProviderDef {
  baseUrl?: string
  api?: string
  apiKey?: string
  headers?: Record<string, string>
  authHeader?: boolean
  name?: string
  models?: PiModelDef[]
}

/** 解析后的 `models.json`（仅包含本桥接器消费的部分）。 */
export interface PiModelsFile {
  providers: Record<string, PiProviderDef>
}

/** 读取或解析 pi 配置文件失败的错误；始终指明文件名。 */
export class PiAuthBridgeError extends Error {
  readonly path: string
  constructor(path: string, message: string, options?: ErrorOptions) {
    super(`pi-auth-bridge: ${path}: ${message}`, options)
    this.name = 'PiAuthBridgeError'
    this.path = path
  }
}

/** 桥接器各处共用的 warn 输出槽；默认值保持可注入以便测试。 */
export type Warn = (message: string) => void

const NO_WARN: Warn = () => {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

/** 校验一条 `auth.json` 条目；形状非法时返回 undefined。 */
function parseAuthEntry(value: unknown): PiAuthEntry | undefined {
  if (!isRecord(value)) return undefined
  if (value['type'] === 'api_key') {
    const key = value['key']
    return typeof key === 'string' && key.length > 0 ? { type: 'api_key', key } : undefined
  }
  if (value['type'] === 'oauth') {
    const access = value['access']
    if (typeof access !== 'string' || access.length === 0) return undefined
    const refresh = optionalString(value, 'refresh')
    const expires = optionalNumber(value, 'expires')
    return {
      type: 'oauth',
      access,
      ...(refresh !== undefined ? { refresh } : {}),
      ...(expires !== undefined ? { expires } : {}),
    }
  }
  return undefined
}

/** 校验一条 `models.json` 模型条目；形状非法时返回 undefined。 */
function parseModelDef(value: unknown): PiModelDef | undefined {
  if (!isRecord(value)) return undefined
  const id = optionalString(value, 'id')
  if (id === undefined || id.length === 0) return undefined
  const name = optionalString(value, 'name')
  const contextWindow = optionalNumber(value, 'contextWindow')
  const maxTokens = optionalNumber(value, 'maxTokens')
  const reasoning = optionalBoolean(value, 'reasoning')
  const rawCost = value['cost']
  const cost = isRecord(rawCost)
    && typeof rawCost['input'] === 'number'
    && typeof rawCost['output'] === 'number'
    && typeof rawCost['cacheRead'] === 'number'
    && typeof rawCost['cacheWrite'] === 'number'
    ? {
        input: rawCost['input'],
        output: rawCost['output'],
        cacheRead: rawCost['cacheRead'],
        cacheWrite: rawCost['cacheWrite'],
      }
    : undefined
  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cost !== undefined ? { cost } : {}),
  }
}

/** 校验一条 `models.json` provider 条目；形状非法时返回 undefined。 */
function parseProviderDef(value: unknown): PiProviderDef | undefined {
  if (!isRecord(value)) return undefined
  const baseUrl = optionalString(value, 'baseUrl')
  const api = optionalString(value, 'api')
  const apiKey = optionalString(value, 'apiKey')
  const authHeader = optionalBoolean(value, 'authHeader')
  const name = optionalString(value, 'name')
  const rawHeaders = value['headers']
  const headers = isRecord(rawHeaders)
    ? Object.fromEntries(Object.entries(rawHeaders).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
    : undefined
  const rawModels = value['models']
  const models = Array.isArray(rawModels)
    ? rawModels.map(parseModelDef).filter((model): model is PiModelDef => model !== undefined)
    : undefined
  return {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(api !== undefined ? { api } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(authHeader !== undefined ? { authHeader } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(models !== undefined ? { models } : {}),
  }
}

/** 读取并解析一个 JSON 文件；文件不存在返回 undefined，损坏时抛 PiAuthBridgeError。 */
function readJsonFile(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new PiAuthBridgeError(path, `cannot read file: ${(error as Error).message}`, { cause: error })
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new PiAuthBridgeError(path, `invalid JSON: ${(error as Error).message}`, { cause: error })
  }
}

export interface ReadPiOptions {
  /** 单条条目形状非法时经此输出槽跳过，绝不致命。 */
  warn?: Warn
}

/**
 * 读取 pi 的 `auth.json`。文件缺失 → `undefined`；JSON 损坏或顶层不是
 * 对象 → {@link PiAuthBridgeError}；单条非法条目发出警告后跳过，一个坏
 * provider 绝不拖垮其余。
 */
export function readPiAuth(dir: string, options: ReadPiOptions = {}): Record<string, PiAuthEntry> | undefined {
  const warn = options.warn ?? NO_WARN
  const path = join(dir, 'auth.json')
  const raw = readJsonFile(path)
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new PiAuthBridgeError(path, 'expected a JSON object keyed by provider id')
  const auth: Record<string, PiAuthEntry> = {}
  for (const [provider, value] of Object.entries(raw)) {
    const entry = parseAuthEntry(value)
    if (entry === undefined) {
      warn(`pi-auth-bridge: auth.json: skipping provider "${provider}": not a valid api_key/oauth entry`)
      continue
    }
    auth[provider] = entry
  }
  return auth
}

/** 读取 pi 的 `models.json`，缺失/损坏/跳过的契约与 {@link readPiAuth} 相同。 */
export function readPiModels(dir: string, options: ReadPiOptions = {}): PiModelsFile | undefined {
  const warn = options.warn ?? NO_WARN
  const path = join(dir, 'models.json')
  const raw = readJsonFile(path)
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new PiAuthBridgeError(path, 'expected a JSON object with a "providers" key')
  const rawProviders = raw['providers']
  if (rawProviders !== undefined && !isRecord(rawProviders)) {
    throw new PiAuthBridgeError(path, '"providers" must be an object keyed by provider id')
  }
  const providers: Record<string, PiProviderDef> = {}
  for (const [provider, value] of Object.entries(rawProviders ?? {})) {
    const parsed = parseProviderDef(value)
    if (parsed === undefined) {
      warn(`pi-auth-bridge: models.json: skipping provider "${provider}": not a valid provider entry`)
      continue
    }
    providers[provider] = parsed
  }
  return { providers }
}

/** 一个 pi 原始值（`apiKey`、请求头值、`auth.json` 的 key）如何被解析。 */
export interface ResolvePiValueOptions {
  /** `$ENV_VAR` 查找所用的环境。默认 `process.env`。 */
  env?: NodeJS.ProcessEnv
  /**
   * `!command` 执行器：执行命令并返回其 stdout。
   * 默认为带配置超时的 `child_process.execSync`。
   * 可注入，使测试永不真实派生进程。
   */
  execCmd?: (command: string, timeoutMs: number) => string
  /** 命令超时时间（毫秒）。默认 10 秒。 */
  timeoutMs?: number
  /** `!command` 执行结果的缓存（仅存于内存）。 */
  cache?: Map<string, string | undefined>
  /** 无法解析的值的 warn 输出槽。 */
  warn?: Warn
}

/** 默认的 `!command` 执行器：带超时的 shell 执行，捕获 stdout。 */
function defaultExecCmd(command: string, timeoutMs: number): string {
  return execSync(command, {
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
}

/**
 * 按 pi 自身的三态规则解析一个值：
 * `"$ENV_VAR"` 读取环境变量，`"!cmd args"` 运行 shell 命令并取其
 * （去除首尾空白后的）stdout，其余一律视为字面量。
 *
 * 无法解析的值（`$ENV` 未设置、命令失败或超时）返回 `undefined` 并发出
 * warn —— 绝不抛错，因此一个坏引用只会禁用它自己的 provider。
 */
export function resolvePiValue(raw: string, options: ResolvePiValueOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const execCmd = options.execCmd ?? defaultExecCmd
  const timeoutMs = options.timeoutMs ?? 10_000
  const warn = options.warn ?? NO_WARN

  if (raw.startsWith('$')) {
    const name = raw.slice(1)
    if (name.length === 0) {
      warn('pi-auth-bridge: empty "$" value reference cannot be resolved')
      return undefined
    }
    const value = env[name]
    if (value === undefined || value.length === 0) {
      warn(`pi-auth-bridge: environment variable "${name}" is not set; the referencing provider is skipped`)
      return undefined
    }
    return value
  }
  if (raw.startsWith('!')) {
    const command = raw.slice(1).trim()
    if (command.length === 0) {
      warn('pi-auth-bridge: empty "!" command value cannot be resolved')
      return undefined
    }
    const cache = options.cache
    if (cache?.has(command)) return cache.get(command)
    let value: string | undefined
    try {
      value = execCmd(command, timeoutMs).trim()
      if (value.length === 0) {
        warn(`pi-auth-bridge: command for a credential value produced empty output: ${command}`)
        value = undefined
      }
    } catch (error) {
      warn(`pi-auth-bridge: command for a credential value failed: ${command}: ${(error as Error).message}`)
      value = undefined
    }
    cache?.set(command, value)
    return value
  }
  return raw
}

/** 绑定了自身内存 `!command` 缓存的取值解析器。 */
export type PiValueResolver = (raw: string) => string | undefined

/**
 * 创建一个闭包持有同一缓存的解析器，使每个 `!command` 在每次插件加载中
 * 至多执行一次（仅存于内存；不持久化任何内容）。
 */
export function createValueResolver(options: Omit<ResolvePiValueOptions, 'cache'> = {}): PiValueResolver {
  const cache = new Map<string, string | undefined>()
  return (raw) => resolvePiValue(raw, { ...options, cache })
}
