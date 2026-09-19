/**
 * Host 面 TYPERT 清单（手写产物，原因见 typert-common.ts 模块头）。结构
 * 逐项对齐 `dsh-typert-loader` 的 validateTypertManifest 校验：包名属主、
 * face、schemas/model/invocations 各段的必填字段。dsh-typert-loader 在
 * Loader 组合中自动发现本包的 `./typert` 导出并注册进 `ctx.typert`。
 *
 * @module dsh-pi-auth-bridge/typert.host
 */
import { statusInvocation, TYPERT_PACKAGE } from './typert-common.js'

/** Host 面贡献清单。声明为 unknown：消费方（loader/registry）运行时校验。 */
export const TYPERT: unknown = {
  package: TYPERT_PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [statusInvocation],
  model: {
    services: [
      {
        key: 'piAuthBridge',
        exportName: 'PiAuthBridgeStatusService',
        summary: '桥状态服务：向浏览器半区暴露只读的桥状态快照（无凭据本体）。',
        description: '桥状态服务：向浏览器半区暴露只读的桥状态快照（无凭据本体）。',
        tags: [],
        jsDoc: '/** 桥状态服务：向浏览器半区暴露只读的桥状态快照（无凭据本体）。 */',
        members: [
          {
            kind: 'method',
            name: 'status',
            signature: "@Remote('status') status(): Promise<BridgeStatus>",
            summary: '返回当前桥状态快照（凭据本体已被状态模型剔除）。',
            jsDoc: '/** 返回当前桥状态快照（凭据本体已被状态模型剔除）。 */',
          },
        ],
        types: [
          {
            name: 'BridgeStatus',
            declaration: "export interface BridgeStatus { phase: 'bridged' | 'empty'; reason?: BridgeEmptyReason; detail?: string; piDir?: string; routes: BridgeRouteStatus[]; proxy: { enabled: boolean; detected: boolean }; warnings: string[] }",
          },
          {
            name: 'BridgeRouteStatus',
            declaration: "export interface BridgeRouteStatus { id: string; provider: string; kind: 'builtin' | 'custom'; api?: string; credential: 'api_key' | 'oauth' | 'none'; models: number }",
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
