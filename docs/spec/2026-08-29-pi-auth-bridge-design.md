# pi-auth-bridge (dsh-pi-auth-bridge) 设计

> 状态：已落地（v0.1.0）
>
> 日期：2026-08-29
>
> 本文是设计真相源；设计变更先改本文，再改代码。

dsh 插件：把本机 pi（pi-mono / Pi coding agent）的认证（`models.json` + `auth.json`）在**内存中**转换为 dsh 的 LLM 路由，即转即用、绝不落地。相当于一座 auth adapter 桥。

## 0. 背景事实（已核实，不要重新调研）

### pi 侧
- 配置目录：`$PI_CODING_AGENT_DIR`，否则 `~/.pi/agent`（Windows 即 `%USERPROFILE%\.pi\agent`；`os.homedir()` 天然跨平台）。
- `auth.json`（0600）：`Record<providerId, PiAuthEntry>`
  - `{ "type": "api_key", "key": "sk-..." }`
  - `{ "type": "oauth", "access": "...", "refresh": "...", "expires": <epochMs> }`
- `models.json`：`{ "providers": Record<providerId, PiProvider> }`
  - `PiProvider`: `baseUrl?`, `api?` (`openai-completions` | `anthropic-messages` | `google-generative-ai` | ...), `apiKey?`, `headers?`, `authHeader?`, `name?`, `models?: [{ id, name?, contextWindow?, maxTokens?, reasoning?, cost? }]`
- pi 的取值解析（`apiKey`、`headers` 值、`auth.json` 的 `key`）：
  - `"$ENV_VAR"` → 读环境变量
  - `"!cmd args"` → shell 命令，请求时执行取 stdout
  - 其他 → 字面量

### dsh 侧
- 插件 = TS 模块导出 `name` + `Config`（schemastery）+ `apply(ctx, config)`；经 cordis.yml `insert` 以绝对路径加载。
- LLM seam：`@deepseek-ai/dsh-llm`。核心契约见其 `src/types.ts`：
  - `ctx.llm.registerAdapter(routes: string[], adapter: LlmAdapter)`（重复路由抛错；返回 disposable）
  - `LlmAdapter`：实现 `stream(options): AsyncIterable<StreamChunk>`、`resolveModel()`、`listProviders()`、`listModels()` 等（以实际类型为准）
- **参考实现**：dsh 仓库 `packages/llm/llm-pi-ai/src/`（adapter.ts / stream.ts / provider.ts / auth.ts）——本插件是它的极简特化：无 settings seam、无登录流程、无 retry 包、纯内存凭据。
- 协议义务（必须遵守，详见 dsh 仓库 `docs/cookbook/adding-an-llm-adapter.md`）：
  - `usage` 在 `finish` 之前发出；`finish` 之后不再发任何 chunk
  - 工具调用 `arguments` 为原始 JSON 字符串，流式用 `argumentsDelta`
  - 块 `index` 按首次出现顺序分配并复用
  - 错误仅两条路径：`stream()` 抛 `LlmError`（带稳定 code），或 `finish {kind:'error'|'aborted'}`
  - 遵守 `options.signal`
  - 不支持的 option → 抛 `LlmError(..., 'UNSUPPORTED_OPTION')`，不静默丢弃
- pi-ai 库：`@earendil-works/pi-ai`@^0.84，导出 `createModels`、`Models.streamSimple()`、`AuthContext`、`CredentialStore` 等（以安装后的 .d.ts 为准）。
- dsh web 模型选择器的展示结构（2026-08-29 核实全局安装产物）：只有两级「分组 → 模型」。分组 key = provider 路由 id **原样**（不按 `/` 或任何分隔符切分），分组标题 = `LlmProviderInfo.name`；路由 id 仅校验非空，`/` 合法。因此 PI 无法成为真正的三级「渠道」，出处只能编码进路由 id 前缀与分组标题（见 §2.3）。

## 1. 项目形态

