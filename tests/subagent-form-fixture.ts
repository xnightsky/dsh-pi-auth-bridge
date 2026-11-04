/** 子智能体授权测试配置面：完全内存化，不访问真实宿主或凭据。 */
import { vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SubagentSettings } from '../src/client/subagent-models.js'

/** 创建带 revision 校验的官方配置面替身，供控制器与面板共同使用。 */
export function subagentForm(value: SubagentSettings = { enabled: true, allowedModels: [] }) {
  let snapshot: ConfigFormSnapshot<SubagentSettings> = { status: 'ready', value, base: {}, user: {}, revision: 7, writable: true }
  const listeners = new Set<() => void>()
  const update = (patch: Partial<ConfigFormSnapshot<SubagentSettings>>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const mutate = vi.fn<ConfigForm<SubagentSettings>['mutate']>(async (operations, revision) => {
    if (revision !== snapshot.revision) return false
    const next = { ...snapshot.value! }
    for (const operation of operations) {
      if (operation.path[0] === 'enabled') next.enabled = operation.value as boolean
      if (operation.path[0] === 'allowedModels') next.allowedModels = operation.value as SubagentSettings['allowedModels']
    }
    update({ value: next, revision: snapshot.revision! + 1 })
    return true
  })
  const form: ConfigForm<SubagentSettings> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate, set: vi.fn(), unset: vi.fn(),
  }
  return { form, mutate, update, listeners }
}
