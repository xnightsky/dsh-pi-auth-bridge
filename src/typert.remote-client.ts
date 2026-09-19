/**
 * Host-for-Client Remote 投影（手写产物，原因见 typert-common.ts 模块头）。
 * 浏览器半区 `ctx.remote.$mount(TYPERT_REMOTE)` 后获得 `piAuthBridge`
 * 命名空间的类型化调用代理。类型锚定在协议包的
 * `TypertRemoteContribution` 上，格式漂移由 typecheck 拦截。
 *
 * @module dsh-pi-auth-bridge/typert.remote-client
 */
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { BridgeStatus } from './status.js'
import { statusInvocation, TYPERT_PACKAGE } from './typert-common.js'

/** `piAuthBridge` 命名空间的类型化方法表。 */
export interface PiAuthBridgeRemoteNamespace {
  /** 读取当前桥状态快照。 */
  status: () => Promise<RemoteResult<BridgeStatus>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piAuthBridge/status': () => Promise<RemoteResult<BridgeStatus>>
  }
  interface TypertRemoteNamespaceMap {
    piAuthBridge: PiAuthBridgeRemoteNamespace
  }
}

/** Client 面 Remote 贡献：仅含本包暴露的 `piAuthBridge/status`。 */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: TYPERT_PACKAGE,
  descriptors: [statusInvocation],
}

export default TYPERT_REMOTE
