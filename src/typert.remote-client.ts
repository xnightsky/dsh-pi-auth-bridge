/**
 * Host-for-Client Remote 投影（手写产物，原因见 typert-common.ts 模块头）。
 * 浏览器半区 `ctx.remote.$mount(TYPERT_REMOTE)` 后获得 `piAuthBridge`
 * 命名空间的类型化调用代理。类型锚定在协议包的
 * `TypertRemoteContribution` 上，格式漂移由 typecheck 拦截。
 *
 * @module dsh-pi-auth-bridge/typert.remote-client
 */
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { BridgeStatus, ProbeRequest, ProbeResult } from './status.js'
import { probeInvocation, statusInvocation, TYPERT_PACKAGE } from './typert-common.js'

/** `piAuthBridge` 命名空间的类型化方法表。 */
export interface PiAuthBridgeRemoteNamespace {
  /** 读取当前桥状态快照。 */
  status: () => Promise<RemoteResult<BridgeStatus>>
  /** 对指定路由的指定模型跑能力探测（用户点击触发的真实 API 调用）。 */
  probe: (request: ProbeRequest) => Promise<RemoteResult<ProbeResult>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piAuthBridge/status': () => Promise<RemoteResult<BridgeStatus>>
    'piAuthBridge/probe': (request: ProbeRequest) => Promise<RemoteResult<ProbeResult>>
  }
  interface TypertRemoteNamespaceMap {
    piAuthBridge: PiAuthBridgeRemoteNamespace
  }
}

/** Client 面 Remote 贡献：本包暴露的 `piAuthBridge/status` 与 `piAuthBridge/probe`。 */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: TYPERT_PACKAGE,
  descriptors: [statusInvocation, probeInvocation],
}

export default TYPERT_REMOTE
