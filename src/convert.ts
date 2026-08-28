/**
 * Pure conversion from pi's `auth.json` + `models.json` into route
 * definitions the adapter can serve. No pi-ai import and no I/O beyond the
 * injected value resolver, so the whole mapping is unit-testable.
 *
 * @module dsh-pi-bridge/convert
 */
import type { PiAuthEntry, PiModelDef, PiModelsFile, PiValueResolver, Warn } from './pi-auth.js'

/** One provider route the bridge can register with the dsh LLM seam. */
export interface RouteDef {
  /** Route name registered with `ctx.llm.registerAdapter` (prefix applied). */
  route: string
  /** Original pi provider id (used for pi-ai catalog lookup). */
  providerId: string
  /** `builtin`: metadata comes from pi-ai's installed catalog; `custom`: declared by `models.json`. */
  kind: 'builtin' | 'custom'
  /** Human-readable provider name. */
  displayName: string
  /** Resolved api key, when the route authenticates with one. In memory only. */
  apiKey?: string
  /**
   * OAuth credential handed to pi-ai's in-memory credential store so its own
   * refresh mechanism can rotate an expired token. Never written back anywhere.
   */
  oauth?: { access: string; refresh: string; expires?: number }
  /** Wire protocol for custom providers (`openai-completions`, ...). */
  api?: string
  /** Endpoint override for custom providers. */
  baseURL?: string
  /** Extra request headers (values already resolved). */
  headers?: Record<string, string>
  /** pi's `authHeader` flag: send the key as an `Authorization: Bearer` header. */
  authHeader?: boolean
  /** Custom model declarations; empty means "use the pi-ai catalog". */
  models: PiModelDef[]
}

export interface BuildRoutesOptions {
  /** Whitelist of pi provider ids; absent means "every provider found". */
  providers?: readonly string[]
  /** Route name prefix to avoid collisions with other adapters. */
  prefix?: string
  /** Whether OAuth entries are bridged at all. Default true. */
  includeOAuth?: boolean
  /** Resolver for `$ENV` / `!cmd` / literal values. */
  resolve: PiValueResolver
  /** Warn sink. */
  warn: Warn
  /** Current time in epoch ms (injectable for tests). */
  now?: number
}

/** Resolve a possibly-templated value; failures already warned inside the resolver. */
function resolved(resolve: PiValueResolver, raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : resolve(raw)
}

/**
 * Build the route set from pi's configuration.
 *
 * Credential precedence per provider: `auth.json` same-name entry >
 * `models.json` `apiKey` field. OAuth entries bridge the unexpired access
 * token as a plain api key; an expired entry with a refresh token is handed
 * to pi-ai's own (in-memory) refresh; anything else is skipped with a warn.
 */
export function buildRoutes(
  auth: Record<string, PiAuthEntry> | undefined,
  models: PiModelsFile | undefined,
  options: BuildRoutesOptions,
): RouteDef[] {
  const { resolve, warn } = options
  const prefix = options.prefix ?? ''
  const includeOAuth = options.includeOAuth ?? true
  const now = options.now ?? Date.now()
  const whitelist = options.providers === undefined ? undefined : new Set(options.providers)

  const ids = new Set<string>([...Object.keys(auth ?? {}), ...Object.keys(models?.providers ?? {})])
  const routes: RouteDef[] = []

  for (const providerId of ids) {
    if (whitelist !== undefined && !whitelist.has(providerId)) continue
    const custom = models?.providers?.[providerId]
    const entry = auth?.[providerId]
    const route = `${prefix}${providerId}`
    const displayName = custom?.name ?? providerId

    let apiKey: string | undefined
    let oauth: RouteDef['oauth']

    if (entry?.type === 'api_key') {
      apiKey = resolved(resolve, entry.key)
      if (apiKey === undefined) {
        warn(`pi-bridge: provider "${providerId}": auth.json api key could not be resolved; trying models.json apiKey`)
      }
    } else if (entry?.type === 'oauth') {
      if (!includeOAuth) {
        warn(`pi-bridge: provider "${providerId}": OAuth entry ignored because includeOAuth is false`)
      } else {
        const expired = entry.expires !== undefined && entry.expires <= now
        if (!expired) {
          // Unexpired access token: usable as a plain bearer key.
          apiKey = entry.access
        } else if (entry.refresh !== undefined && entry.refresh.length > 0) {
          // Expired but refreshable: pi-ai refreshes in memory; nothing is written back.
          oauth = {
            access: entry.access,
            refresh: entry.refresh,
            ...(entry.expires !== undefined ? { expires: entry.expires } : {}),
          }
        } else {
          warn(`pi-bridge: provider "${providerId}": OAuth token expired and has no refresh token; provider skipped`)
          continue
        }
      }
    }

    if (apiKey === undefined && custom?.apiKey !== undefined) {
      apiKey = resolved(resolve, custom.apiKey)
      if (apiKey === undefined) {
        warn(`pi-bridge: provider "${providerId}": models.json apiKey could not be resolved`)
      }
    }

    if (apiKey === undefined && oauth === undefined) {
      if (custom === undefined) {
        // An auth.json-only provider whose credential did not resolve is unserviceable.
        warn(`pi-bridge: provider "${providerId}": no usable credential; provider skipped`)
        continue
      }
      // A models.json provider without any key may still be a keyless local endpoint;
      // keep it and let the wire protocol decide.
    }

    let headers: Record<string, string> | undefined
    if (custom?.headers !== undefined) {
      headers = {}
      for (const [name, raw] of Object.entries(custom.headers)) {
        const value = resolve(raw)
        if (value === undefined) {
          warn(`pi-bridge: provider "${providerId}": header "${name}" could not be resolved; header dropped`)
          continue
        }
        headers[name] = value
      }
      if (Object.keys(headers).length === 0) headers = undefined
    }

    routes.push({
      route,
      providerId,
      kind: custom === undefined ? 'builtin' : 'custom',
      displayName,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(oauth !== undefined ? { oauth } : {}),
      ...(custom?.api !== undefined ? { api: custom.api } : {}),
      ...(custom?.baseUrl !== undefined ? { baseURL: custom.baseUrl } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(custom?.authHeader !== undefined ? { authHeader: custom.authHeader } : {}),
      models: custom?.models ?? [],
    })
  }
  return routes
}
