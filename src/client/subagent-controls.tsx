/**
 * 子智能体授权控件：只订阅原生配置面，开关仅编辑草稿，保存才提交授权。
 * 缺少服务或权限时降级为不可编辑，不影响桥状态与能力探测。
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SubagentModelsController, type SubagentModelsSnapshot, type SubagentSettings } from './subagent-models.js'

/** 获取宿主共享授权配置面；服务缺失时返回空值。 */
export type GetSubagentForm = () => ConfigForm<SubagentSettings> | undefined

/** 共用于授权区和模型行的编辑器面。 */
export interface SubagentControl {
  state: SubagentModelsSnapshot
  controller: SubagentModelsController | undefined
}

const UNAVAILABLE: SubagentModelsSnapshot = {
  status: 'unavailable', editable: false, enabled: false, allowedModels: [],
  dirty: false, invalid: false, saving: false, conflicted: false, error: undefined,
}
const readUnavailable = () => UNAVAILABLE
const subscribeUnavailable = () => () => {}

/** 挂载时创建编辑器、卸载时释放订阅，不销毁共享配置面。 */
export function useSubagentModels(getForm: GetSubagentForm | undefined): SubagentControl {
  const [controller, setController] = useState<SubagentModelsController>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let next: SubagentModelsController
    try {
      next = new SubagentModelsController(getForm?.())
      setError(undefined)
    } catch (cause) {
      next = new SubagentModelsController(undefined)
      setError(`无法读取子智能体授权：${cause instanceof Error ? cause.message : String(cause)}`)
    }
    setController(next)
    return () => { next.dispose() }
  }, [getForm])
  const state = useSyncExternalStore(controller?.subscribe ?? subscribeUnavailable, controller?.getSnapshot ?? readUnavailable, readUnavailable)
  return { controller, state: error === undefined ? state : { ...state, error } }
}

function statusText(state: SubagentModelsSnapshot): string {
  if (state.status === 'loading') return '正在读取子智能体授权…'
  if (state.status === 'unavailable') return '当前宿主未提供子智能体授权设置，请使用官方页面或检查插件是否启用。'
  if (!state.editable) return '宿主授权设置只读，无法在此修改。'
  if (state.saving) return '正在保存子智能体授权…'
  return state.dirty ? '存在未保存的授权修改。' : '当前显示宿主已保存的授权。'
}

/** 原生授权总开关与保存入口；不会隐式启用全局选模或清空授权。 */
export function SubagentSettingsPanel({ control }: { control: SubagentControl }): ReactNode {
  const { state, controller } = control
  const disabled = !state.editable || state.saving || state.conflicted
  return (
    <div aria-label="子智能体模型授权">
      <label>
        <input type="checkbox" role="switch" checked={state.enabled} disabled={disabled} onChange={() => controller?.toggleEnabled()} />
        允许 Agent 为子智能体选择模型
      </label>
      <p>展开下方路由，在模型行切换「允许子智能体使用」，然后保存。修改与官方页面共用同一份授权。</p>
      <p>关闭总开关会保留已选模型；仅对新会话生效，不改变已有会话，也不会发起模型调用。</p>
      <p>在对话中可告诉 Agent：<code>请调用 list_subagent_models，先列出 provider，再逐个查询模型，汇总本会话的子智能体候选清单。</code></p>
      <p>这是工具名，不是输入即执行的命令；仅在当前会话提供该工具时有效，列出的是本会话授权下可发现的候选，不保证实际调用成功。修改授权后请新建会话再查询。</p>
      <p role="status">{statusText(state)}</p>
      {state.invalid && <p role="alert">开启自主选模时至少保留一个授权模型，或显式关闭总开关后再保存。</p>}
      {state.conflicted && <p role="alert">授权已在其他页面更新，请取消修改后重新选择，避免覆盖最新授权。</p>}
      {state.error !== undefined && <p role="alert">{state.error}</p>}
      <button type="button" disabled={disabled || !state.dirty || state.invalid} onClick={() => { void controller?.save() }}>保存子智能体授权</button>{' '}
      <button type="button" disabled={!state.dirty || state.saving} onClick={() => controller?.discard()}>取消授权修改</button>
    </div>
  )
}

/** 模型行中的精确授权开关；关闭全局选模时不会自动代为开启。 */
export function SubagentModelToggle({ control, provider, model }: { control: SubagentControl; provider: string; model: string }): ReactNode {
  const { state, controller } = control
  const checked = state.allowedModels.some((route) => route.provider === provider && route.model === model)
  return (
    <label>
      <input type="checkbox" role="switch" aria-label={`允许子智能体使用 ${provider}/${model}`} checked={checked}
        disabled={!state.editable || !state.enabled || state.saving || state.conflicted}
        onChange={() => controller?.toggleModel({ provider, model })} />
      允许子智能体使用
    </label>
  )
}
