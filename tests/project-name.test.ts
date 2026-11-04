import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('../', import.meta.url)

function sourceFiles(directory: string): string[] {
  return readdirSync(new URL(directory, ROOT), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : [path]
  })
}

describe('project naming', () => {
  it('uses the canonical standalone name across source, tests, docs and bundle metadata', () => {
    const files = ['AGENTS.md', 'AGENTS.ai.md', 'README.md', 'README.en.md', 'cordis.patch.yml',
      ...sourceFiles('src'), ...sourceFiles('tests'), ...sourceFiles('docs')]
    const legacyName = ['pi', 'auth', 'bridge'].join('-')
    const legacyPattern = new RegExp(`(?<!dsh-)${legacyName}`)
    for (const path of files) {
      expect(path, path).not.toMatch(legacyPattern)
      expect(readFileSync(new URL(path, ROOT), 'utf8'), path).not.toMatch(legacyPattern)
    }
  })
})
