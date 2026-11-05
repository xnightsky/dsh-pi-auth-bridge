import { readFileSync } from 'node:fs'
import { satisfies } from 'semver'
import { describe, expect, it } from 'vitest'

/**
 * 宿主兼容范围是「跟随式窗口」：从首个已核实的 0.2.1-rc.4 起，放行整个 0.2 线
 * （含预发布），dsh 进入 0.3.0 线时才需要重新核对；开发测试基线单独精确锁定。
 */
const SUPPORTED_DSH_RANGE = '^0.2.1-rc.4'
const DSH_TEST_BASELINE = '0.2.2-rc.1'
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
    expect(dev).toHaveLength(9)
    expect([...peers, ...dev]).toHaveLength(12)
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

  it('keeps the compatibility window open across the whole 0.2 line until the next major line', () => {
    // 宿主判定等价于 semver.satisfies(v, range, { includePrerelease: true })
    // （@deepseek-ai/dsh-app-boot 的 satisfies 实现），预发布版本因此参与比较。
    const admits = (version: string): boolean => satisfies(version, SUPPORTED_DSH_RANGE, { includePrerelease: true })

    for (const version of ['0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.3-rc.1', '0.2.9', '0.2.2']) {
      expect(admits(version), version).toBe(true)
    }
    for (const version of ['0.2.1-rc.2', '0.2.1-rc.3', '0.3.0-rc.1', '0.3.0', '0.4.0-rc.1']) {
      expect(admits(version), version).toBe(false)
    }
  })

  it('uses caret rather than an explicit upper bound, which would leak the next line prerelease', () => {
    // includePrerelease 下 0.3.0-rc.1 < 0.3.0 成立，所以 `>=0.2.1-rc.4 <0.3.0` 会放行 0.3.0-rc.1；
    // node-semver 把 ^0.2.1-rc.4 展开为 >=0.2.1-rc.4 <0.3.0-0，才真正停在下一大版本线之前。
    expect(satisfies('0.3.0-rc.1', '>=0.2.1-rc.4 <0.3.0', { includePrerelease: true })).toBe(true)
    expect(satisfies('0.3.0-rc.1', '>=0.2.1-rc.4 <0.3.0-0', { includePrerelease: true })).toBe(false)
  })
})