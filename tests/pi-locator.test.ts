import { describe, expect, it } from 'vitest'
import { join as posixJoin } from 'node:path'
import { win32 } from 'node:path'
import { locatePiDir } from '../src/pi-locator.js'

/** Existence probe driven by a set of "files" that exist. */
function probe(files: string[]): (path: string) => boolean {
  const set = new Set(files)
  return (path) => set.has(path)
}

describe('locatePiDir', () => {
  it('prefers an explicit piDir over every other source', () => {
    const dir = locatePiDir({
      piDir: '/opt/pi',
      env: { PI_CODING_AGENT_DIR: '/env/pi' },
      homedir: () => '/home/u',
      exists: probe(['/opt/pi/auth.json']),
      joinPath: posixJoin,
    })
    expect(dir).toBe('/opt/pi')
  })

  it('uses PI_CODING_AGENT_DIR when no explicit piDir is given', () => {
    const dir = locatePiDir({
      env: { PI_CODING_AGENT_DIR: '/env/pi' },
      homedir: () => '/home/u',
      exists: probe(['/env/pi/models.json']),
      joinPath: posixJoin,
    })
    expect(dir).toBe('/env/pi')
  })

  it('falls back to homedir()/.pi/agent on posix', () => {
    const dir = locatePiDir({
      env: {},
      homedir: () => '/home/u',
      exists: probe(['/home/u/.pi/agent/auth.json']),
      joinPath: posixJoin,
    })
    expect(dir).toBe('/home/u/.pi/agent')
  })

  it('stitches win32-style paths through the injected joiner', () => {
    const seen: string[] = []
    const dir = locatePiDir({
      env: {},
      homedir: () => 'C:\\Users\\u',
      exists: (path) => {
        seen.push(path)
        return path === 'C:\\Users\\u\\.pi\\agent\\models.json'
      },
      joinPath: win32.join,
    })
    expect(dir).toBe('C:\\Users\\u\\.pi\\agent')
    expect(seen[0]).toBe('C:\\Users\\u\\.pi\\agent\\auth.json')
    expect(seen[1]).toBe('C:\\Users\\u\\.pi\\agent\\models.json')
  })

  it('honors PI_CODING_AGENT_DIR on win32-style paths too', () => {
    const dir = locatePiDir({
      env: { PI_CODING_AGENT_DIR: 'D:\\pi-config' },
      homedir: () => 'C:\\Users\\u',
      exists: probe(['D:\\pi-config\\models.json']),
      joinPath: win32.join,
    })
    expect(dir).toBe('D:\\pi-config')
  })

  it('returns undefined when neither auth.json nor models.json exists', () => {
    const dir = locatePiDir({
      env: {},
      homedir: () => '/home/u',
      exists: probe([]),
      joinPath: posixJoin,
    })
    expect(dir).toBeUndefined()
  })

  it('treats an empty explicit piDir as absent', () => {
    const dir = locatePiDir({
      piDir: '   ',
      env: { PI_CODING_AGENT_DIR: '/env/pi' },
      exists: probe(['/env/pi/auth.json']),
      joinPath: posixJoin,
    })
    expect(dir).toBe('/env/pi')
  })

  it('returns undefined when no home directory can be determined', () => {
    const dir = locatePiDir({
      env: {},
      homedir: () => '',
      exists: probe(['/.pi/agent/auth.json']),
      joinPath: posixJoin,
    })
    expect(dir).toBeUndefined()
  })
})
