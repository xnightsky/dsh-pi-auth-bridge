/**
 * 模型清单填充：注册后从 pi-ai 本地目录读取各路由的完整模型列表
 * （含 contextWindow，经 `listModels`/`resolveModel`），回填状态盒供面板
 * 展示。纯本地读取、无网络；失败仅 warn，不影响桥本身。
 *
 * @module dsh-pi-auth-bridge/model-list
 */
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { PiAuthBridgeAdapter } from '../bridge/adapter.js'
import type { Warn } from '../pi/auth.js'
import { modelListOf, type BridgeModelStatus, type BridgeStatusBox } from './status.js'

/** 异步填充各路由的模型清单；填充期间状态盒已易主（如空挂载）则放弃。 */
export async function fillModelLists(adapter: PiAuthBridgeAdapter, box: BridgeStatusBox, warn: Warn): Promise<void> {
  try {
    const lists = new Map<string, BridgeModelStatus[]>()
    for (const route of adapter.routes) {
      const listed = await adapter.listModels(route)
      const resolved = (await Promise.all(listed.map((info) => adapter.resolveModel(route, info.id).catch(() => undefined)))).filter(
        (info): info is LlmResolvedModelInfo => info !== undefined,
      )
      lists.set(route, modelListOf(listed, resolved))
    }
    const current = box.current
    if (current.phase !== 'bridged') return
    box.current = {
      ...current,
      routes: current.routes.map((route) => {
        const modelList = lists.get(route.id)
        return modelList === undefined ? route : { ...route, modelList }
      }),
    }
  } catch (error) {
    warn(`pi-auth-bridge: failed to collect model lists for the panel: ${(error as Error).message}`)
  }
}
