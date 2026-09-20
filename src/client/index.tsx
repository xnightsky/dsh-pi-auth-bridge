/**
 * pi-auth-bridge 浏览器半区入口：Settings 面板的「Pi Auth Bridge」区块。
 * 挂载本包的 Typert Remote 贡献（`../typert.remote-client.js`），经
 * `piAuthBridge/status` 拉取桥状态快照、`piAuthBridge/probe` 触发能力探测；
 * 呈现层在 ./panel.js。面板只读，探测是用户点击触发的真实 API 调用。
 *
 * @module dsh-pi-auth-bridge/client
 */
import type { Context } from '@deepseek-ai/cordis'
// 类型合并来源：ctx.remote（gateway）、ctx.slots（renderer）、settings.section（settings）。
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { TYPERT_REMOTE } from '../typert/remote-client.js'
import type { BridgeStatus, ProbeRequest, ProbeResult } from '../panel/status.js'
import { PiAuthBridgeSection, type PiAuthBridgePanelFace } from './panel.js'

/** Client 半区所需服务：slot 注册表与 Remote 装配面。 */
export const inject = ['slots', 'remote']

/** 浏览器半区插件名（logger 用）。 */
export const name = 'pi-auth-bridge'

export { PiAuthBridgeSection }
export type { PiAuthBridgePanelFace }

/**
 * 浏览器半区入口：挂载 Remote 贡献，然后派生一个 park 在
 * `remote.piAuthBridge` 命名空间服务上的子插件——cordis 对点分服务键强制
 * 检查 fiber 的 inject 声明，而命名空间服务由 $mount 异步创建，所以面板
 * 注册必须放在子插件里：服务出现后子插件才启动，此时访问合法（这是
 * gateway 为第三方 Remote 设计的官方等待模式）。
 */
export function apply(ctx: Context): void {
  const mounted = ctx.remote.$mount(TYPERT_REMOTE)
  mounted.catch((error: unknown) => {
    // 挂载失败时子插件永远 park（面板不出现），必须显式报出，禁止静默失败。
    ctx.logger(name).warn(`pi-auth-bridge: failed to mount the remote contribution: ${(error as Error).message}`)
  })
  ctx.plugin({
    name: 'pi-auth-bridge-panel',
    inject: ['slots', 'remote.piAuthBridge'],
    apply: (panelCtx: Context) => {
      const loadStatus = async (): Promise<BridgeStatus> => {
        const result = await panelCtx.remote.piAuthBridge.status()
        if (!result.ok) throw new Error(`remote status failed: ${JSON.stringify(result.error)}`)
        return result.value
      }
      const probe = async (request: ProbeRequest): Promise<ProbeResult> => {
        const result = await panelCtx.remote.piAuthBridge.probe(request)
        if (!result.ok) throw new Error(`remote probe failed: ${JSON.stringify(result.error)}`)
        return result.value
      }
      panelCtx.slots.inject('settings.section', () =>
        panelCtx.slots.register({
          name: 'settings.section',
          id: 'pi-auth-bridge',
          order: 100,
          label: () => 'Pi Auth Bridge',
          inject: (): PiAuthBridgePanelFace => ({ loadStatus, probe }),
        }, PiAuthBridgeSection),
      )
    },
  })
}