- 独立 npm 包 `dsh-pi-auth-bridge`，ESM，TypeScript。
- dependencies: `@earendil-works/pi-ai`, `@deepseek-ai/schemastery`
- peerDependencies: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`
- devDependencies: `typescript`, `vitest`, `@types/node`
- 构建：`tsc` → `dist/`（ESM + .d.ts）。同时支持 dsh 直接按绝对路径加载 `src/index.ts`。
- 遵循 dsh 插件（bundle）官方规范：入口导出 `name` / `inject: ['llm']` / `Config` / `apply`；`package.json` 声明 `dsh.bundle.patch` → 根目录 `cordis.patch.yml`（默认零配置 `insert`，id 为 `pi-auth-bridge`）；`cordis.patch.yml` 列入 `files` 随包发布。

## 2. 模块划分

```
src/
  pi-locator.ts   # 跨平台定位 pi 配置目录
  pi-auth.ts      # auth.json / models.json 类型 + 容错解析 + 取值解析（literal/$ENV/!cmd）
  convert.ts      # pi → 路由定义转换（纯函数，可单测）
  provider.ts     # 由 RouteDef 构建 pi-ai Provider/Models（目录复用或 models.json 物化）
  request.ts      # dsh GenerateOptions → pi-ai Context 的请求转换
  stream.ts       # pi-ai 事件流 → dsh StreamChunk 的翻译（usage→finish）
  adapter.ts      # PiAuthBridgeAdapter implements LlmAdapter（组合以上三者）
  index.ts        # cordis 插件入口
