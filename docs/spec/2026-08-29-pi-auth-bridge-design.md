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
  - `PiProvider`: `baseUrl?`, `api?` (`openai-completions` | `anthropic-messages` | `google-generative-ai` | ...), `apiKey?`, `headers?`, `authHeader?`, `name?`, `models?: [{ id, name?, contextWindow?, maxTokens?, reasoning?, cost?, input? }]`
  - 模型条目的 `input?: ('text'|'image')[]` 是输入模态声明，dsh 据此判定图片能力：物化时以 models.json 声明优先，未声明回退 pi-ai 目录同名模型，目录也没有时默认 `['text']`
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
- **dsh-llm 版本范围 `^0.1.6-alpha.1`**（2026-09-19 实证宿主 dsh@0.1.6-alpha.2 / dsh-llm@0.1.6-alpha.2）：0.1.6-alpha 线重构了图片卸载——删除 `offloadRequestImagesWithPolicy`，`ImageBlock` 加 `offloaded` 持久标记，`readImageRequest` 的 target 变 `{width, height, maxBytes}`（正整数校验，见下条事故记录），路由改为 `requiredImageOffload` 计量 + 超预算抛 `LlmError(IMAGE_OFFLOAD_REQUIRED, { offloadImages })` 由宿主标记卸载后重试 + `projectOffloadedImages` 投影占位。本版本起只支持 0.1.6-alpha 线；0.1.2/0.1.5 线因导入符号已删除，加载即失败，不再保留在 peer 范围。历史：0.1.2 起 `LlmAdapter` 新增 `imageRequestPricing`（基类默认 `undefined` = 不声明图片计价，本插件沿用基类默认）；0.1.2 将 `CallId` 改名 `ToolCallId`。
- **图片附件支持**（2026-09-12 首版实证官方 `dsh-llm-pi-ai`@0.1.2-rc.1；2026-09-19 按 0.1.6-alpha.2 重写，对齐官方同版本实现）：dsh 的 image 块只携带 durable 引用（`attachmentId` + 元数据），字节在 dsh-attachment 服务里。流程：`collectImageRefs` 跳过 `offloaded: true` 的块 → `readImageRequest(ref, target, signal)` 生成请求版本，**target 必须按 ref 各自尺寸用 `requestImageDimensions(ref.width, ref.height, maxPixels)` 换算出 `{width, height, maxBytes}`**（默认预算 2048×2048 像素 / 1 MiB，与官方一致）→ 内联为 pi-ai 的 `{ type:'image', data: base64, mimeType }` 块并配 `requestImageHandleText` 句柄文本 → 以真实版本字节经 `requiredImageOffload`（20 MiB base64 请求级预算）计量，超预算抛 `LlmError(..., IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages })` 由宿主把最老 N 处标记 `offloaded` 后重试 → `projectOffloadedImages` 把已卸载块投影为 `offloadedImageText` 占位。pi-ai 只能回放 user 角色的图片（含 toolResult 嵌套），其他角色带图抛 `UNSUPPORTED_CONTENT`；模型 `input` 不含 `'image'` 或附件服务缺失时同样显式抛错。**桥直接依赖 `@deepseek-ai/dsh-attachment`**（`requestImageDimensions` 与 `ImageRequestTarget` 类型来自该包）——2026-09-19 事故（见下条）证明自造结构子集会与真实契约静默漂移且 typecheck 拦不住。
- **事故记录 2026-09-19**（宿主 dsh@0.1.6-alpha.2，会话导出 `dsh-session-session-3bcab0a6`）：宿主升级到 0.1.6 线后，桥仍按旧契约向 `readImageRequest` 传 `{maxPixels, maxBytes}`，`validateTarget` 抛 `Image request width must be a positive integer.`，凡带截图（CUA 工具）的请求全部失败。教训：与宿主服务的跨边界调用必须复用契约包的真实类型，禁止自造结构子集。
- pi-ai 库：`@earendil-works/pi-ai`@^0.84，导出 `createModels`、`Models.streamSimple()`、`AuthContext`、`CredentialStore` 等（以安装后的 .d.ts 为准）。
- **代理嗅探的责任在宿主进程，不在 pi-ai**（2026-09-11 实证）：pi-ai 所有线路直接用 `globalThis.fetch`，全包无 `setGlobalDispatcher`/`ProxyAgent`；Node 全局 fetch 默认不读 `http_proxy` 等变量（`NODE_USE_ENV_PROXY`/`--use-env-proxy` 自 Node 24.5 起存在但默认关闭）；dsh 宿主同样无代理处理。pi 本体能走代理，是因为 pi CLI 启动时 `configureHttpDispatcher()` 用 npm 包 `undici` 的 `EnvHttpProxyAgent({ allowH2: false, proxyTunnel: true, ... })` + `setGlobalDispatcher` + 重装 `globalThis.fetch` 做了进程级补丁。因此桥必须自己补这一环（见 §2.6）。
- pi-ai 的 `SimpleStreamOptions.fetch`（`FetchFunction = typeof globalThis.fetch`）是自定义 fetch 的注入点，会透传到各线路 adapter；但 `google-generative-ai` 与 `google-vertex` 两条线路的 adapter 显式抛错拒绝自定义 fetch（其请求由 `@google/genai` 内部发出）。
- dsh web 模型选择器的展示结构（2026-08-29 核实全局安装产物）：只有两级「分组 → 模型」。分组 key = provider 路由 id **原样**（不按 `/` 或任何分隔符切分），分组标题 = `LlmProviderInfo.name`；路由 id 仅校验非空，`/` 合法。因此 PI 无法成为真正的三级「渠道」，出处只能编码进路由 id 前缀与分组标题（见 §2.3）。
- 插件安装机制（2026-08-29 核实 `@deepseek-ai/dsh`@0.1.1-rc.2 全局产物 `lib/plugin-9h8shc4d.js`）：`dsh plugin --profile <name> <args...>` 是 pnpm 转发器，在 profile 目录执行 `pnpm <args...>`，因此 registry 包名 / git URL / tarball / 本地路径均可安装。安装后按真实包名 reconcile：声明了 `dsh.bundle.patch` 的依赖自动加入 `dsh.profile.bundles` 层栈，git/path/tarball 安装与 registry 安装行为一致。git 安装的包靠 `prepare` 脚本在安装时构建，pnpm 默认拦截依赖构建脚本，需把对应 key 加入 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后重跑（dsh 失败时会打印该提示）。pnpm 11 实测两轮拦截：插件 prepare 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；pi-ai 传递依赖 `@google/genai`/`protobufjs` 的构建脚本报 `ERR_PNPM_IGNORED_BUILDS`，pnpm 会把占位条目写入 `allowBuilds`，改为 `true` 重跑即可（2026-08-29 在 profile `pab-e2e` 端到端验证：git tag 安装成功、`dist/` 由 prepare 构建、bundle 自动入栈）。

