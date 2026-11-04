/**
 * 原生子智能体授权编辑器：仅暂存草稿，经官方共享配置面原子保存。
 * 不接触凭据或文件；保留非目标授权，禁止无 revision 的覆盖写入。
 */
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

/** 宿主原生子智能体选模设置的命名空间。 */
export const SUBAGENT_NAMESPACE = 'subagent-model-selection-settings'

/** 宿主授权使用的精确模型身份，不按斜线拆分。 */
export interface AllowedModel {
  provider: string
  model: string
}

/** 官方子智能体设置配置面的两个受管字段。 */
export interface SubagentSettings {
  enabled: boolean
  allowedModels: AllowedModel[]
}

/** 编辑器稳定快照；授权值可能是尚未保存的草稿。 */
export interface SubagentModelsSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  editable: boolean
  enabled: boolean
  allowedModels: readonly AllowedModel[]
  dirty: boolean
  invalid: boolean
  saving: boolean
  conflicted: boolean
  error: string | undefined
}

type Draft = SubagentSettings & { revision: number }
const sameModel = (left: AllowedModel, right: AllowedModel): boolean => left.provider === right.provider && left.model === right.model
const sameSettings = (left: SubagentSettings, right: SubagentSettings): boolean => left.enabled === right.enabled
  && left.allowedModels.length === right.allowedModels.length
  && left.allowedModels.every((model) => right.allowedModels.some((other) => sameModel(model, other)))

/** 共享配置面的轻量领域控制器；订阅归本实例所有，配置面始终归宿主所有。 */
export class SubagentModelsController {
  private draft: Draft | undefined
  private saving = false
  private disposed = false
  private error: string | undefined
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private snapshot: SubagentModelsSnapshot

  /** 绑定可选原生配置面；缺失时只提供不可编辑的降级快照。 */
  constructor(private readonly form: ConfigForm<SubagentSettings> | undefined) {
    this.snapshot = this.project()
    this.unsubscribe = form?.subscribe(() => {
      const current = form.getSnapshot()
      if (current.status !== 'ready' || (!this.saving && this.draft && current.value && sameSettings(this.draft, current.value))) {
        this.draft = undefined
        this.error = undefined
      }
      this.publish()
    }) ?? (() => {})
  }

  /** 读取稳定快照，供 React 外部 store 订阅。 */
  getSnapshot = (): SubagentModelsSnapshot => this.snapshot

  /** 订阅本实例投影，不拥有宿主共享配置面的生命周期。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 显式切换全局自主选模草稿，保留所有模型授权。 */
  toggleEnabled = (): void => {
    if (!this.canEdit()) return
    const draft = this.beginDraft()
    draft.enabled = !draft.enabled
    this.error = undefined
    this.publish()
  }

  /** 仅增删指定 PI 模型的授权草稿，不写入、不改变全局开关。 */
  toggleModel = (model: AllowedModel): void => {
    if (!model.provider.startsWith('pi/') || model.provider.length <= 3 || model.model.length === 0) {
      throw new Error('只能编辑有效的 PI 模型授权。')
    }
    if (!this.canEdit() || !this.snapshot.enabled) return
    const draft = this.beginDraft()
    const selected = draft.allowedModels.some((other) => sameModel(model, other))
    draft.allowedModels = selected ? draft.allowedModels.filter((other) => !sameModel(model, other)) : [...draft.allowedModels, { ...model }]
    this.error = undefined
    this.publish()
  }

  /** 丢弃未保存草稿，立即回到共享配置面的最新授权。 */
  discard = (): void => {
    if (this.saving || this.disposed) return
    this.draft = undefined
    this.error = undefined
    this.publish()
  }

  /** 以草稿起始 revision 原子保存；拒绝、冲突和传输错误均保留草稿并显式报告。 */
  save = async (): Promise<boolean> => {
    if (!this.canEdit() || !this.draft || !this.snapshot.dirty || this.snapshot.invalid) return false
    const desired = this.draft
    this.saving = true
    this.error = undefined
    this.publish()
    try {
      const accepted = await this.form!.mutate([
        { op: 'set', path: ['enabled'], value: desired.enabled },
        { op: 'set', path: ['allowedModels'], value: desired.allowedModels.map((model) => ({ ...model })) },
      ], desired.revision)
      if (this.disposed) return accepted
      const current = this.form!.getSnapshot().value
      if (accepted && current && sameSettings(desired, current)) {
        this.draft = undefined
        return true
      }
      this.error = '授权保存未被确认，可能已在其他页面更新；请取消修改后重试。'
      return false
    } catch (cause) {
      if (!this.disposed) this.error = `授权保存失败：${cause instanceof Error ? cause.message : String(cause)}`
      return false
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /** 释放自己的订阅并忽略迟到结果；不销毁宿主配置面。 */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.listeners.clear()
  }

  private canEdit(): boolean {
    return !this.disposed && this.snapshot.editable && !this.saving && !this.snapshot.conflicted
  }

  private beginDraft(): Draft {
    if (!this.draft) {
      const current = this.form!.getSnapshot()
      this.draft = { enabled: current.value!.enabled, allowedModels: current.value!.allowedModels.map((model) => ({ ...model })), revision: current.revision! }
    }
    return this.draft
  }

  private project(): SubagentModelsSnapshot {
    const current = this.form?.getSnapshot()
    const desired = this.draft ?? current?.value
    return {
      status: current?.status ?? 'unavailable',
      editable: current?.status === 'ready' && current.writable && current.value !== undefined && current.revision !== undefined,
      enabled: desired?.enabled ?? false,
      allowedModels: desired?.allowedModels ?? [],
      dirty: this.draft !== undefined,
      invalid: desired?.enabled === true && desired.allowedModels.length === 0,
      saving: this.saving,
      conflicted: !this.saving && this.draft !== undefined && current?.revision !== this.draft.revision,
      error: this.error,
    }
  }

  private publish(): void {
    if (this.disposed) return
    const value = this.form?.getSnapshot().value
    if (!this.saving && this.draft && value && sameSettings(this.draft, value)) this.draft = undefined
    this.snapshot = this.project()
    for (const listener of this.listeners) listener()
  }
}
