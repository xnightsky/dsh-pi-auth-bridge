import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 已核对的宿主兼容范围与可复现的开发测试基线分别维护。 */
const SUPPORTED_DSH_RANGE = '0.2.1-rc.4 || 0.2.1-rc.5'
const DSH_TEST_BASELINE = '0.2.1-rc.5'
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
  it('declares the supported dsh peer range and pins the development baseline', () => {
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
    for (const [name, version] of peers) {
      expect(version, name).toBe(SUPPORTED_DSH_RANGE)
    }
    for (const [name, version] of dev) {
      expect(version, name).toBe(DSH_TEST_BASELINE)
    }
  })

  it('installs and locks the declared dsh baseline rather than stale local packages', () => {
    const manifest = JSON.parse(readRepoFile('package.json')) as PackageManifest
    const lock = JSON.parse(readRepoFile('package-lock.json')) as {
      packages: Record<string, { version?: string } & PackageManifest>
    }
    expect(lock.packages['']?.peerDependencies).toEqual(manifest.peerDependencies)
    expect(lock.packages['']?.devDependencies).toEqual(manifest.devDependencies)
    for (const [name] of dshDependencies(manifest.devDependencies)) {
      const installed = JSON.parse(readRepoFile(`node_modules/${name}/package.json`)) as { version: string }
      expect(installed.version, `${name} installed`).toBe(DSH_TEST_BASELINE)
      expect(lock.packages[`node_modules/${name}`]?.version, `${name} locked`).toBe(DSH_TEST_BASELINE)
    }
  })

  it('declares the supported range and test baseline in both READMEs and the design document', () => {
    expect(readRepoFile('README.md')).toContain(`本版本支持 DSH \`${SUPPORTED_DSH_RANGE}\``)
    expect(readRepoFile('README.en.md')).toContain(`This version supports DSH \`${SUPPORTED_DSH_RANGE}\``)
    expect(readRepoFile('docs/spec/dsh-pi-auth-bridge-design.md'))
      .toContain(`dsh 宿主兼容范围 \`${SUPPORTED_DSH_RANGE}\``)
    for (const path of ['README.md', 'README.en.md', 'docs/spec/dsh-pi-auth-bridge-design.md']) {
      expect(readRepoFile(path), path).toContain(`devDependencies\` ${DSH_TEST_BASELINE}`)
    }
  })
})
