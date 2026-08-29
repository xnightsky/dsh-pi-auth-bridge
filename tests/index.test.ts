import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply, Config, inject, name } from '../src/index.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-bridge-plugin-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface Captured {
  warnings: string[]
  infos: string[]
  registered: { routes: string[]; adapter: unknown }[]
  effects: (() => void)[]
  llm?: object
}

function fakeCtx(captured: Captured): Context {
  return {
    logger: () => ({
      warn: (message: string) => captured.warnings.push(message),
      info: (message: string) => captured.infos.push(message),
    }),
    ...(captured.llm === undefined
      ? {}
      : {
          llm: {
            registerAdapter: (routes: string[], adapter: unknown) => {
              captured.registered.push({ routes, adapter })
              const dispose = () => captured.effects.push(dispose)
              return dispose
            },
          },
        }),
    effect: (execute: () => () => void) => {
      captured.effects.push(execute())
    },
  } as unknown as Context
}

function baseCaptured(withLlm = true): Captured {
  return {
    warnings: [],
    infos: [],
    registered: [],
    effects: [],
    ...(withLlm ? { llm: {} } : {}),
  }
}

describe('plugin metadata', () => {
  it('exposes the plugin name, llm inject declaration, and a validating Config schema', () => {
    expect(name).toBe('pi-bridge')
    expect(inject).toEqual(['llm'])
    expect(Config({})).toMatchObject({ includeOAuth: true, commandTimeoutMs: 10_000 })
    expect(Config({ providers: ['openai'] })).toMatchObject({ providers: ['openai'] })
    // 旧配置里残留的 prefix 键被容忍（透传忽略），不再影响路由名。
    expect(Config({ prefix: 'pi/' } as never)).toMatchObject({ includeOAuth: true })
  })
})

describe('apply', () => {
  it('mounts empty with a warn when the pi directory does not exist', () => {
    const captured = baseCaptured()
    expect(() => apply(fakeCtx(captured), Config({ piDir: join(dir, 'no-such-dir') }))).not.toThrow()
    expect(captured.registered).toHaveLength(0)
    expect(captured.warnings.join('\n')).toContain('not found')
  })

  it('mounts empty with a warn when the llm service is absent', () => {
    const captured = baseCaptured(false)
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'sk-1' } }))
    expect(() => apply(fakeCtx(captured), Config({ piDir: dir }))).not.toThrow()
    expect(captured.registered).toHaveLength(0)
    expect(captured.warnings.join('\n')).toContain('llm service')
  })

  it('mounts empty with a warn on a corrupt auth.json', () => {
    const captured = baseCaptured()
    writeFileSync(join(dir, 'auth.json'), '{ broken')
    expect(() => apply(fakeCtx(captured), Config({ piDir: dir }))).not.toThrow()
    expect(captured.registered).toHaveLength(0)
    expect(captured.warnings.join('\n')).toContain('cannot load')
  })

  it('mounts empty when no provider has a usable credential', () => {
    const captured = baseCaptured()
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: '$DEFINITELY_UNSET_VAR' } }))
    expect(() => apply(fakeCtx(captured), Config({ piDir: dir }))).not.toThrow()
    expect(captured.registered).toHaveLength(0)
    expect(captured.warnings.join('\n')).toContain('no usable provider')
  })

  it('registers routes from auth.json and unregisters on dispose', () => {
    const captured = baseCaptured()
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'sk-live' } }))
    apply(fakeCtx(captured), Config({ piDir: dir }))
    expect(captured.registered).toHaveLength(1)
    expect(captured.registered[0]?.routes).toEqual(['pi/openai'])
    expect(captured.warnings).toHaveLength(0)
    expect(captured.effects.length).toBeGreaterThan(0)
    // The registerAdapter handle is invoked through the fiber effect disposer.
    expect(() => captured.effects.forEach((dispose) => dispose())).not.toThrow()
  })

  it('registers a custom models.json provider under the fixed pi/ route prefix', () => {
    const captured = baseCaptured()
    writeFileSync(join(dir, 'models.json'), JSON.stringify({
      providers: {
        acme: {
          baseUrl: 'https://acme.example/v1',
          api: 'openai-completions',
          apiKey: 'sk-acme',
          models: [{ id: 'acme-large' }],
        },
      },
    }))
    apply(fakeCtx(captured), Config({ piDir: dir }))
    expect(captured.registered).toHaveLength(1)
    expect(captured.registered[0]?.routes).toEqual(['pi/acme'])
  })

  it('honors the providers whitelist', () => {
    const captured = baseCaptured()
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({
      openai: { type: 'api_key', key: 'sk-1' },
      anthropic: { type: 'api_key', key: 'sk-2' },
    }))
    apply(fakeCtx(captured), Config({ piDir: dir, providers: ['anthropic'] }))
    expect(captured.registered[0]?.routes).toEqual(['pi/anthropic'])
  })

  it('warns and mounts empty when the whitelist matches nothing', () => {
    const captured = baseCaptured()
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'sk-1' } }))
    expect(() => apply(fakeCtx(captured), Config({ piDir: dir, providers: ['nope'] }))).not.toThrow()
    expect(captured.registered).toHaveLength(0)
  })

  it('streams through the registered adapter using a real pi-ai provider build (offline)', async () => {
    // The adapter was registered against the real pi-ai catalog; catalog reads
    // are local, so listing models must work without any network access.
    const captured = baseCaptured()
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'sk-live' } }))
    apply(fakeCtx(captured), Config({ piDir: dir }))
    const adapter = captured.registered[0]?.adapter as {
      listModels(provider: string): Promise<readonly { id: string }[]>
      stream(options: never): AsyncIterable<StreamChunk>
    }
    const models = await adapter.listModels('pi/openai')
    expect(models.length).toBeGreaterThan(0)
  })
})
