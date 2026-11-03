import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 当前支持的唯一 DSH 宿主兼容基线；升级宿主时先改这里，再同步包与文档。 */
const CURRENT_DSH_BASELINE = '0.2.1-rc.4'
const DSH_PACKAGE_PREFIX = '@deepseek-ai/dsh-'

interface PackageManifest {
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

function dshDependencies(dependencies: Record<string, string> | undefined): [string, string][] {
  return Object.entries(dependencies ?? {}).filter(([name]) => name.startsWith(DSH_PACKAGE_PREFIX))
}

describe('DSH compatibility baseline', () => {
  it('pins every dsh peer and dev dependency to the centralized baseline', () => {
    const manifest = JSON.parse(readRepoFile('package.json')) as PackageManifest
    const peers = dshDependencies(manifest.peerDependencies)
    const dev = dshDependencies(manifest.devDependencies)

    expect(peers.map(([name]) => name).sort()).toEqual([
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-typert-protocol',
    ])
    expect(dev).toHaveLength(8)
    expect([...peers, ...dev]).toHaveLength(11)
    for (const [name, version] of [...peers, ...dev]) {
      expect(version, name).toBe(CURRENT_DSH_BASELINE)
    }
  })

  it('declares the same baseline in both READMEs and the design document', () => {
    expect(readRepoFile('README.md')).toContain(`本版本精确支持 DSH \`${CURRENT_DSH_BASELINE}\``)
    expect(readRepoFile('README.en.md')).toContain(`This version supports exactly DSH \`${CURRENT_DSH_BASELINE}\``)
    expect(readRepoFile('docs/spec/2026-08-29-pi-auth-bridge-design.md'))
      .toContain(`dsh 版本精确锁定 \`${CURRENT_DSH_BASELINE}\``)
  })
})
