/**
 * Cross-platform location of the pi (Pi coding agent) configuration directory.
 *
 * Resolution priority: explicit `piDir` > `$PI_CODING_AGENT_DIR` >
 * `homedir()/.pi/agent` (`%USERPROFILE%\.pi\agent` on Windows — `os.homedir()`
 * is naturally cross-platform). A candidate directory only counts when it
 * holds at least one of `auth.json` / `models.json`.
 *
 * Every environment touchpoint (env vars, homedir, filesystem existence, path
 * joining) is injectable so the win32 and posix path logic can be unit-tested
 * on either platform without touching the real machine.
 *
 * @module dsh-pi-bridge/pi-locator
 */
import { existsSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

export interface LocatePiDirOptions {
  /** Explicit override; wins over every other source. Empty means absent. */
  piDir?: string
  /** Environment to read `PI_CODING_AGENT_DIR` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Home directory source. Defaults to `os.homedir`. */
  homedir?: () => string
  /** Existence probe. Defaults to `fs.existsSync`. */
  exists?: (path: string) => boolean
  /** Path joiner. Defaults to `path.join`; pass `path.win32.join` to exercise Windows stitching. */
  joinPath?: (...parts: string[]) => string
}

/** A non-empty string, or undefined. */
function present(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

/**
 * Locate the pi configuration directory.
 *
 * @returns the directory when it exists and holds `auth.json` or `models.json`;
 *   `undefined` when pi is not installed (or holds neither file) — callers
 *   must treat that as "mount empty", never as an error.
 */
export function locatePiDir(options: LocatePiDirOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const homedir = options.homedir ?? osHomedir
  const exists = options.exists ?? existsSync
  const joinPath = options.joinPath ?? join

  let dir = present(options.piDir) ?? present(env.PI_CODING_AGENT_DIR)
  if (dir === undefined) {
    const home = present(homedir())
    if (home === undefined) return undefined
    dir = joinPath(home, '.pi', 'agent')
  }
  if (exists(joinPath(dir, 'auth.json')) || exists(joinPath(dir, 'models.json'))) return dir
  return undefined
}