### dsh 插件面板机制（2026-09-20 实证宿主 dsh@0.1.6-alpha.2 全局产物 + 官方文档）
- **双面（dual-face）插件形态**：单包可同时有 host 半区与 client（浏览器）半区。声明 = `package.json` 的 `exports["./client"]` + `dsh.client: { inject: [<包名>...], platform: "web" }`；host 扫描 Loader 条目自动组 `window.__DSH_BOOT__` 并经 `/plugins/<id>/client.js` 供浏览器加载，client 半区是 CJS 懒加载模块表（首次 require 才执行副作用）。社区参考实现：`dsh-live-stats`（tsc 产类型 + tsdown 打 client）。
- **UI 挂载点 = slot 系统**：client 半区 `ctx.slots.register({ name: 'settings.section', id, order, label }, Component)` 即在 Settings 面板挂出本插件区块（实证 `dsh-client-ui-settings-general` 用 `renderSlot('settings.section', …)` 渲染、`dsh-client-ui-settings-plugins` 以此注册）。slot 注册不需改 dsh 源码。0.1.5 起另有右侧边栏 tab（`ctx.sidebarRight`），本插件不用。
- **host→浏览器数据通道 = Typert Remote**：作者侧五步（实证官方文档 `learn/dev/typert-authoring` + 第一方参考 `dsh-message-feedback`）：① 导出服务类继承 `TypertRemoteService`（`@deepseek-ai/dsh-typert-protocol`，本地 0.1.6-alpha.2 已核实导出）并以 `@Remote('name')` 标注方法（TC39 标准装饰器签名，**不是** legacy experimentalDecorators）；② 构建期 `@deepseek-ai/dsh-typert-generator` 的 tsdown 插件 `typertPlugin({mode:'workspace',faces:['host']})` 产 `typert.host.{js,d.ts}` + `typert.remote-client.{js,d.ts}`（生成产物 import `zod`）；③ `package.json` exports 暴露 `./typert` 与 `./remote` 并列入 `files`；④ 宿主内置 `dsh-typert-loader` 自动发现 Loader 条目的 `./typert` 导出并注册进 `ctx.typert`（实证其 lib/index.js 模块头注释）；⑤ client 半区 `ctx.remote.$mount(TYPERT_REMOTE)`（`ctx.remote` 由 `@deepseek-ai/dsh-api-gateway` 的 client 半区提供，实证 `dsh-api-remotes/lib/client.js` 即以此挂载 14 个第一方 contribution）获得类型化调用代理。
- `@Remote` 方法的参数/返回值经 zod schema 过边界：只支持可投影类型（字面量/数组/union/interface/Record 等），函数、Map/Set、泛型根会直接分析失败；public 实例方法才可暴露。

