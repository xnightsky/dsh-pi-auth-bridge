/**
 * 桥状态服务：把 §5.1 的可变状态盒以 Typert Remote 契约暴露给浏览器半区。
 * 服务在 apply 开头即挂载、不依赖 llm，因此空挂载时面板同样可读状态。
 *
 * 契约注解约定（供 `@deepseek-ai/dsh-typert-generator` 分析）：服务经
 * `declare module '@deepseek-ai/cordis'` 的 Context 增广被发现，`@Remote`
 * 使用 TC39 标准装饰器（不要开 `experimentalDecorators`）。
 *
 * @module dsh-pi-auth-bridge/status-service
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { BridgeStatus, BridgeStatusBox, ProbeRequest, ProbeResult } from './status.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** pi-auth-bridge 的桥状态服务（只读快照，无凭据本体）。 */
    piAuthBridge: PiAuthBridgeStatusService
  }
}

/**
 * 桥状态服务。cordis key `piAuthBridge` 即 Typert 默认 wire 命名空间。
 * 只暴露一个无参只读方法；无任何写操作面。
 */
export class PiAuthBridgeStatusService extends TypertRemoteService {
  private readonly box: BridgeStatusBox

  constructor(ctx: Context, box: BridgeStatusBox) {
    super(ctx, 'piAuthBridge')
    this.box = box
  }

  /** 返回当前桥状态快照（凭据本体已被 §5.1 的状态模型剔除）。 */
  @Remote('status')
  status(): Promise<BridgeStatus> {
    return Promise.resolve(this.box.current)
  }

  /**
   * 对指定路由的指定模型跑能力探测（text/image/reasoning/toolCall）。
   * 用户点击触发的真实 API 调用；空挂载时返回 `not-bridged` 业务失败。
   */
  @Remote('probe')
  probe(request: ProbeRequest): Promise<ProbeResult> {
    const handler = this.box.probe
    if (handler === undefined) {
      return Promise.resolve({
        ok: false,
        route: request.route,
        model: request.model,
        code: 'not-bridged',
        message: 'pi-auth-bridge is mounted empty; no adapter available for probing',
      })
    }
    return handler(request)
  }
}
