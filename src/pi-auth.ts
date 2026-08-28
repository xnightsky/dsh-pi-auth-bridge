/**
 * Read-side model of pi's `auth.json` / `models.json`, plus pi's three-state
 * value resolution (literal / `$ENV_VAR` / `!shell command`).
 *
 * Everything here is READ-ONLY with respect to the pi directory: no file is
 * ever created, modified, or deleted. Resolved secrets stay in memory.
 *
 * @module dsh-pi-bridge/pi-auth
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** One entry of pi's `auth.json`. */
export type PiAuthEntry =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh?: string; expires?: number }

/** One model entry of a `models.json` provider. */
export interface PiModelDef {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/** One provider entry of pi's `models.json`. */
export interface PiProviderDef {
  baseUrl?: string
  api?: string
  apiKey?: string
  headers?: Record<string, string>
  authHeader?: boolean
  name?: string
  models?: PiModelDef[]
}

/** Parsed `models.json` (only the parts this bridge consumes). */
export interface PiModelsFile {
  providers: Record<string, PiProviderDef>
}

/** Failure reading or parsing a pi configuration file; always names the file. */
export class PiBridgeError extends Error {
  readonly path: string
  constructor(path: string, message: string, options?: ErrorOptions) {
    super(`pi-bridge: ${path}: ${message}`, options)
    this.name = 'PiBridgeError'
    this.path = path
  }
}

/** Warn sink used across the bridge; defaults stay injectable for tests. */
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

/** Validate one `auth.json` entry; returns undefined for an illegal shape. */
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

/** Validate one `models.json` model entry; returns undefined for an illegal shape. */
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

/** Validate one `models.json` provider entry; returns undefined for an illegal shape. */
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

/** Read and parse one JSON file; undefined when absent, PiBridgeError when corrupt. */
function readJsonFile(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new PiBridgeError(path, `cannot read file: ${(error as Error).message}`, { cause: error })
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new PiBridgeError(path, `invalid JSON: ${(error as Error).message}`, { cause: error })
  }
}

export interface ReadPiOptions {
  /** Illegal per-entry shapes are skipped through this sink, never fatal. */
  warn?: Warn
}

/**
 * Read pi's `auth.json`. Missing file → `undefined`; corrupt JSON or a
 * non-object top level → {@link PiBridgeError}; individual illegal entries are
 * skipped with a warning so one bad provider never takes down the rest.
 */
export function readPiAuth(dir: string, options: ReadPiOptions = {}): Record<string, PiAuthEntry> | undefined {
  const warn = options.warn ?? NO_WARN
  const path = join(dir, 'auth.json')
  const raw = readJsonFile(path)
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new PiBridgeError(path, 'expected a JSON object keyed by provider id')
  const auth: Record<string, PiAuthEntry> = {}
  for (const [provider, value] of Object.entries(raw)) {
    const entry = parseAuthEntry(value)
    if (entry === undefined) {
      warn(`pi-bridge: auth.json: skipping provider "${provider}": not a valid api_key/oauth entry`)
      continue
    }
    auth[provider] = entry
  }
  return auth
}

/** Read pi's `models.json` with the same missing/corrupt/skip contract as {@link readPiAuth}. */
export function readPiModels(dir: string, options: ReadPiOptions = {}): PiModelsFile | undefined {
  const warn = options.warn ?? NO_WARN
  const path = join(dir, 'models.json')
  const raw = readJsonFile(path)
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new PiBridgeError(path, 'expected a JSON object with a "providers" key')
  const rawProviders = raw['providers']
  if (rawProviders !== undefined && !isRecord(rawProviders)) {
    throw new PiBridgeError(path, '"providers" must be an object keyed by provider id')
  }
  const providers: Record<string, PiProviderDef> = {}
  for (const [provider, value] of Object.entries(rawProviders ?? {})) {
    const parsed = parseProviderDef(value)
    if (parsed === undefined) {
      warn(`pi-bridge: models.json: skipping provider "${provider}": not a valid provider entry`)
      continue
    }
    providers[provider] = parsed
  }
  return { providers }
}

/** How one raw pi value (`apiKey`, header value, `auth.json` key) is resolved. */
export interface ResolvePiValueOptions {
  /** Environment for `$ENV_VAR` lookups. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /**
   * `!command` runner: executes the command and returns its stdout.
   * Defaults to `child_process.execSync` with the configured timeout.
   * Injectable so tests never spawn real processes.
   */
  execCmd?: (command: string, timeoutMs: number) => string
  /** Command timeout in milliseconds. Default 10s. */
  timeoutMs?: number
  /** Result cache for `!command` executions (in memory only). */
  cache?: Map<string, string | undefined>
  /** Warn sink for unresolvable values. */
  warn?: Warn
}

/** Default `!command` runner: shell execution with a timeout, stdout captured. */
function defaultExecCmd(command: string, timeoutMs: number): string {
  return execSync(command, {
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
}

/**
 * Resolve one pi value following pi's own three-state rule:
 * `"$ENV_VAR"` reads an environment variable, `"!cmd args"` runs a shell
 * command and takes its (trimmed) stdout, anything else is a literal.
 *
 * Unresolvable values (`$ENV` unset, command failing or timing out) return
 * `undefined` and warn — they never throw, so one broken reference only
 * disables its own provider.
 */
export function resolvePiValue(raw: string, options: ResolvePiValueOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const execCmd = options.execCmd ?? defaultExecCmd
  const timeoutMs = options.timeoutMs ?? 10_000
  const warn = options.warn ?? NO_WARN

  if (raw.startsWith('$')) {
    const name = raw.slice(1)
    if (name.length === 0) {
      warn('pi-bridge: empty "$" value reference cannot be resolved')
      return undefined
    }
    const value = env[name]
    if (value === undefined || value.length === 0) {
      warn(`pi-bridge: environment variable "${name}" is not set; the referencing provider is skipped`)
      return undefined
    }
    return value
  }
  if (raw.startsWith('!')) {
    const command = raw.slice(1).trim()
    if (command.length === 0) {
      warn('pi-bridge: empty "!" command value cannot be resolved')
      return undefined
    }
    const cache = options.cache
    if (cache?.has(command)) return cache.get(command)
    let value: string | undefined
    try {
      value = execCmd(command, timeoutMs).trim()
      if (value.length === 0) {
        warn(`pi-bridge: command for a credential value produced empty output: ${command}`)
        value = undefined
      }
    } catch (error) {
      warn(`pi-bridge: command for a credential value failed: ${command}: ${(error as Error).message}`)
      value = undefined
    }
    cache?.set(command, value)
    return value
  }
  return raw
}

/** A bound value resolver with its own in-memory `!command` cache. */
export type PiValueResolver = (raw: string) => string | undefined

/**
 * Create a resolver closing over one cache, so each `!command` runs at most
 * once per plugin load (in memory; nothing is persisted).
 */
export function createValueResolver(options: Omit<ResolvePiValueOptions, 'cache'> = {}): PiValueResolver {
  const cache = new Map<string, string | undefined>()
  return (raw) => resolvePiValue(raw, { ...options, cache })
}