tests/            # vitest
README.md         # 中文为主，附 English 摘要
```

### 2.1 pi-locator.ts
- `locatePiDir(opts: { piDir?: string; env?: NodeJS.ProcessEnv; homedir?: () => string }): string | undefined`
- 优先级：显式 `piDir` > `env.PI_CODING_AGENT_DIR` > `homedir()/.pi/agent`
- 存在性校验（`auth.json`/`models.json` 至少其一存在才算有效），返回 `undefined` 表示未找到
- 纯函数注入 env/homedir，便于 Windows/Linux 双平台单测（用 win32 风格路径样本测拼接逻辑）

### 2.2 pi-auth.ts
- 类型：`PiAuthEntry = {type:'api_key',key:string} | {type:'oauth',access:string,refresh?:string,expires?:number}`
- `readPiAuth(dir)`, `readPiModels(dir)`：文件不存在 → `undefined`；JSON 损坏 → 抛带路径信息的 `PiAuthBridgeError`；条目形态非法 → 跳过该条并 warn（不整体失败）
- `resolvePiValue(raw, {env, execCmd}): string | undefined`：实现 `$ENV` / `!cmd` / 字面量三态；`!cmd` 带超时（默认 10s）与内存缓存；失败返回 `undefined` 并 warn

### 2.3 convert.ts
- `buildRoutes(auth, models, opts): RouteDef[]`
- 对每个 `auth.json` 里有凭据的 provider：生成路由（provider 元数据交给 pi-ai 内置目录）
- 对每个 `models.json` 自定义 provider：生成路由 `{ api, baseURL, models, headers, authHeader }`，apiKey 解析顺序 = auth.json 同名片 > models.json `apiKey` 字段
- `oauth` 条目：`access` 未过期 → 当 apiKey 用；已过期且有 `refresh` → 交给 pi-ai 的 OAuth 刷新机制（内存态，**不回写**）；都不行的跳过并 warn。注意刷新机制只存在于 pi-ai 目录 provider：自定义 provider 持有过期 OAuth（无 apiKey）时在 adapter 构建期跳过并 warn（见 §2.4），否则会产生一条必然 401 的死路由
- `opts.providers?: string[]` 白名单过滤；路由名**固定** `pi/<providerId>` 前缀（`PI_ROUTE_PREFIX`，不可配——避免与 dsh 原生及其他适配器路由撞名）；`displayName` 恒为 `Pi · <名称>`（custom 用其 `name`，builtin 用 provider id）——dsh web 选择器没有三级「渠道」结构，PI 出处只能由路由 id 前缀与分组标题共同表达（见 §0 末条）

### 2.4 adapter.ts（组合 provider.ts / request.ts / stream.ts）
- `class PiAuthBridgeAdapter extends LlmAdapter`：构造时接收冻结的 `RouteDef[]` 与 pi-ai `Models` 集合（`createModels` 构建，凭据经内存 CredentialStore/AuthContext 注入，或在每次 stream 调用以 `apiKey` override 传入——以 pi-ai 实际 API 为准，参照 llm-pi-ai 的做法）
- 遵守第 0 节全部协议义务；图片附件 v1 不支持 → 遇 image block 抛 `UNSUPPORTED_OPTION`
- 凭据只存在于内存：不写 dsh 凭据存储、不写任何文件、不调用 `ctx.credentials.set`
- **attribution 头是 dsh-llm 的强制协议义务**（`attributionHeaders()`，可替换不可抑制）：每次请求合并进 headers；`models.json` 自定义头与之同名（大小写不敏感）时让位，并在构建期 warn，不静默丢弃
- `models.json` 的 `authHeader: true` 接通：该路由的 apiKey 以 `Authorization: Bearer <key>` 头发送（pi-ai 无 authHeader 概念，由桥自身注入），不再走 pi-ai 的 apiKey override
- `options.sessionId` 透传给 pi-ai（`SimpleStreamOptions.sessionId`，用于会话亲和）
- 历史消息中 role 为 `system` 的消息降级拼平为 user 消息（pi-ai Context 只有一个 systemPrompt 槽位，由 `options.system` 占用；降级保持消息顺序）
- 自定义 provider（不在 pi-ai 目录）只持过期 OAuth 时：构建期跳过并 warn（pi-ai 的 OAuth 刷新机制只存在于目录 provider）

### 2.5 index.ts
```ts
export const name = 'pi-auth-bridge'
export const Config = z.object({
  piDir: z.string().optional(),        // 覆盖 pi 配置目录
  providers: z.array(z.string()).optional(), // 白名单
  includeOAuth: z.boolean().default(true),
  commandTimeoutMs: z.number().default(10000),
})
export function apply(ctx, config) { /* locate→read→convert→registerAdapter；ctx.effect 清理函数反注册 */ }
```
- cordis 4 没有类型化的 `dispose` 事件；反注册挂在 `ctx.effect` 的清理函数上（fiber 销毁时执行，`registerAdapter` 返回的 disposable 本身也随 fiber 释放）
- 找不到 pi 目录或无任何可用路由：`apply` 不抛错，打 warn 后空挂载（dsh 组合不应因未装 pi 而崩）

## 3. 测试（vitest）
- locator：显式 piDir / PI_CODING_AGENT_DIR / homedir 回退 / 全部缺失；win32 与 posix 路径样本
- pi-auth：api_key、oauth（过期/未过期）、文件缺失、坏 JSON、非法条目跳过、`$ENV`/字面量/`!cmd`（mock exec）
- convert：内置 provider 路由、models.json 自定义 provider 全字段映射、白名单、固定 `pi/` 前缀与 `Pi ·` 冠名、apiKey 优先级
- adapter：用 pi-ai 的 mock/fake 流验证 chunk 顺序（usage→finish）、tool-call argumentsDelta、signal 中止、UNSUPPORTED_OPTION
- 全部 `npm test`（或 `npx vitest run`）必须通过

## 4. README 要点（已落实）
- 安装与 cordis.yml 配置示例（绝对路径 insert 两种：src/index.ts 与 dist/index.js）
- 与官方 `@deepseek-ai/dsh-llm-pi-ai` 的区别（那个面向 harness 自有凭据/登录体系；本插件零配置复用 pi 已有登录态，不落地）
- 安全说明：只读 pi 文件；凭据全程内存；不修改 `~/.pi` 与 `$DSH_HOME` 下任何文件
- Windows + Linux 支持说明（路径、PI_CODING_AGENT_DIR）
