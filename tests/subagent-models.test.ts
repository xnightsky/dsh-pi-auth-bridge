import { describe, expect, it } from 'vitest'
import { SubagentModelsController } from '../src/client/subagent-models.js'
import { subagentForm } from './subagent-form-fixture.js'

const PI = { provider: 'pi/acme', model: 'acme-large' }
const OTHER = { provider: 'native', model: 'acme-large' }

describe('SubagentModelsController', () => {
  it('stages exact PI routes and atomically saves without replacing other grants', async () => {
    const fixture = subagentForm({ enabled: true, allowedModels: [OTHER] })
    const control = new SubagentModelsController(fixture.form)
    control.toggleModel(PI)
    expect(fixture.mutate).not.toHaveBeenCalled()
    expect(control.getSnapshot().allowedModels).toEqual([OTHER, PI])
    expect(await control.save()).toBe(true)
    expect(fixture.mutate).toHaveBeenCalledTimes(1)
    expect(fixture.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: ['allowedModels'], value: [OTHER, PI] },
    ], 7)
    expect(control.getSnapshot().dirty).toBe(false)
    control.dispose()
  })

  it('uses exact pairs rather than splitting slashes or matching model names', async () => {
    const collision = { provider: 'pi/acme/default', model: 'large' }
    const target = { provider: 'pi/acme', model: 'default/large' }
    const fixture = subagentForm({ enabled: true, allowedModels: [target, collision, OTHER] })
    const control = new SubagentModelsController(fixture.form)
    control.toggleModel(target)
    await control.save()
    expect(fixture.form.getSnapshot().value?.allowedModels).toEqual([collision, OTHER])
    control.dispose()
  })

  it('does not write for toggles cancelled back to the original state', async () => {
    const fixture = subagentForm({ enabled: true, allowedModels: [OTHER] })
    const control = new SubagentModelsController(fixture.form)
    control.toggleModel(PI)
    control.toggleModel(PI)
    expect(control.getSnapshot().dirty).toBe(false)
    expect(await control.save()).toBe(false)
    expect(fixture.mutate).not.toHaveBeenCalled()
    control.dispose()
  })

  it('requires an explicit enabled switch and keeps grants when disabled', async () => {
    const fixture = subagentForm({ enabled: false, allowedModels: [OTHER] })
    const control = new SubagentModelsController(fixture.form)
    control.toggleModel(PI)
    expect(control.getSnapshot().allowedModels).toEqual([OTHER])
    control.toggleEnabled()
    control.toggleModel(PI)
    control.toggleEnabled()
    await control.save()
    expect(fixture.form.getSnapshot().value).toEqual({ enabled: false, allowedModels: [OTHER, PI] })
    control.dispose()
  })

  it('blocks removing the last enabled grant without silently disabling selection', async () => {
    const fixture = subagentForm({ enabled: true, allowedModels: [PI] })
    const control = new SubagentModelsController(fixture.form)
    control.toggleModel(PI)
    expect(control.getSnapshot()).toMatchObject({ enabled: true, invalid: true })
    expect(await control.save()).toBe(false)
    expect(fixture.mutate).not.toHaveBeenCalled()
    control.toggleEnabled()
    expect(await control.save()).toBe(true)
    expect(fixture.form.getSnapshot().value).toEqual({ enabled: false, allowedModels: [] })
    control.dispose()
  })

  it.each(['loading', 'unavailable', 'readonly'] as const)('does not mutate a %s configuration', async (mode) => {
    const fixture = subagentForm({ enabled: true, allowedModels: [OTHER] })
    fixture.update(mode === 'readonly' ? { writable: false } : { status: mode })
    const control = new SubagentModelsController(fixture.form)
    control.toggleModel(PI)
    control.toggleEnabled()
    expect(await control.save()).toBe(false)
    expect(control.getSnapshot().editable).toBe(false)
    expect(fixture.mutate).not.toHaveBeenCalled()
    control.dispose()
  })

  it('keeps bridge controls safe when the settings namespace is absent', async () => {
    const control = new SubagentModelsController(undefined)
    expect(control.getSnapshot()).toMatchObject({ status: 'unavailable', editable: false })
    expect(await control.save()).toBe(false)
    control.dispose()
  })

  it('rejects non-PI authorization targets', () => {
    const fixture = subagentForm({ enabled: true, allowedModels: [OTHER] })
    const control = new SubagentModelsController(fixture.form)
    expect(() => control.toggleModel(OTHER)).toThrow('PI')
    control.dispose()
  })

  it('detects concurrent edits and lets discard read the latest policy', async () => {
    const fixture = subagentForm({ enabled: true, allowedModels: [OTHER] })
    const control = new SubagentModelsController(fixture.form)
    control.toggleModel(PI)
    const external = { provider: 'native', model: 'new-model' }
    fixture.update({ value: { enabled: true, allowedModels: [OTHER, external] }, revision: 8 })
    expect(control.getSnapshot().conflicted).toBe(true)
    expect(await control.save()).toBe(false)
    expect(fixture.mutate).not.toHaveBeenCalled()
    control.discard()
    expect(control.getSnapshot()).toMatchObject({ conflicted: false, dirty: false, allowedModels: [OTHER, external] })
    control.dispose()
  })

  it('reports Host refusal and transport failure without claiming a successful grant', async () => {
    const fixture = subagentForm({ enabled: true, allowedModels: [OTHER] })
    const control = new SubagentModelsController(fixture.form)
    control.toggleModel(PI)
    fixture.mutate.mockResolvedValueOnce(false)
    expect(await control.save()).toBe(false)
    expect(control.getSnapshot()).toMatchObject({ dirty: true, saving: false })
    expect(control.getSnapshot().error).toBeTruthy()
    fixture.mutate.mockRejectedValueOnce(new Error('transport offline'))
    expect(await control.save()).toBe(false)
    expect(control.getSnapshot().error).toContain('transport offline')
    expect(fixture.form.getSnapshot().value?.allowedModels).toEqual([OTHER])
    control.dispose()
  })

  it('serializes user saves and drops unsaved drafts when the Host becomes unavailable', async () => {
    const fixture = subagentForm({ enabled: true, allowedModels: [OTHER] })
    let finish!: (accepted: boolean) => void
    fixture.mutate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const control = new SubagentModelsController(fixture.form)
    control.toggleModel(PI)
    const pending = control.save()
    expect(await control.save()).toBe(false)
    control.toggleEnabled()
    control.toggleModel(PI)
    expect(fixture.mutate).toHaveBeenCalledTimes(1)
    expect(control.getSnapshot()).toMatchObject({ enabled: true, allowedModels: [OTHER, PI] })
    finish(false)
    await pending
    fixture.update({ status: 'loading', revision: undefined, value: undefined })
    expect(control.getSnapshot()).toMatchObject({ dirty: false, editable: false, status: 'loading' })
    control.dispose()
  })

  it('cleans subscriptions and never publishes a pending save after disposal', async () => {
    const fixture = subagentForm({ enabled: true, allowedModels: [OTHER] })
    let finish!: (accepted: boolean) => void
    fixture.mutate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const control = new SubagentModelsController(fixture.form)
    let published = 0
    control.subscribe(() => { published += 1 })
    control.toggleModel(PI)
    const saving = control.save()
    expect(control.getSnapshot().saving).toBe(true)
    const before = published
    control.dispose()
    finish(true)
    await saving
    expect(fixture.listeners.size).toBe(0)
    expect(published).toBe(before)
  })
})
