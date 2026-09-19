/**
 * 插件自健康：版本表采集 + 启动自检（本地契约检查，无网络）。
 * 动机：2026-09-19 升级 dsh 0.1.6 后图片 offload 契约变化导致桥整体失效，
 * 面板却毫无迹象——插件自身健康必须可测、可见（设计文档 §5.8）。
 * 不变量：全部检查均为本地纯计算，绝不触网；单项失败只记录不抛出。
 *
 * @module dsh-pi-auth-bridge/self-health
 */
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { BridgeSelfCheck, BridgeVersions } from './status.js'

const localRequire = createRequire(import.meta.url)

/** 读依赖包版本；包未导出 ./package.json（如 pi-ai）时降级为缺省（面板显示「未知」）。 */
function depVersion(spec: string): string | undefined {
  try {
    return (localRequire(`${spec}/package.json`) as { version?: unknown }).version as string | undefined
  } catch {
    return undefined
  }
}

/** 采集关键组件版本表。 */
export function collectVersions(): BridgeVersions {
  const dshLlm = depVersion('@deepseek-ai/dsh-llm')
  const dshAttachment = depVersion('@deepseek-ai/dsh-attachment')
  const piAi = depVersion('@earendil-works/pi-ai')
  return {
    plugin: (localRequire('../package.json') as { version: string }).version,
    ...(dshLlm === undefined ? {} : { dshLlm }),
    ...(dshAttachment === undefined ? {} : { dshAttachment }),
    ...(piAi === undefined ? {} : { piAi }),
  }
}

/**
 * 启动自检（本地契约检查，无网络）：逐项回归「升级后桥整个炸掉」的历史
 * 故障面——dsh-llm 归因头契约、dsh-attachment 0.1.6 的 target 换算契约
 * （2026-09-19 事故）、图片请求前提（附件服务已挂载）。
 */
export function runSelfChecks(ctx: Context): BridgeSelfCheck[] {
  const checks: BridgeSelfCheck[] = []
  try {
    const headers = attributionHeaders()
    checks.push({ id: 'dsh-llm-contract', ok: typeof headers === 'object' && Object.keys(headers).length > 0 })
  } catch (error) {
    checks.push({ id: 'dsh-llm-contract', ok: false, message: (error as Error).message })
  }
  try {
    const target = requestImageDimensions(100, 100, 4_194_304)
    const valid = Number.isInteger(target.width) && target.width > 0 && Number.isInteger(target.height) && target.height > 0
    checks.push({ id: 'dsh-attachment-contract', ok: valid, ...(valid ? {} : { message: `unexpected target ${JSON.stringify(target)}` }) })
  } catch (error) {
    checks.push({ id: 'dsh-attachment-contract', ok: false, message: (error as Error).message })
  }
  const attachments = ctx.get('attachments')
  checks.push({
    id: 'attachments-service',
    ok: attachments !== undefined,
    ...(attachments === undefined ? { message: '附件服务未挂载，带图请求将显式报错' } : {}),
  })
  return checks
}
