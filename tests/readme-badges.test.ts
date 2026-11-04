import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const BADGE_URLS = [
  'https://img.shields.io/npm/v/%40xnightsky%2Fdsh-pi-auth-bridge',
  'https://img.shields.io/github/license/xnightsky/dsh-pi-auth-bridge',
  'https://github.com/xnightsky/dsh-pi-auth-bridge/actions/workflows/release.yml/badge.svg',
]

describe('README badges', () => {
  it.each(['README.md', 'README.en.md'])('%s displays canonical project and release badges', (path) => {
    const content = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    expect(content).toMatch(/^# dsh-pi-auth-bridge \(@xnightsky\/dsh-pi-auth-bridge\)/)
    for (const url of BADGE_URLS) expect(content, url).toContain(url)
    expect(content).toContain('https://www.npmjs.com/package/@xnightsky/dsh-pi-auth-bridge')
    expect(content).toContain('https://github.com/xnightsky/dsh-pi-auth-bridge/actions/workflows/release.yml')
  })
})
