import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PiAuthBridgeError,
  createValueResolver,
  readPiAuth,
  readPiModels,
  resolvePiValue,
} from '../src/pi-auth.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-auth-bridge-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf8')
}

describe('readPiAuth', () => {
  it('returns undefined when auth.json does not exist', () => {
    expect(readPiAuth(dir)).toBeUndefined()
  })

  it('parses api_key and oauth entries', () => {
    write('auth.json', JSON.stringify({
      anthropic: { type: 'oauth', access: 'acc', refresh: 'ref', expires: 123 },
      openai: { type: 'api_key', key: 'sk-test' },
      deepseek: { type: 'oauth', access: 'only-access' },
    }))
    const auth = readPiAuth(dir)
    expect(auth).toEqual({
      anthropic: { type: 'oauth', access: 'acc', refresh: 'ref', expires: 123 },
      openai: { type: 'api_key', key: 'sk-test' },
      deepseek: { type: 'oauth', access: 'only-access' },
    })
  })

  it('throws a PiAuthBridgeError naming the path on corrupt JSON', () => {
    write('auth.json', '{ not json')
    try {
      readPiAuth(dir)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PiAuthBridgeError)
      expect((error as PiAuthBridgeError).path).toBe(join(dir, 'auth.json'))
      expect((error as Error).message).toContain('auth.json')
    }
  })

  it('throws on a non-object top level', () => {
    write('auth.json', '["nope"]')
    expect(() => readPiAuth(dir)).toThrow(PiAuthBridgeError)
  })

  it('skips illegal entries with a warn instead of failing the file', () => {
    write('auth.json', JSON.stringify({
      good: { type: 'api_key', key: 'sk-1' },
      'bad-type': { type: 'mystery', key: 'x' },
      'empty-key': { type: 'api_key', key: '' },
      'oauth-no-access': { type: 'oauth', refresh: 'r' },
      scalar: 42,
    }))
    const warnings: string[] = []
    const auth = readPiAuth(dir, { warn: (message) => warnings.push(message) })
    expect(auth).toEqual({ good: { type: 'api_key', key: 'sk-1' } })
    expect(warnings.length).toBe(4)
    expect(warnings.join('\n')).toContain('bad-type')
  })
})

describe('readPiModels', () => {
  it('returns undefined when models.json does not exist', () => {
    expect(readPiModels(dir)).toBeUndefined()
  })

  it('parses providers with all consumed fields', () => {
    write('models.json', JSON.stringify({
      providers: {
        acme: {
          baseUrl: 'https://acme.example/v1',
          api: 'openai-completions',
          apiKey: '$ACME_KEY',
          authHeader: true,
          name: 'Acme',
          headers: { 'x-team': 'blue', 'x-bad': 7 },
          models: [
            { id: 'acme-large', name: 'Acme Large', contextWindow: 65536, maxTokens: 4096, reasoning: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
            { id: 'acme-small' },
          ],
        },
      },
    }))
    const models = readPiModels(dir)
    expect(models?.providers['acme']).toEqual({
      baseUrl: 'https://acme.example/v1',
      api: 'openai-completions',
      apiKey: '$ACME_KEY',
      authHeader: true,
      name: 'Acme',
      headers: { 'x-team': 'blue' },
      models: [
        { id: 'acme-large', name: 'Acme Large', contextWindow: 65536, maxTokens: 4096, reasoning: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
        { id: 'acme-small' },
      ],
    })
  })

  it('skips illegal provider entries with a warn', () => {
    write('models.json', JSON.stringify({ providers: { good: { baseUrl: 'https://x' }, bad: 'nope' } }))
    const warnings: string[] = []
    const models = readPiModels(dir, { warn: (message) => warnings.push(message) })
    expect(Object.keys(models?.providers ?? {})).toEqual(['good'])
    expect(warnings.length).toBe(1)
  })

  it('throws when "providers" is not an object', () => {
    write('models.json', '{"providers": []}')
    expect(() => readPiModels(dir)).toThrow(PiAuthBridgeError)
  })

  it('throws a PiAuthBridgeError on corrupt JSON', () => {
    write('models.json', '!!')
    expect(() => readPiModels(dir)).toThrow(PiAuthBridgeError)
  })
})

describe('resolvePiValue', () => {
  it('returns literals unchanged', () => {
    expect(resolvePiValue('sk-literal', { env: {} })).toBe('sk-literal')
  })

  it('resolves $ENV references from the injected env', () => {
    expect(resolvePiValue('$MY_KEY', { env: { MY_KEY: 'sk-env' } })).toBe('sk-env')
  })

  it('warns and returns undefined for an unset $ENV', () => {
    const warnings: string[] = []
    expect(resolvePiValue('$MISSING', { env: {}, warn: (message) => warnings.push(message) })).toBeUndefined()
    expect(warnings.join('\n')).toContain('MISSING')
  })

  it('runs !commands through the injected exec and trims stdout', () => {
    const calls: string[] = []
    const value = resolvePiValue('!pass show llm/key', {
      env: {},
      execCmd: (command) => {
        calls.push(command)
        return 'sk-from-cmd\n'
      },
    })
    expect(value).toBe('sk-from-cmd')
    expect(calls).toEqual(['pass show llm/key'])
  })

  it('warns and returns undefined when the command fails', () => {
    const warnings: string[] = []
    const value = resolvePiValue('!false', {
      env: {},
      execCmd: () => {
        throw new Error('exit 1')
      },
      warn: (message) => warnings.push(message),
    })
    expect(value).toBeUndefined()
    expect(warnings.length).toBe(1)
  })

  it('caches command results in memory (exec runs once)', () => {
    let calls = 0
    const resolve = createValueResolver({
      env: {},
      execCmd: () => {
        calls += 1
        return 'cached-value'
      },
    })
    expect(resolve('!cmd')).toBe('cached-value')
    expect(resolve('!cmd')).toBe('cached-value')
    expect(calls).toBe(1)
  })

  it('caches command failures too', () => {
    let calls = 0
    const resolve = createValueResolver({
      env: {},
      execCmd: () => {
        calls += 1
        throw new Error('nope')
      },
      warn: () => {},
    })
    expect(resolve('!cmd')).toBeUndefined()
    expect(resolve('!cmd')).toBeUndefined()
    expect(calls).toBe(1)
  })
})
