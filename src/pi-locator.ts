/**
 * 跨平台定位 pi（Pi coding agent）配置目录。
 *
 * 解析优先级：显式 `piDir` > `$PI_CODING_AGENT_DIR` >
 * `homedir()/.pi/agent`（Windows 上为 `%USERPROFILE%\.pi\agent` ——
 * `os.homedir()` 天然跨平台）。候选目录只有在至少持有 `auth.json` /
 * `models.json` 之一时才算有效。
 *
 * 每个环境接触点（环境变量、homedir、文件系统存在性、路径拼接）都可注入，
 * 因此 win32 与 posix 的路径逻辑可以在任一平台上单元测试，无需触碰真实机器。
 *
 * @module dsh-pi-bridge/pi-locator
 */
import { existsSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

export interface LocatePiDirOptions {
  /** 显式覆盖；优先于其他所有来源。空字符串视为缺省。 */
  piDir?: string
  /** 读取 `PI_CODING_AGENT_DIR` 所用的环境。默认 `process.env`。 */
  env?: NodeJS.ProcessEnv
  /** 主目录来源。默认 `os.homedir`。 */
  homedir?: () => string
  /** 存在性探测。默认 `fs.existsSync`。 */
  exists?: (path: string) => boolean
  /** 路径拼接器。默认 `path.join`；传入 `path.win32.join` 可演练 Windows 拼接。 */
  joinPath?: (...parts: string[]) => string
}

/** 非空字符串，否则为 undefined。 */
function present(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

/**
 * 定位 pi 配置目录。
 *
 * @returns 目录存在且持有 `auth.json` 或 `models.json` 时返回该目录；
 *   pi 未安装（或两者都不存在）时返回 `undefined` —— 调用方必须将其
 *   视为「空挂载」，绝不可视为错误。
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