## 1. 项目形态

- 独立 npm 包 `dsh-pi-auth-bridge`，ESM，TypeScript；**双面（dual-face）插件**：host 半区（cordis 插件）+ client 半区（Settings 面板区块，见 §5）。
- dependencies: `@earendil-works/pi-ai`, `@deepseek-ai/schemastery`, `undici`（§2.5 代理 fetch；对齐 pi CLI 同款）, `@deepseek-ai/dsh-typert-protocol`（§5 状态服务基类与 `@Remote` 装饰器）, `zod`（§5 生成的 remote-client 产物 import `zod`）
- peerDependencies: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`@^0.1.6-alpha.1, `@deepseek-ai/dsh-attachment`@^0.1.6-alpha.1, `react`（client 半区组件，宿主 web 提供）
- devDependencies: `typescript`, `vitest`, `@types/node`, `tsdown`（§5 client 打包）, `react`/`react-dom`/`@types/react`/`@types/react-dom` + `@testing-library/react` + `jsdom`（client 测试）, `@deepseek-ai/dsh-typert-registry`（产物回归测试）, `@deepseek-ai/dsh-api-gateway` / `@deepseek-ai/dsh-client-ui-renderer` / `@deepseek-ai/dsh-client-ui-settings`（client 半区类型合并来源）
- 构建：`tsc` → `dist/`（ESM + .d.ts，含手写 Typert 产物）；`tsdown` → `dist/client.js`（CJS 懒加载模块表，zod 内联）。同时支持 dsh 直接按绝对路径加载 `src/index.ts`。
- 遵循 dsh 插件（bundle）官方规范：入口导出 `name` / `inject: ['llm']` / `Config` / `apply`；`package.json` 声明 `dsh.bundle.patch` → 根目录 `cordis.patch.yml`（默认零配置 `insert`，id 为 `pi-auth-bridge`）；`cordis.patch.yml` 列入 `files` 随包发布。client 半区声明 `exports["./client"]` + `dsh.client.inject = ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-ui-renderer']`；Typert 产物声明 `exports["./typert"]` / `exports["./remote"]`。
- 分发与版本：git 直装（`prepare: npm run build` 在安装时构建 `dist/`）+ GitHub Release（push `v*` tag 触发 `.github/workflows/release.yml`，附 `npm pack` 产物）；`npm version` 手动发版，真相源 = `package.json` + `v*` tag；不发布 npm registry。

## 2. 模块划分

```
src/
  pi-locator.ts   # 跨平台定位 pi 配置目录
  pi-auth.ts      # auth.json / models.json 类型 + 容错解析 + 取值解析（literal/$ENV/!cmd）
  convert.ts      # pi → 路由定义转换（纯函数，可单测）
  provider.ts     # 由 RouteDef 构建 pi-ai Provider/Models（目录复用或 models.json 物化）
  proxy.ts        # 代理环境变量嗅探 + 注入式代理 fetch（EnvHttpProxyAgent）
  request.ts      # dsh GenerateOptions → pi-ai Context 的请求转换
  stream.ts       # pi-ai 事件流 → dsh StreamChunk 的翻译（usage→finish）
  adapter.ts      # PiAuthBridgeAdapter implements LlmAdapter（组合以上四者）
  status.ts       # §5 桥状态模型与收集（纯函数，可单测）
  status-service.ts # §5 TypertRemoteService 子类，@Remote('status') 暴露快照
  typert-common.ts  # §5 Typert 产物共享段（zod 投影 + status 描述符）
  typert.host.ts    # §5 Host 面 TYPERT 清单（手写产物，原因见 §5.3）
  typert.remote-client.ts # §5 Host-for-Client Remote 投影（含命名空间类型合并）
  client/index.tsx  # §5 浏览器半区：settings.section 状态面板
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
- 遵守第 0 节全部协议义务；图片附件经构造选项 `resolveAttachments`（index.ts 接线 `ctx.get('attachments')`）支持：模型声明 image 输入时按 §0「图片附件支持」转换；模型不支持或服务缺失 → 抛 `UNSUPPORTED_CONTENT`
- 凭据只存在于内存：不写 dsh 凭据存储、不写任何文件、不调用 `ctx.credentials.set`
- **attribution 头是 dsh-llm 的强制协议义务**（`attributionHeaders()`，可替换不可抑制）：每次请求合并进 headers；`models.json` 自定义头与之同名（大小写不敏感）时让位，并在构建期 warn，不静默丢弃
- `models.json` 的 `authHeader: true` 接通：该路由的 apiKey 以 `Authorization: Bearer <key>` 头发送（pi-ai 无 authHeader 概念，由桥自身注入），不再走 pi-ai 的 apiKey override
- `options.sessionId` 透传给 pi-ai（`SimpleStreamOptions.sessionId`，用于会话亲和）
- 历史消息中 role 为 `system` 的消息降级拼平为 user 消息（pi-ai Context 只有一个 systemPrompt 槽位，由 `options.system` 占用；降级保持消息顺序）
- 自定义 provider（不在 pi-ai 目录）只持过期 OAuth 时：构建期跳过并 warn（pi-ai 的 OAuth 刷新机制只存在于目录 provider）
- 代理注入：构造选项 `proxyFetch?: FetchFunction`（由 index.ts 按 §2.5 嗅探构造）；`stream()` 时除 `google-generative-ai`/`google-vertex`（pi-ai 拒绝自定义 fetch）外注入为 `SimpleStreamOptions.fetch`；google 路由每路由 warn 一次提示用 `NODE_USE_ENV_PROXY=1` 兜底

### 2.5 proxy.ts（代理环境变量嗅探与注入式代理 fetch）
- 问题：dsh 进程不做 pi CLI 的 `configureHttpDispatcher()` 全局补丁，pi-ai 也不读代理变量，桥接出的请求会裸连（见 §0 末两条）。桥必须在**不触碰全局状态**的前提下补上这一环。
- `hasProxyEnv(env = process.env): boolean`：是否配置了代理。认 `http_proxy`/`https_proxy`/`all_proxy` 及其大写形式；空串视为未设置；仅设 `no_proxy` 不算配置代理。
- `createEnvProxyFetch(env = process.env): FetchFunction | undefined`：无代理变量 → `undefined`（不注入，行为与之前一致）；否则用 `undici` 的 `EnvHttpProxyAgent` 构造一个带 dispatcher 的 fetch 返回。dispatcher 参数对齐 pi CLI：`allowH2: false, proxyTunnel: true`；代理地址与 `no_proxy` 从传入 env 显式映射（`all_proxy` 作 http/https 的兜底），未显式给出的项由 undici 回落 `process.env`（生产路径传入的即 `process.env`，语义一致）。
- 与 pi CLI 的关键区别：**绝不** `setGlobalDispatcher` / 重装 `globalThis.fetch`——桥是 dsh 进程内的插件，动全局状态会影响宿主与其他适配器；代理 fetch 只经 `SimpleStreamOptions.fetch` 注入到本桥自己的请求。
- 开关：`Config.proxy?: boolean`，默认 `true`（自动嗅探）。默认开的理由：插件卖点是零配置即转即用，环境变量已设好就期望被尊重；未设代理变量时嗅探为空、注入不发生，开关自闭合。`proxy: false` 用于「环境变量是给别的工具的，LLM 流量必须直连」的场景（内网镜像、本地端点、代理坏 SSE 等）。不做「显式代理 URL」配置面——环境变量本身就是那个配置面（YAGNI）。
- google 线路例外：`google-generative-ai`/`google-vertex` 的 pi-ai adapter 拒绝自定义 fetch，adapter 在 `stream()` 时按 `model.api` 跳过注入并对每路由 warn 一次；这两条线路的代理需求由方案 B 兜底。
- 方案 B（零代码兜底，写进 README）：以 `NODE_USE_ENV_PROXY=1`（Node ≥ 24.5）启动 dsh，让 Node 内建 fetch 自己读代理变量——覆盖 google 线路，也是不想依赖 undici 场景的全局备选。

### 2.6 index.ts
```ts
export const name = 'pi-auth-bridge'
export const Config = z.object({
  piDir: z.string().optional(),        // 覆盖 pi 配置目录
  providers: z.array(z.string()).optional(), // 白名单
  includeOAuth: z.boolean().default(true),
  commandTimeoutMs: z.number().default(10000),
  proxy: z.boolean().default(true),    // 嗅探代理环境变量并注入代理 fetch（§2.5）
})
export function apply(ctx, config) { /* locate→read→convert→registerAdapter；ctx.effect 清理函数反注册；proxy!==false 且嗅探到代理变量时构造代理 fetch 传给 adapter */ }
```
- cordis 4 没有类型化的 `dispose` 事件；反注册挂在 `ctx.effect` 的清理函数上（fiber 销毁时执行，`registerAdapter` 返回的 disposable 本身也随 fiber 释放）
- 找不到 pi 目录或无任何可用路由：`apply` 不抛错，打 warn 后空挂载（dsh 组合不应因未装 pi 而崩）

## 3. 测试（vitest）
- locator：显式 piDir / PI_CODING_AGENT_DIR / homedir 回退 / 全部缺失；win32 与 posix 路径样本
- pi-auth：api_key、oauth（过期/未过期）、文件缺失、坏 JSON、非法条目跳过、`$ENV`/字面量/`!cmd`（mock exec）
- convert：内置 provider 路由、models.json 自定义 provider 全字段映射、白名单、固定 `pi/` 前缀与 `Pi ·` 冠名、apiKey 优先级
- adapter：用 pi-ai 的 mock/fake 流验证 chunk 顺序（usage→finish）、tool-call argumentsDelta、signal 中止、UNSUPPORTED_OPTION
- proxy：`hasProxyEnv` 各变量族/空串/仅 no_proxy；`createEnvProxyFetch` 无代理返回 undefined、有代理返回函数；adapter 注入：普通线路带上 `fetch`、google 线路跳过且 warn 一次
- 全部 `npm test`（或 `npx vitest run`）必须通过

## 4. README 要点（已落实）
- 安装与 cordis.yml 配置示例（绝对路径 insert 两种：src/index.ts 与 dist/index.js）
- 与官方 `@deepseek-ai/dsh-llm-pi-ai` 的区别（那个面向 harness 自有凭据/登录体系；本插件零配置复用 pi 已有登录态，不落地）
- 安全说明：只读 pi 文件；凭据全程内存；不修改 `~/.pi` 与 `$DSH_HOME` 下任何文件
- Windows + Linux 支持说明（路径、PI_CODING_AGENT_DIR）
- 代理说明：默认嗅探 `http_proxy`/`https_proxy`/`all_proxy`/`no_proxy` 并注入代理 fetch；`proxy: false` 关闭；google 线路需 `NODE_USE_ENV_PROXY=1` 启动 dsh 兜底（§2.5 方案 B）

## 5. 插件面板（dual-face + Typert Remote）

> 目标：在 dsh web 的 Settings 面板挂出本插件区块，展示桥的真实运行状态与能力说明。机制事实见 §0「dsh 插件面板机制」。

### 5.1 状态模型（status.ts，纯数据 + 纯函数）
- `BridgeStatus` 是面板的唯一数据契约，也是 `@Remote` 的返回类型，必须只含 Typert 可投影类型：
  - `phase`: `'bridged' | 'empty'` —— 桥接成功 / 空挂载（empty 时带 `reason` 说明：pi 目录未找到 / 配置不可读 / 无可用凭据 / 路由全部不可服务 / llm 服务缺失）
  - `piDir?`: 实际使用的 pi 配置目录
  - `routes`: `{ id, provider, kind, api?, credential: 'api_key' | 'oauth' | 'none', models, modelList? }[]`；`modelList` 为完整模型清单（`{ id, name?, contextWindow?, input[] }`，注册后由 `listModels`/`resolveModel` 本地目录异步填充，无网络）
  - `proxy`: `{ enabled, detected }` —— 开关状态与是否嗅探到代理变量
  - `warnings`: 桥接过程收集的全部警告（与 logger.warn 同源）
  - `config?`: 生效配置回显（白名单 / includeOAuth / commandTimeoutMs）
  - `versions?` / `selfChecks?` / `recentErrors?`：插件自健康（§5.8）
  - `probes?`: 探测报告缓存（`Record<route\0model, ModelProbeReport>`，面板重开可见上次结果）
- **安全不变量：状态快照绝不包含凭据本体**（key/token/refresh 一律不出现），只有凭据类型；`!command` 与 `$ENV` 的原始表达式也不进快照。`piDir` 是本机路径，面板运行在与 launch URL 同信任级的本机浏览器里，可接受。
- 收集逻辑做成纯函数（从 locate/read/convert 各阶段的产出组装快照），apply 只负责调用与回填；各早退路径（含 llm 缺失）同样回填 `phase: 'empty'` + reason，保证面板永远有状态可看。

### 5.2 host 状态服务（status-service.ts）
- `PiAuthBridgeStatusService extends TypertRemoteService`，cordis key `piAuthBridge`（`declare module '@deepseek-ai/cordis'` 增广 Context）；构造时持有 §5.1 的可变状态盒。
- `@Remote('status') status(): Promise<BridgeStatus>` 返回当前快照。只读、无参数、无 lookup/context 身份解析——不注册 `ctx.typert.lookups/contexts`（YAGNI）。
- apply 开头即 `ctx.plugin(PiAuthBridgeStatusService, box)` 挂载服务，再走原有 locate→read→convert→register 流程；服务不依赖 llm，空挂载时面板仍可工作。
- `@Remote` 是 TC39 标准装饰器：tsconfig 不开 `experimentalDecorators`，TS ≥ 5 原生支持。

### 5.3 构建链与产物来源（手写 Typert 产物）
- **关键决策：Typert 产物手写，不跑官方生成器。** `@deepseek-ai/dsh-typert-generator` 的发现逻辑绑定 monorepo 布局——workspace 根必须有 `tsconfig.host.json`，且包必须位于 `<root>/packages/` 下（0.1.6-alpha.2 源码实证，`loadRegistrations` 的 `isWithin(realPath(packageRoot), join(root, 'packages'))` 过滤）；本仓是独立单包仓库，无法被其发现。
- 产物改为手写源码，三重防漂移：① 类型锚定协议包公开类型（`InvocationDescriptor` / `TypertRemoteContribution` / `TypertRemoteNamespaceMap` 合并，typecheck 拦截格式漂移）；② `tests/typert-artifacts.test.ts` 把 TYPERT 注册进真实 `@deepseek-ai/dsh-typert-registry` 并用全部真实快照 round-trip 严格编解码；③ 结构逐项对齐 `dsh-typert-loader` 的 validateTypertManifest 校验。
- `tsc -p tsconfig.build.json` → `dist/`：host 半区 + Typert 产物（`src/typert-common.ts` / `src/typert.host.ts` / `src/typert.remote-client.ts`，产物即源码，随包发布）。
- `tsdown` 只打浏览器半区 `dist/client.js`：CJS + `window.__ModuleLoader__.load` 包装（对齐官方 client 产物形态）；react 外部化（宿主模块加载器提供），zod 与 Typert 共享段内联（官方产物同样内联 zod）。
- `package.json`：exports 增加 `./client` → `dist/client.js`（types 指向 tsc 产的 `dist/client/index.d.ts`）、`./typert` → `dist/typert.host.*`、`./remote` → `dist/typert.remote-client.*`；`dsh.client = { inject: ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-ui-renderer'], platform: 'web' }`。
- 宿主侧零配置：`dsh-typert-loader` 自动发现 `./typert` 并注册；bundle 安装路径不变。

### 5.4 client 面板（client/index.tsx）
- `apply(ctx)`（inject `['slots', 'remote']`）：`ctx.remote.$mount(TYPERT_REMOTE)`（来自本包 `./remote` 产物）。
- **两段式启动（2026-09-20 实证修正）**：cordis 对点分服务键强制 inject 检查——访问 `ctx.remote.piAuthBridge` 会被代理解析为服务键 `remote.piAuthBridge`，未声明即抛 `cannot get property ... without inject`。但命名空间服务由 $mount 异步创建，模块级 inject 声明它会死锁（插件等服务、服务由插件创建）。官方模式（gateway 源码注释）：派生子插件 `ctx.plugin({ inject: ['slots', 'remote.piAuthBridge'], apply })` park 在命名空间服务上，服务出现后子插件启动，再 `ctx.slots.register({ name: 'settings.section', id: 'pi-auth-bridge', order: 100, label: () => 'Pi Auth Bridge' }, Panel)`。$mount 失败时子插件永远 park，必须 warn，禁止静默。
- Panel 内容（React 18，宿主提供 react；呈现层拆在 `client/panel.tsx`，入口 `client/index.tsx` 只做 $mount 与 slot 接线）：① 桥状态徽标（bridged/empty + reason）；② 路由列表——每条路由可展开完整模型子表（模型 id、上下文窗口、输入模态、能力徽章、行内「测试」按钮），区块级「全部测试」串行编排；③ 代理嗅探结果与生效配置回显；④ 插件自健康（版本表 / 启动自检 / 近期请求错误，§5.8）；⑤ 警告列表；⑥ 静态能力说明（桥接哪些协议、配置项、安全边界摘要）。
- 面板只读，不提供任何写操作（本插件无可写面）。

### 5.5 测试
- status.ts：各 phase 的快照组装（bridged 全字段 / 四种 empty reason）、凭据本体不泄漏（快照序列化后不含敏感串）。
- status-service：真实 cordis 组合挂载后 `status()` 返回盒内快照；`typertRemote` 绑定键正确。
- typert-artifacts：TYPERT 注册进真实 registry；结果编解码对全部真实快照 round-trip 无漂移；凭据不越界。
- index：apply 各路径回填状态盒（empty reason / bridged 快照）。
- client：组件三态渲染（loading→ready/failed，jsdom + @testing-library/react）；apply 挂载贡献并注册 settings.section。
- 原有测试不动；`npm run typecheck && npm test && npm run build` 全绿为验收。

### 5.6 影响面
- 纯增量：host 入口导出与 apply 的桥接流程不变，仅回填状态盒；headless 组合（无 web）时 `dsh.client` 声明无副作用，typert 产物不被加载。

### 5.7 能力探测矩阵（模型 × 能力，用户点击触发）
- **动机**：桥的多提供商多模型各自能力不一（文本/图片/推理/工具调用），用时逐个撞坑成本高；且历史故障（09-19 图片 offload 契约、reasoning 档位、tool-call argumentsDelta、usage→finish 协议）都发生在转换层——探测必须走 `adapter.stream()` 的完整管线，不裸调 pi-ai。
- `probe.ts`：`probeModel(adapter, route, model, only?)` 对单模型顺序跑适用维度（`only` 指定时按维度单测），产出 `ModelProbeReport{ route, model, at, ok, latencyMs, outcomes[] }`，每维 `CapabilityProbeOutcome{ capability, verdict: 'ok'|'failed'|'skipped'|'inconclusive', latencyMs, message?, detail? }`：
  - `text`：maxTokens 16 的单词 ping；判定 = 终态 stop/max-tokens 且 usage 先于 finish（协议义务，缺失即协议违约）
  - `image`：仅当 `inputModalities` 含 image（否则 skipped）；固定 1×1 PNG + 内置假 reader 走真实 `toPiContextWithImages` 管线；reader 断言 target 为 `{width, height, maxBytes}` 正整数（09-19 事故回归）
  - `reasoning`：仅当模型支持 reasoning（否则 skipped）；取最低档（优先 low）、maxTokens 1024（思考预算下限）
  - `toolCall`：`probe_echo` 工具 + 强制调用提示；触发 = ok，纯文本应答 = inconclusive（模型可能不支持也可能忽略，不算失败），流内 error = failed
- 超时：常规 45s / 推理 90s；全部探测 `maxRetries: 0`（沿用 stream 默认）；单维失败收敛在 outcome，绝不向上抛；前置错误（未知路由/模型）由 `createProbeHandler` 映射为业务失败（保留 adapter 错误码）。
- **可观测性**：每个 outcome 携带 `detail` 诊断串（终态、usage 是否到达、回复预览、工具调用次数、图片 target 形状、异常类型——区分超时与上游错误）；`createProbeHandler` 同时把「开始 + 每维结果 + 失败」写 host logger（失败走 warn）。出问题不必重跑即可回溯。
- adapter 配合：`stream()` 委托给 `streamWithAttachments(options, attachmentsOverride?)`——探测用覆盖 reader，生产路径零分支差异。
- 服务面：`@Remote('probe') probe(request)`，`ProbeRequest.capability` 可选（缺省全维度，指定则按维度单测）；空挂载返回 `not-bridged` 业务失败。apply 接线 `box.probe`，成功报告经 `recordProbeReport` 缓存进快照（`mergeProbeReport` 按维度合并：单测只覆盖该维度，保留其余维度历史结果；面板重开可见）。
- 面板编排：每模型行内「测试」（全维度）+ 点击能力徽章按维度单测；**不做批量「全部测试」按钮**——全模型×全能力的笛卡尔积批量跑成本高、限流风险大，且 skipped/inconclusive 的合法结果会淹没真信号。能力徽章 4 维固定顺序（文本/图片/推理/工具），✓ ok / ✗ failed / — skipped / ? inconclusive；探测后模型行渲染每维 detail 详情行。

### 5.8 插件自健康（版本表 / 启动自检 / 近期请求错误）
- **动机**：2026-09-19 升级 dsh 0.1.6 后图片 offload 契约变化导致桥整体炸掉，但面板毫无迹象——插件自身的健康也必须可测、可见。
- 版本表：`createRequire` 读本插件与 dsh-llm / dsh-attachment / pi-ai 的 package.json 版本；pi-ai 未导出 `./package.json`，读不到降级为缺省（面板显示「未知」），不视为失败。
- 启动自检（apply 时本地契约检查，无网络）：`dsh-llm-contract`（attributionHeaders 可用）、`dsh-attachment-contract`（requestImageDimensions(100,100,4MiB) 返回正整数宽高——09-19 事故的直接回归）、`attachments-service`（附件服务已挂载，否则带图请求必显式报错）。
- 近期请求错误：adapter 的 `recordError` 钩子把请求期错误（上游失败、图片转换失败）写入状态盒环形缓冲（新→旧，上限 20 条）；调用方中止（ABORTED）与调用契约错误（UNSUPPORTED_OPTION 等）不记录——它们是请求方问题，不是桥的健康信号。
- 以上三项随每次快照回填（含 empty 早退路径），空挂载时面板同样能看到自健康。
