# dsh-pi-auth-bridge (@xnightsky/dsh-pi-auth-bridge) 设计

> 状态：已落地（v0.1.0）
>
> 日期：2026-08-29
>
> 本文是设计真相源；设计变更先改本文，再改代码。

dsh 插件：把本机 pi（pi-mono / Pi coding agent）的认证（`models.json` + `auth.json`）在**内存中**转换为 dsh 的 LLM 路由，即转即用、绝不落地。相当于一座 auth adapter 桥。

项目独立名称统一为 `dsh-pi-auth-bridge`：README 标题、日志前缀、Cordis 插件与 bundle id、测试标识和设计文档文件名均使用该名称，不保留旧名称别名。npm 包名仍为 `@xnightsky/dsh-pi-auth-bridge`；公开的 `piAuthBridge` RPC 命名空间和 `PiAuthBridge*` 类型/导出保持不变。已有 profile 自定义覆盖须使用新的 Cordis id。中英文 README 展示 npm 版本、MIT License 与 Release 工作流状态徽章；在线核对三者均 HTTP 200，分别显示 v0.5.5、MIT 与 passing。npm 下载统计尚未生成，不展示错误徽章。新增命名残留与双语徽章回归，类型检查、178 项测试和构建通过。

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
- **dsh 宿主兼容范围 `0.2.1-rc.4 || 0.2.1-rc.5`**：2026-11-04 用户确认将 dsh peer 从单版本锁定改为已核对版本的并集，三个 dsh peer 使用相同范围。开发测试基线保持 `devDependencies` 0.2.1-rc.5 精确锁定，lockfile 和本地安装仍为 rc.5。rc.4 已有桌面宿主历史验收，且本轮使用的八个契约包在 rc.4 / rc.5 间无接口变化，故不增加运行时双兼容分支。范围不放行 rc.3、rc.6、0.2.1 正式版或 0.2.2，不使用 `^`、`engines.dsh` 或版本豁免；未来版本需重新核对后显式扩大范围。
- **兼容范围边界验证（2026-11-04）**：先以新测试复现两项失败（peer 仍为 rc.5、文档仍声明单版本），更新后三项基线回归全部通过。分别使用 npm 的 semver 默认语义及真实 rc.5 `dsh-app-boot.evaluatePluginCompatibility` 检查三个 peer 和完整清单，均接受 rc.4 / rc.5，拒绝 rc.3 / rc.6 / 0.2.1 正式版 / 0.2.2；不依赖宿主的版本豁免。改动后 `npm ci --ignore-scripts`、类型检查、175 项测试与构建全部通过。此次不重跑 rc.4 桌面或云端端到端验收，沿用下述既有记录与本轮契约一致性核对。注释收口仅区分测试基线与宿主范围，运行时接口不变。
- **rc.5 接口核对（2026-11-04）**：对比 npm rc.4 产物与本机 rc.5 runtime，`dsh-llm`、`dsh-attachment`、`dsh-typert-protocol`、`dsh-typert-registry`、`dsh-api-gateway`、`dsh-client-ui-renderer`、`dsh-client-ui-settings` 的全部 `.d.ts` 和 `.js` 相同且无新增类型文件；`dsh-client-ui-slots` 不在全局 CLI 的该顶层依赖位置，另取 npm rc.5 产物比对，其 `lib/` 与 rc.4 完全相同。因此本轮仅更新精确版本基线，不修改桥接运行时逻辑。增加已安装版本及 lockfile 一致性回归，避免用遗留本地依赖验证新基线。首次测试三项均失败（清单/文档 rc.4、本地依赖 rc.2）；常规原地安装触发旧 rc.4 peer 图的 ERESOLVE，保留无关依赖锁定，仅重新解析 dsh 包后用 `npm ci` 干净安装成功，未使用 `--force` 或 `--legacy-peer-deps`。
- **rc.5 初始精确锁定验证（2026-11-04，历史记录）**：Node v24.14.0 / pi-ai 1.4.0 下，`npm run typecheck`、175 项测试（15 个文件）和 `npm run build` 全部通过，`npm ls --depth=0` 无 invalid。当时单版本清单在 rc.5 `dsh-app-boot.evaluatePluginCompatibility` 中接受 rc.5、拒绝 rc.4 / 0.2.2；当前 peer 已按上文改为 rc.4 / rc.5 范围。构建产物通过真实 rc.5 Cordis / LlmRuntime 和真实 pi-ai、内存模拟的 OpenAI SSE 上游验证：模型发现与元数据、prepareCall 分派、认证与归因头、文本 Pong、usage 先于 finish、释放路由均通过。此验证不是完整 CLI/profile 启动或桌面验收，不覆盖真实云端、图片附件端到端或浏览器点击；未访问真实 pi 凭据，未写用户 pi/dsh 配置，未触发 OAuth 续期。`src/` 运行时和导出接口不变。
- **2026-11-03 基线升级依据（已核实，不重复调研）**：用户桌面版 DSH 为 `0.2.1-rc.4`，Info.plist、`Resources/app/package.json` 与 `app/dsh/desktop-runtime.json` 三处一致；桌面 App 内置 runtime 的 `dsh-llm`、`dsh-attachment`、`dsh-typert-protocol`、`dsh-typert-registry`、`dsh-api-gateway` 均为 `0.2.1-rc.4`，`cordis` 为 4.0.5，`pi-ai` 为 1.3.0。全局 CLI `dsh@0.2.1-rc.3` 不是本次验证宿主；npm `latest` 的 `@deepseek-ai/dsh@0.2.1-rc.5` 也未采用。以 rc.4 的 `dsh-app-boot` 实测，旧 peer 锁定在 rc.2/rc.3/rc.4/rc.5 四档中只被 rc.2 接受；升级到 rc.4 后只有 rc.4 兼容，rc.5 与 0.2.2 会因精确锁再次拒绝。`dsh-llm`、`dsh-attachment`、`dsh-typert-protocol`、`cordis` 在 rc.2 与 rc.4 的导出集合一致（`dsh-llm` 到 rc.5 也一致），本次因此是纯版本对齐与验证，不是功能改造。
- **rc.4 隔离宿主冒烟（2026-11-03，Node v24.21.0）**：以桌面 App 内置 rc.4 CLI 在 `/tmp/dsh-smoke-home` 新建临时 Web profile，`dsh plugin ... add <repo>` 以 link 方式装入并写入 bundle 层。启动无 `skipping profile bundle` / incompatible，日志为 `dsh-pi-auth-bridge: bridged 4 route(s) from ...`。真实 Typert 端点 `piAuthBridge/status` 返回 HTTP 200，`phase=bridged`，三项启动自检全部 `ok`，面板模型清单回填 4/2/42/305；另 2 个未知 provider 按预期 warning 跳过。随后经同一 Typert 端点对 `pi/deepseek` / `deepseek-flash` 发起真实 `text` probe：HTTP 200、921 ms、`finish=stop`、`usage ✓`、回复 `Pong`，状态服务缓存与宿主日志一致且 `recentErrors` 为空。未点浏览器、未覆盖其余能力维度或云端对话。`~/.pi` 的 `auth.json` / `models.json` 测前测后 SHA-256 一致，临时宿主及 `/tmp` 数据已清理；剩余风险仅为未覆盖的 UI 交互、其余模型/能力和后续宿主版本。
- **消息与工具更新契约（0.2.1）**：工具结果由旧的 `user` 消息内嵌 `tool-result` block 改为独立 `role: 'tool'` 消息，调用关联与 `isError` 提升到消息字段；新增 `developer` 消息承载 `tool-addition` / `tool-removal`，`ToolSchema.deferLoading` 控制延迟声明。桥必须保留这些语义并映射为 pi-ai 的 `toolResult` 与带 `toolsAdded` / `toolsRemoved` 的 system update，不得按未知块静默丢弃。开头 system 历史与 `options.system` 合并为 systemPrompt，后续 system/developer 历史按原顺序映射为 pi-ai system 消息。`resolveModel()` 必须从 pi-ai `model.compat` 声明 `systemPromptUpdate` / `toolUpdate`，否则宿主会在调用适配器前剥离 developer 消息；Anthropic 全延迟工具列表必须补官方 `DeferredToolPlaceholder` 占位声明。
- **图片附件支持**：dsh 的 image 块只携带 durable 引用，字节在 dsh-attachment 服务里。流程：`collectImageRefs` 跳过 `offloaded: true` 的块 → `readImageRequest(ref, target, signal)` 生成请求版本，**target 必须按 ref 各自尺寸用 `requestImageDimensions(ref.width, ref.height, maxPixels)` 换算出 `{width, height, maxBytes}`**（默认预算 2048×2048 像素 / 1 MiB，与官方一致）→ 内联为 pi-ai 的 `{ type:'image', data: base64, mimeType }` 块并配 `requestImageHandleText` 句柄文本 → 以真实版本字节经 `requiredImageOffload`（20 MiB base64 请求级预算）计量，超预算抛 `LlmError(..., IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages })` 由宿主标记卸载后重试 → `projectOffloadedImages` 投影占位。0.2.1 新增 `LlmAdapter.imageRequestTarget()`，桥必须返回与序列化完全相同的 target，供宿主截图坐标等能力使用。pi-ai 只能回放 user/tool 角色图片，其他角色带图抛 `UNSUPPORTED_CONTENT`；模型不支持图片或附件服务缺失时同样显式抛错。**桥直接依赖 `@deepseek-ai/dsh-attachment` 的真实契约类型**。
- **事故记录 2026-09-19**（宿主 dsh@0.1.6-alpha.2，会话导出 `dsh-session-session-3bcab0a6`）：宿主升级到 0.1.6 线后，桥仍按旧契约向 `readImageRequest` 传 `{maxPixels, maxBytes}`，`validateTarget` 抛 `Image request width must be a positive integer.`，凡带截图（CUA 工具）的请求全部失败。教训：与宿主服务的跨边界调用必须复用契约包的真实类型，禁止自造结构子集。
- **历史校验顺序（2026-10-26 对照复现）**：v0.5.2 已支持 DSH 0.2.1 的独立工具结果、图片 target、原生 system 与工具更新；真实宿主 `0.2.1-rc.2` 的兼容检查、附件服务和 pi-ai 本地回环请求均通过。残留缺陷是图片转换先合并开头 system 再校验，导致其中图片或错位工具更新被静默丢弃；system 内 reasoning 等非文本块也会被文本提取忽略。两个转换入口必须先校验完整历史，system 只允许纯文本，非法块统一抛 `UNSUPPORTED_CONTENT`，并在失败前不读取附件。保留 v0.5.2 的 system 角色、工具更新、延迟声明和精确 peer 锁定。
- **历史校验验证（2026-10-26，Node v24.14.0）**：新增 `tests/request-history.test.ts` 的 7 项回归（原版 4 失败、修复后全部通过）；修复后类型检查、155 项测试和构建通过。额外隔离对照的 12 项检查使用宿主真实兼容检查、LLM runtime、附件存储及 pi-ai，配合本地 HTTP 上游，验证 user/tool 图片往返及 system 指令角色；修复后保留 system 语义。
- **真实 CLI / 云端验收（2026-10-26）**：使用安装的 `dsh@0.2.1-rc.2` CLI 启动独立临时 Web profile，按正式包名与 bundle 加载当前构建（main `af48fa4` + 历史校验修复），只读本机 pi 配置，使用真实 `openai-completions` 图片模型。Loader/Typert 清单发现、三项启动自检、云端文本回复、真实附件存储后的 user 图片与独立 tool 结果图片均通过（两次图片回答均为 `red`）；非法开头 system 图片经宿主返回 `finish {kind:'error'}`，错误码为 `UNSUPPORTED_CONTENT`。通过宿主 Typert Gateway 调用面板探测，text/image/toolCall/reasoning 四维均为 `ok`，usage 先于 finish，缓存回读与浏览器插件资源注册通过。测试宿主已退出，pi 的 `auth.json` / `models.json` 测前测后 SHA-256 一致，未修改用户 dsh 配置。尚未覆盖浏览器实际点击、其余 provider/协议和其他 dsh 版本，剩余集成风险限定于这些范围。
- pi-ai 库：`@earendil-works/pi-ai`@^1.5.0，lockfile 与本地安装均为 1.5.0，以获得 Kimi K3.1 目录；保留 `createModels`、`Models.streamSimple()`、`AuthContext`、`CredentialStore` 等公开接口（以安装后的 .d.ts 为准）。
- **Kimi K3.1 目录差异（本机只读核实）**：插件原锁定 pi-ai 1.4.0，`kimi-coding` 目录仅有 `k3`、`k3-256k`、`kimi-for-coding`、`kimi-for-coding-highspeed`；全局 pi CLI 的 pi-ai 1.5.0 另有 `k3.1-pro` 与 `k3.1-pro-highspeed`，且本机 `models.json` 无 Kimi 覆盖。桥复用认证文件，但内置目录来自插件自己的依赖，不读取 CLI 列表；升级全局 pi 不会同步插件目录。回归须使用真实 SDK 经适配器 `listModels` / `resolveModel` 与面板清单回填验证两个 K3.1，不手写补充模型、不变更认证或宿主 peer 范围；部署时需更新插件依赖并重启 dsh，进入目录不代表已授权或真实调用成功。
- **pi-ai 1.5.0 升级验证**：`tests/kimi-catalog.test.ts` 的 3 项真实 SDK 回归在 1.4.0 下全部失败，升级后全部通过；类型检查、19 个文件的 205 项测试、构建与 `npm ls --depth=0` 全部通过，覆盖既有 OAuth、代理隔离及消息转换回归。构建产物另以合成路由验证 Kimi 6 模型清单、两个 K3.1 的元数据与面板回填、无 warning 与凭据不泄露。用户随后确认模型显示修复有效；此反馈不替代真实 K3.1 云端调用或完整 UI 验收。运行时代码、宿主 peer、undici 7.x 不变，代理未修改用户配置。注释范围仅新增离线回归测试的模块说明。
- **新版 OpenAI OAuth（2026-10-28，本地 pi-ai 1.4.0 契约与合成凭据复现）**：支持目标为 `openai` 的 Sign in with ChatGPT / Responses API，不新增旧 `openai-codex` 专用兼容。该流程的续期依赖凭据中的 `clientId`，并返回 `scopes` 等扩展字段；桥只校验通用字段，扩展元数据仅在 host 内存透传，交 SDK 校验和消费。原实现会丢失元数据，且把启动时有效的 OAuth 降成静态 key，导致后续无法续期。
- **目录身份与 OAuth 网络边界**：pi-ai 的 OpenAI API 实现根据原始 `model.provider === 'openai'` 识别 ChatGPT OAuth 并省略不支持的请求字段。集合注册、模型查询和凭据索引仍用 `pi/openai`，仅在调用目录 provider 的流方法前恢复目录身份。SDK 的 OAuth 刷新直接调用全局 `fetch`，不消费模型请求的 `SimpleStreamOptions.fetch`；桥不修改全局 fetch/dispatcher，不重写刷新协议。受限网络下，宿主需以 `NODE_USE_ENV_PROXY=1`（Node ≥ 24.5）及 HTTP(S) 代理变量启动。
- **新版 OpenAI OAuth 修复验证（2026-10-28，Node v24.14.0 / pi-ai 1.4.0）**：先复现定向回归 13 失败，再补充显式 Responses 协议覆盖的失败回归。修复后全量类型检查、170 项测试及构建通过；新增 15 项测试，无真实凭据或云端调用。构建产物另以合成凭据验证一次刷新后连续两次 Responses 请求成功；刷新 1 次、模型请求 2 次。真实 ChatGPT 账号、宿主 Web UI 和 OAuth 原生代理联网尚未验收。
- **真实 OAuth 续期的 dispatcher 冲突（2026-10-28）**：当前构建使用真实 `openai` OAuth，在 `gpt-6-sol` 连续两次返回 HTTP 200 / `OK`，参数裁剪与只读断言通过。显式启动 Node 原生代理后，真实续期却返回 403 `unsupported_country_region_territory`；无凭据对照中，同一进程原生 fetch 为 403、请求级代理 fetch 为 400 `invalid_request`。独立进程证实，导入 undici 8 会将 `undici.globalDispatcher.1` 从 Node 的 `EnvHttpProxyAgent` 替换成其 v2 默认 Agent 包装器。方案：将本库 undici 限制在 7.x（与 Node 内置 dispatcher 及 OpenAI SDK 的 `>=5 <9` peer 范围兼容），避免 v2 导入初始化覆盖宿主设置；补隔离子进程回归，不用手动恢复全局 dispatcher 的补丁。宿主其他依赖若主动加载并重置 dispatcher，仍属于外部边界。
- **新版 OpenAI OAuth 真实验收通过（2026-10-28，Node v24.14.0 / pi-ai 1.4.0 / undici 7.30.1）**：使用当前构建产物、真实 pi `openai` 登录态和 OpenAI 云端，验证进程显式配置代理并启动 Node 原生环境代理；本机代理地址未写入仓库。仅将内存副本的 `expires` 置零，SDK 真实续期 HTTP 200，issued `clientId` 匹配、access 与 refresh 均发生轮换，返回有效期 3600 秒及 direct scope。随后 `pi/openai` / `gpt-6-sol` 连续两次 HTTP 200，均返回 `OK`、usage 与正常 finish；模型请求确实使用刚签发的 access，去除 ChatGPT 不支持字段，第二次无重复刷新，禁用环境 API key。两次请求分别约 8.5 秒（含刷新）和 3.0 秒，原始 `auth.json` / `models.json` 测前测后 SHA-256 一致，token 未落盘。新增隔离回归在 undici 8 下 2 失败、7 下转绿；全量类型检查、172 项测试及构建通过。刷新由用户明确授权；验证进程已退出，新 refresh 未持久化，pi 原文件的旧 refresh 可能失效，必要时重新登录。未部署到用户 dsh profile，未覆盖本轮宿主 Web UI、其他 provider 或宿主第三方依赖重置 dispatcher 的情形。
- **代理嗅探的责任在宿主进程，不在 pi-ai**（2026-09-11 实证）：pi-ai 所有线路直接用 `globalThis.fetch`，全包无 `setGlobalDispatcher`/`ProxyAgent`；Node 全局 fetch 默认不读 `http_proxy` 等变量（`NODE_USE_ENV_PROXY`/`--use-env-proxy` 自 Node 24.5 起存在但默认关闭）；dsh 宿主同样无代理处理。pi 本体能走代理，是因为 pi CLI 启动时 `configureHttpDispatcher()` 用 npm 包 `undici` 的 `EnvHttpProxyAgent({ allowH2: false, proxyTunnel: true, ... })` + `setGlobalDispatcher` + 重装 `globalThis.fetch` 做了进程级补丁。因此桥必须自己补这一环（见 §2.6）。
- pi-ai 的 `SimpleStreamOptions.fetch`（`FetchFunction = typeof globalThis.fetch`）是自定义 fetch 的注入点，会透传到各线路 adapter；但 `google-generative-ai` 与 `google-vertex` 两条线路的 adapter 显式抛错拒绝自定义 fetch（其请求由 `@google/genai` 内部发出）。
- dsh web 模型选择器的展示结构（2026-08-29 核实全局安装产物）：只有两级「分组 → 模型」。分组 key = provider 路由 id **原样**（不按 `/` 或任何分隔符切分），分组标题 = `LlmProviderInfo.name`；路由 id 仅校验非空，`/` 合法。因此 PI 无法成为真正的三级「渠道」，出处只能编码进路由 id 前缀与分组标题（见 §2.3）。
- 插件安装机制（2026-08-29 核实 `@deepseek-ai/dsh`@0.1.1-rc.2 全局产物 `lib/plugin-9h8shc4d.js`）：`dsh plugin --profile <name> <args...>` 是 pnpm 转发器，在 profile 目录执行 `pnpm <args...>`，因此 registry 包名 / git URL / tarball / 本地路径均可安装。安装后按真实包名 reconcile：声明了 `dsh.bundle.patch` 的依赖自动加入 `dsh.profile.bundles` 层栈，git/path/tarball 安装与 registry 安装行为一致。git 安装的包靠 `prepare` 脚本在安装时构建，pnpm 默认拦截依赖构建脚本，需把对应 key 加入 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后重跑（dsh 失败时会打印该提示）。pnpm 11 实测两轮拦截：插件 prepare 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；pi-ai 传递依赖 `@google/genai`/`protobufjs` 的构建脚本报 `ERR_PNPM_IGNORED_BUILDS`，pnpm 会把占位条目写入 `allowBuilds`，改为 `true` 重跑即可（2026-08-29 在 profile `pab-e2e` 端到端验证：git tag 安装成功、`dist/` 由 prepare 构建、bundle 自动入栈）。

### dsh 插件面板机制（2026-09-20 实证宿主 dsh@0.1.6-alpha.2 全局产物 + 官方文档）
- **双面（dual-face）插件形态**：单包可同时有 host 半区与 client（浏览器）半区。声明 = `package.json` 的 `exports["./client"]` + `dsh.client: { inject: [<包名>...], platform: "web" }`；host 扫描 Loader 条目自动组 `window.__DSH_BOOT__` 并经 `/plugins/<id>/client.js` 供浏览器加载，client 半区是 CJS 懒加载模块表（首次 require 才执行副作用）。社区参考实现：`dsh-live-stats`（tsc 产类型 + tsdown 打 client）。
- **UI 挂载点 = slot 系统**：client 半区 `ctx.slots.register({ name: 'settings.section', id, order, label }, Component)` 即在 Settings 面板挂出本插件区块（实证 `dsh-client-ui-settings-general` 用 `renderSlot('settings.section', …)` 渲染、`dsh-client-ui-settings-plugins` 以此注册）。slot 注册不需改 dsh 源码。0.1.5 起另有右侧边栏 tab（`ctx.sidebarRight`），本插件不用。
- **host→浏览器数据通道 = Typert Remote**：作者侧五步（实证官方文档 `learn/dev/typert-authoring` + 第一方参考 `dsh-message-feedback`）：① 导出服务类继承 `TypertRemoteService`（`@deepseek-ai/dsh-typert-protocol`，本地 0.1.6-alpha.2 已核实导出）并以 `@Remote('name')` 标注方法（TC39 标准装饰器签名，**不是** legacy experimentalDecorators）；② 构建期 `@deepseek-ai/dsh-typert-generator` 的 tsdown 插件 `typertPlugin({mode:'workspace',faces:['host']})` 产 `typert.host.{js,d.ts}` + `typert.remote-client.{js,d.ts}`（生成产物 import `zod`）；③ `package.json` exports 暴露 `./typert` 与 `./remote` 并列入 `files`；④ 宿主内置 `dsh-typert-loader` 自动发现 Loader 条目的 `./typert` 导出并注册进 `ctx.typert`（实证其 lib/index.js 模块头注释）；⑤ client 半区 `ctx.remote.$mount(TYPERT_REMOTE)`（`ctx.remote` 由 `@deepseek-ai/dsh-api-gateway` 的 client 半区提供，实证 `dsh-api-remotes/lib/client.js` 即以此挂载 14 个第一方 contribution）获得类型化调用代理。
- `@Remote` 方法的参数/返回值经 zod schema 过边界：只支持可投影类型（字面量/数组/union/interface/Record 等），函数、Map/Set、泛型根会直接分析失败；public 实例方法才可暴露。
- **rc.5 子智能体模型接入（2026-11-04）**：官方子智能体页从 `remote.session.modelCatalog()` 获取全部可用模型候选，不按已有授权过滤；`list_subagent_models` 才按当前 Session 保存的精确 provider/model 授权过滤。模型选择设置只影响新会话，已有会话的策略不变。本轮真实 Web 只读对比：桥面板与官方目录均为 78 个 PI 模型，逐项缺失/多余及目录失败均为 0；官方页面 DOM 为 80 行（78 PI + 2 原生），列表可视高度 300、内容高度 4546，需在框内滚动。未修改授权，未调用模型。
- **rc.5 公开插件导航**：`pluginNavigation` 仅公开 `openList()` 与 `openBundle(packageName)`，没有直达官方 Subagent 子页的方法。本插件使用 `openList()` 打开插件首页，文案明确后续路径为「插件 → 子智能体 → 模型选择」，不伪造 URL、不访问私有导航 store；本轮不迁移现有 `settings.section` 面板。
- **Settings 弹层退出契约**：`SettingsSectionOwnerProps.close()` 由 Settings shell 作为 `settings.section` 的 owner prop 提供；`pluginNavigation.openList()` 只切换底层主面板，不会关闭 Settings 弹层。导航成功后必须调用 `close()`，否则插件首页仍被遮挡；导航失败不关闭弹层，保留错误和手动路径。

## 1. 项目形态

- 独立 npm 包 `@xnightsky/dsh-pi-auth-bridge`，ESM，TypeScript；**双面（dual-face）插件**：host 半区（cordis 插件）+ client 半区（Settings 面板区块，见 §5）。
- dependencies: `@earendil-works/pi-ai`, `@deepseek-ai/schemastery`, `undici`（§2.5 代理 fetch；对齐 pi CLI 同款）, `@deepseek-ai/dsh-typert-protocol`（§5 状态服务基类与 `@Remote` 装饰器）, `zod`（§5 生成的 remote-client 产物 import `zod`）
- peerDependencies: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-attachment` / `@deepseek-ai/dsh-typert-protocol`（均为 `0.2.1-rc.4 || 0.2.1-rc.5`）, `react`（client 半区组件，宿主 web 提供）
- devDependencies: `typescript`, `vitest`, `@types/node`, `tsdown`（§5 client 打包）, `react`/`react-dom`/`@types/react`/`@types/react-dom` + `@testing-library/react` + `jsdom`（client 测试）, `@deepseek-ai/dsh-typert-registry`（产物回归测试）, `@deepseek-ai/dsh-api-gateway` / `@deepseek-ai/dsh-client-ui-renderer` / `@deepseek-ai/dsh-client-ui-settings`（client 半区类型合并来源）
- 构建：`tsc` → `dist/`（ESM + .d.ts，含手写 Typert 产物）；`tsdown` → `dist/client.js`（CJS 懒加载模块表，zod 内联）。同时支持 dsh 直接按绝对路径加载 `src/index.ts`。
- 遵循 dsh 插件（bundle）官方规范：入口导出 `name` / `inject: ['llm']` / `Config` / `apply`；`package.json` 声明 `dsh.bundle.patch` → 根目录 `cordis.patch.yml`（默认零配置 `insert`，id 为 `dsh-pi-auth-bridge`）；`cordis.patch.yml` 列入 `files` 随包发布。client 半区声明 `exports["./client"]` + `dsh.client.inject = ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-ui-renderer']`；Typert 产物声明 `exports["./typert"]` / `exports["./remote"]`。
- 分发与版本：npm registry（`@xnightsky/dsh-pi-auth-bridge`，public，push `v*` tag 的流水线自动 `npm publish`）+ git 直装（`prepare: npm run build` 在安装时构建 `dist/`）+ GitHub Release（同一流水线生成 Release notes 并附 `npm pack` 产物）；`npm version` 手动发版，真相源 = `package.json` + `v*` tag；tag 与 package version 不一致时流水线失败。

## 2. 模块划分

```
src/
  pi/               # pi 侧读取（无内部依赖）
    locator.ts      # 跨平台定位 pi 配置目录
    auth.ts         # auth.json / models.json 类型 + 容错解析 + 取值解析（literal/$ENV/!cmd）
  bridge/           # 桥核心：dsh ↔ pi-ai 的转换与适配（依赖 pi/）
    convert.ts      # pi → 路由定义转换（纯函数，可单测）
    provider.ts     # 由 RouteDef 构建 pi-ai Provider/Models（目录复用或 models.json 物化）
    proxy.ts        # 代理环境变量嗅探 + 注入式代理 fetch（EnvHttpProxyAgent）
    request.ts      # dsh GenerateOptions → pi-ai Context 的请求转换
    stream.ts       # pi-ai 事件流 → dsh StreamChunk 的翻译（usage→finish）
    adapter.ts      # PiAuthBridgeAdapter implements LlmAdapter（组合以上四者）
  panel/            # 面板 host 数据面（§5，依赖 bridge/ 与 pi/）
    status.ts       # 桥状态模型与收集（纯函数，可单测）
    status-service.ts # TypertRemoteService 子类，@Remote('status'/'probe') 暴露
    probe.ts        # 能力探测矩阵（模型×能力，走本桥完整管线，§5.7）
    self-health.ts  # 插件自健康：版本表 + 启动自检（§5.8）
    model-list.ts   # 模型清单异步填充（本地目录读取）
  typert/           # Typert 手写产物（§5.3）
    common.ts       # 共享段：zod 投影 + status/probe 调用描述符
    host.ts         # Host 面 TYPERT 清单
    remote-client.ts # Host-for-Client Remote 投影（含命名空间类型合并）
  client/           # 浏览器半区
    index.tsx       # 入口：$mount + settings.section 接线
    panel.tsx       # Settings 区块呈现层
  index.ts          # cordis 插件入口（纯组合根）
tests/            # vitest
README.md         # 中文为主，附 English 摘要
```

### 2.1 pi/locator.ts
- `locatePiDir(opts: { piDir?: string; env?: NodeJS.ProcessEnv; homedir?: () => string }): string | undefined`
- 优先级：显式 `piDir` > `env.PI_CODING_AGENT_DIR` > `homedir()/.pi/agent`
- 存在性校验（`auth.json`/`models.json` 至少其一存在才算有效），返回 `undefined` 表示未找到
- 纯函数注入 env/homedir，便于 Windows/Linux 双平台单测（用 win32 风格路径样本测拼接逻辑）

### 2.2 pi/auth.ts
- 类型：`PiAuthEntry` 的 OAuth 分支复用 SDK 公共凭据字段，允许缺省 `refresh` / `expires`，并保留 provider 扩展元数据（如新版 OpenAI 的 `clientId` / `scopes`）。非法通用可选字段不透传；扩展字段由 provider 自身验证，绝不进入面板。
- `readPiAuth(dir)`, `readPiModels(dir)`：文件不存在 → `undefined`；JSON 损坏 → 抛带路径信息的 `PiAuthBridgeError`；条目形态非法 → 跳过该条并 warn（不整体失败）
- `resolvePiValue(raw, {env, execCmd}): string | undefined`：实现 `$ENV` / `!cmd` / 字面量三态；`!cmd` 带超时（默认 10s）与内存缓存；失败返回 `undefined` 并 warn

### 2.3 bridge/convert.ts
- `buildRoutes(auth, models, opts): RouteDef[]`
- 对每个 `auth.json` 里有凭据的 provider：生成路由（provider 元数据交给 pi-ai 内置目录）
- 对每个 `models.json` 自定义 provider：生成路由 `{ api, baseURL, models, headers, authHeader }`，apiKey 解析顺序 = auth.json 同名片 > models.json `apiKey` 字段
- `oauth` 条目：有非空 `refresh` → 无论启动时是否过期，始终保留 OAuth 及扩展元数据，交 pi-ai 的内存 CredentialStore；缺省 `expires` 按 0 交 SDK 刷新。仅无 refresh 且尚有效（或无 expires）的 access-only 条目保留静态 key 行为，不能自动续期；已过期且无 refresh 则跳过并 warn。
- `auth.json` 中选中的 OAuth 不允许再被 `models.json.apiKey` 覆盖；目录无 OAuth handler 的可刷新条目构建期跳过并 warn，不能注册后偷偷回退环境 key。
- `opts.providers?: string[]` 白名单过滤；路由名**固定** `pi/<providerId>` 前缀（`PI_ROUTE_PREFIX`，不可配——避免与 dsh 原生及其他适配器路由撞名）；`displayName` 恒为 `Pi · <名称>`（custom 用其 `name`，builtin 用 provider id）——dsh web 选择器没有三级「渠道」结构，PI 出处只能由路由 id 前缀与分组标题共同表达（见 §0 末条）

### 2.4 bridge/adapter.ts（组合 provider.ts / request.ts / stream.ts）
- `class PiAuthBridgeAdapter extends LlmAdapter`：构造时接收冻结的 `RouteDef[]` 与 pi-ai `Models` 集合（`createModels` 构建，凭据经内存 CredentialStore/AuthContext 注入，或在每次 stream 调用以 `apiKey` override 传入——以 pi-ai 实际 API 为准，参照 llm-pi-ai 的做法）
- 遵守第 0 节全部协议义务；图片附件经构造选项 `resolveAttachments`（index.ts 接线 `ctx.get('attachments')`）支持：模型声明 image 输入时按 §0「图片附件支持」转换；模型不支持或服务缺失 → 抛 `UNSUPPORTED_CONTENT`
- 凭据只存在于内存：不写 dsh 凭据存储、不写任何文件、不调用 `ctx.credentials.set`
- **attribution 头是 dsh-llm 的强制协议义务**（`attributionHeaders()`，可替换不可抑制）：每次请求合并进 headers；`models.json` 自定义头与之同名（大小写不敏感）时让位，并在构建期 warn，不静默丢弃
- `models.json` 的 `authHeader: true` 接通：该路由的 apiKey 以 `Authorization: Bearer <key>` 头发送（pi-ai 无 authHeader 概念，由桥自身注入），不再走 pi-ai 的 apiKey override
- `options.sessionId` 透传给 pi-ai（`SimpleStreamOptions.sessionId`，用于会话亲和）
- 开头 system 历史与 `options.system` 合并为 systemPrompt；后续 system/developer 历史映射为 pi-ai system 消息，`tool` 角色映射为 toolResult；`resolveModel()` 按模型 compat 声明会话内 system/tool 更新能力
- 目录 provider 的模型在 Models 集合中保持 `pi/<id>` 身份，完成认证解析后，仅在目录 `stream` / `streamSimple` 调用边界恢复原始 provider id，保留 SDK 的 OpenAI ChatGPT 参数裁剪等专用逻辑。已知目录 provider 显式覆盖 `api` 时，同样在协议流边界恢复目录身份；自定义非目录 provider 不改名。
- OAuth 凭据完整播种到 SDK 的 InMemoryCredentialStore；第一次流请求必须等待播种完成，播种失败显式报告，不允许读到空存储而回退环境认证。刷新与进程内并发锁完全复用 SDK；无 OAuth handler 的可刷新路由跳过并 warn。
- 新 token 和轮换后的 refresh 仅留当前进程内存，不回写、不监视 pi 文件。进程重启会重读 pi 原文件；与 pi 或其他 dsh 进程并行刷新、以及重启后的旧 refresh 失效风险由只读边界决定，不承诺跨进程协调。
- 代理注入：构造选项 `proxyFetch?: FetchFunction`（由 index.ts 按 §2.5 嗅探构造）；`stream()` 时除 `google-generative-ai`/`google-vertex`（pi-ai 拒绝自定义 fetch）外注入为 `SimpleStreamOptions.fetch`；google 路由每路由 warn 一次提示用 `NODE_USE_ENV_PROXY=1` 兜底

### 2.5 bridge/proxy.ts（代理环境变量嗅探与注入式代理 fetch）
- 问题：dsh 进程不做 pi CLI 的 `configureHttpDispatcher()` 全局补丁，pi-ai 也不读代理变量，桥接出的请求会裸连（见 §0 末两条）。桥必须在**不触碰全局状态**的前提下补上这一环。
- `hasProxyEnv(env = process.env): boolean`：是否配置了代理。认 `http_proxy`/`https_proxy`/`all_proxy` 及其大写形式；空串视为未设置；仅设 `no_proxy` 不算配置代理。
- `createEnvProxyFetch(env = process.env): FetchFunction | undefined`：无代理变量 → `undefined`（不注入，行为与之前一致）；否则用 `undici` 的 `EnvHttpProxyAgent` 构造一个带 dispatcher 的 fetch 返回。dispatcher 参数对齐 pi CLI：`allowH2: false, proxyTunnel: true`；代理地址与 `no_proxy` 从传入 env 显式映射（`all_proxy` 作 http/https 的兜底），未显式给出的项由 undici 回落 `process.env`（生产路径传入的即 `process.env`，语义一致）。
- 与 pi CLI 的关键区别：**绝不** `setGlobalDispatcher` / 重装 `globalThis.fetch`——桥是 dsh 进程内的插件，动全局状态会影响宿主与其他适配器；代理 fetch 只经 `SimpleStreamOptions.fetch` 注入到本桥自己的请求。
- 开关：`Config.proxy?: boolean`，默认 `true`（自动嗅探）。默认开的理由：插件卖点是零配置即转即用，环境变量已设好就期望被尊重；未设代理变量时嗅探为空、注入不发生，开关自闭合。`proxy: false` 用于「环境变量是给别的工具的，LLM 流量必须直连」的场景（内网镜像、本地端点、代理坏 SSE 等）。不做「显式代理 URL」配置面——环境变量本身就是那个配置面（YAGNI）。
- google 线路例外：`google-generative-ai`/`google-vertex` 的 pi-ai adapter 拒绝自定义 fetch，adapter 在 `stream()` 时按 `model.api` 跳过注入并对每路由 warn 一次；这两条线路的代理需求由方案 B 兜底。
- 方案 B（零代码兜底，写进 README）：以 `NODE_USE_ENV_PROXY=1`（Node ≥ 24.5）启动 dsh，让 Node 内建 fetch 自己读代理变量——覆盖 google 线路，也是不想依赖 undici 场景的全局备选。
- OAuth 刷新同样依赖宿主的全局 fetch 可达性，不受插件 `proxy` 开关或请求级代理 fetch 控制。`NODE_USE_ENV_PROXY=1` 必须在进程启动时设置；仅设 `all_proxy` 不足以保证 Node 原生代理生效，应配置 `HTTP_PROXY` / `HTTPS_PROXY`（或对应小写变量）。

### 2.6 index.ts
```ts
export const name = 'dsh-pi-auth-bridge'
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
- proxy-isolation：隔离 Node 子进程预置宿主 dispatcher，分别仅导入代理模块与构造代理 fetch，验证宿主 dispatcher 及全局 fetch 身份均不变；不读取登录态、不发网络请求。
- openai-oauth：用合成 auth.json fixture、真实 pi-ai 与拦截的 OAuth / Responses fetch 验证元数据全链路、首次请求、运行中续期、轮换令牌复用、进程内并发、刷新失败不回退、ChatGPT 专用字段裁剪与 API key 路径不变；同时断言文件内容不变、状态快照不含凭据及元数据。不访问真实 pi 或云端。
- 全部 `npm test`（或 `npx vitest run`）必须通过

## 4. README 要点（已落实）
- 安装与 cordis.yml 配置示例（绝对路径 insert 两种：src/index.ts 与 dist/index.js）
- 与官方 `@deepseek-ai/dsh-llm-pi-ai` 的区别（那个面向 harness 自有凭据/登录体系；本插件零配置复用 pi 已有登录态，不落地）
- 安全说明：只读 pi 文件，凭据全程内存；仅用户显式保存的子智能体授权可经宿主官方设置接口持久化（§5.10），不直接写配置文件、不改其他宿主设置
- Windows + Linux 支持说明（路径、PI_CODING_AGENT_DIR）
- 代理说明：默认嗅探 `http_proxy`/`https_proxy`/`all_proxy`/`no_proxy` 并注入代理 fetch；`proxy: false` 关闭；google 线路需 `NODE_USE_ENV_PROXY=1` 启动 dsh 兜底（§2.5 方案 B）

## 5. 插件面板（dual-face + Typert Remote）

> 目标：在 dsh web 的 Settings 面板挂出本插件区块，展示桥的真实运行状态与能力说明。机制事实见 §0「dsh 插件面板机制」。

### 5.1 状态模型（status.ts，纯数据 + 纯函数）
- `BridgeStatus` 是面板的唯一数据契约，也是 `@Remote` 的返回类型，必须只含 Typert 可投影类型：
  - `phase`: `'bridged' | 'empty'` —— 桥接成功 / 空挂载（empty 时带 `reason` 说明：pi 目录未找到 / 配置不可读 / 无可用凭据 / 路由全部不可服务 / llm 服务缺失）
  - `piDir?`: 实际使用的 pi 配置目录
  - `routes`: `{ id, provider, kind, api?, credential: 'api_key' | 'oauth' | 'none', models, modelList? }[]`；`modelList` 为完整模型清单（`{ id, name?, contextWindow?, input[] }`，注册后由 `model-list.ts` 经 `listModels`/`resolveModel` 本地目录异步填充，无网络）
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
- `tsc -p tsconfig.build.json` → `dist/`：host 半区 + Typert 产物（`src/typert/common.ts` / `src/typert/host.ts` / `src/typert/remote-client.ts`，产物即源码，随包发布）。
- `tsdown` 只打浏览器半区 `dist/client.js`：CJS + `window.__ModuleLoader__.load` 包装（对齐官方 client 产物形态）；react 外部化（宿主模块加载器提供），zod 与 Typert 共享段内联（官方产物同样内联 zod）。
- `package.json`：exports 增加 `./client` → `dist/client.js`（types 指向 tsc 产的 `dist/client/index.d.ts`）、`./typert` → `dist/typert/host.*`、`./remote` → `dist/typert/remote-client.*`；`dsh.client = { inject: ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-ui-renderer'], platform: 'web' }`。
- 宿主侧零配置：`dsh-typert-loader` 自动发现 `./typert` 并注册；bundle 安装路径不变。

### 5.4 client 面板（client/index.tsx）
- `apply(ctx)`（inject `['slots', 'remote']`）：`ctx.remote.$mount(TYPERT_REMOTE)`（来自本包 `./remote` 产物）。
- **两段式启动（2026-09-20 实证修正）**：cordis 对点分服务键强制 inject 检查——访问 `ctx.remote.piAuthBridge` 会被代理解析为服务键 `remote.piAuthBridge`，未声明即抛 `cannot get property ... without inject`。但命名空间服务由 $mount 异步创建，模块级 inject 声明它会死锁（插件等服务、服务由插件创建）。官方模式（gateway 源码注释）：派生子插件 `ctx.plugin({ inject: ['slots', 'remote.piAuthBridge'], apply })` park 在命名空间服务上，服务出现后子插件启动，再 `ctx.slots.register({ name: 'settings.section', id: 'dsh-pi-auth-bridge', order: 100, label: () => 'Pi Auth Bridge' }, Panel)`。$mount 失败时子插件永远 park，必须 warn，禁止静默。
- Panel 内容（React 18，宿主提供 react；呈现层拆在 `client/panel.tsx`，入口 `client/index.tsx` 只做 $mount 与 slot 接线）：① 桥状态徽标（bridged/empty + reason）；② 路由列表——每条路由可展开完整模型子表（模型 id、上下文窗口、输入模态、能力徽章、行内「测试」按钮），区块级「全部测试」串行编排；③ 代理嗅探结果与生效配置回显；④ 插件自健康（版本表 / 启动自检 / 近期请求错误，§5.8）；⑤ 警告列表；⑥ 静态能力说明（桥接哪些协议、配置项、安全边界摘要）。
- 凭据与诊断只读；唯一写入面是用户显式保存的原生子智能体授权（§5.10），不新增 host RPC。

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
- 实现位置：`self-health.ts`（`collectVersions` / `runSelfChecks`，组合根 index.ts 只调用不实现）。
- 版本表：`createRequire` 读本插件与 dsh-llm / dsh-attachment / pi-ai 的 package.json 版本；pi-ai 未导出 `./package.json`，读不到降级为缺省（面板显示「未知」），不视为失败。
- 启动自检（apply 时本地契约检查，无网络）：`dsh-llm-contract`（attributionHeaders 可用）、`dsh-attachment-contract`（requestImageDimensions(100,100,4MiB) 返回正整数宽高——09-19 事故的直接回归）、`attachments-service`（附件服务已挂载，否则带图请求必显式报错）。
- 近期请求错误：adapter 的 `recordError` 钩子把请求期错误（上游失败、图片转换失败）写入状态盒环形缓冲（新→旧，上限 20 条）；调用方中止（ABORTED）与调用契约错误（UNSUPPORTED_OPTION 等）不记录——它们是请求方问题，不是桥的健康信号。
- 以上三项随每次快照回填（含 empty 早退路径），空挂载时面板同样能看到自健康。

### 5.9 子智能体模型选择引导
- 在当前 Bridge 面板加入独立引导区：说明 PI 模型已进入共享目录，但子智能体自主选模仍需用户授权；提示开启「允许 Agent 为子智能体选择模型」、勾选模型、保存并新建会话，模型清单可在框内滚动。
- 「打开插件」仅在点击时通过 `ctx.get('pluginNavigation')` 查询当前服务并调用其公开 `openList()`；不把导航服务设为面板的必需依赖，缺失或旧宿主不支持此方法时显式提示用户从侧边栏打开插件，不影响桥状态、模型清单与能力探测。类型通过官方插件管理器的 client 声明校验，仅增加精确 rc.5 开发依赖，不增加运行时加载依赖。
- 导航自身不勾选或保存授权、不发起模型调用；内联授权操作见 §5.10。不新增 host RPC 或修改 `BridgeStatus`，不改变当前 Session。
- 回归覆盖操作文案、按钮回调、导航缺失/抛错、延迟服务查询与既有 Remote 解包行为；类型检查、全量测试、构建及浏览器只读导航验证通过后交付。

### 5.10 逐模型子智能体授权（用户确认的写入例外）
- 用户确认在 Bridge 模型行内增加逐模型授权开关，直接编辑 dsh 原有 `subagent-model-selection-settings`；不再把跳转页面当作授权功能。只允许通过官方 `ConfigForms.get()` / `ConfigForm.mutate()` 修改此命名空间的 `enabled` 与 `allowedModels`，由宿主负责持久化；凭据桥和 pi 文件仍严格只读，不直接写文件，也不维护第二份授权存储。
- 采用与官方页一致的草稿 + 保存语义：总开关显式控制；开启总开关后可逐模型添加/移除精确 `{ provider, model }`，所有非目标授权（含非 PI、当前不可见的路由）原样保留。关闭总开关保留授权列表；总开关开启且授权列表为空时禁止保存，提示用户明确关闭总开关或保留至少一个模型，不自动切换全局状态。
- 客户端控制器只订阅共享配置面并持有临时草稿；以读取草稿时的 revision 原子保存两字段。外部更新导致冲突时禁止覆盖，提供取消草稿以读取最新状态；写入拒绝或网络异常必须显式显示，保存期间禁用重复操作，离开页面丢弃未保存草稿。共享配置面由宿主拥有，组件卸载只取消自己的订阅，不销毁共享服务。
- `configForms` 或命名空间不存在、加载中、只读时授权区不可编辑，但不阻塞桥状态或原有能力探测；不新增 host RPC、不改模型路由或 `BridgeStatus`。模型行仅允许编辑当前显示的 PI 路由，新增模型不自动授权；授权只影响新会话中的自主选模，非全局模型访问防火墙。
- 测试先覆盖草稿/保存、精确身份、保留其他授权、空列表约束、不可写和冲突、宿主拒绝/异常及卸载，再覆盖面板开关与既有功能。浏览器对用户真实配置仅做展示检查；保存链路使用合成配置面或隔离宿主验证，不擅自变更用户现有授权。
- **查询提示语义校准**：面板提示用户在对话中请求 Agent 调用 `list_subagent_models`。原生工具无参数只列 provider，带 `provider` 才列其获授权的目录模型，带精确 `provider` / `model` 可查询模型与推理档位。因此示例要求先列 provider、再逐个查询模型；明确其是工具名而非输入即执行的命令，须当前会话提供该工具，返回候选不保证真实调用成功。保存授权后须新建会话再查询，不自动触发工具或模型调用。
- **验证记录（2026-11-04）**：先复现缺少授权控件/关闭回调的 3 项组件失败及缺少查询提示的 1 项失败；实现后控制器 14 项、客户端 20 项回归通过，全量 202 项测试（18 文件）、类型检查、构建与 `git diff --check` 全绿，`npm pack --dry-run` 为 70 文件并含新授权模块。真实 Web 验证共享原生设置可读写标志、78 个 PI 模型开关及 2 个已选授权；仅切换内存草稿再取消，保存按钮恢复禁用、无告警，查询提示可见。可选导航成功关闭 Settings 并显示插件首页/子智能体入口，未触发探测。恢复被关闭的托管浏览器后登录态仍有效，重新验证上述展示及草稿取消。整个本轮验证窗口内 `auth.json`、`models.json`、Web profile manifest/override 四份文件哈希不变，未保存真实授权、未调用模型；保存逻辑由纯内存配置面验证，真实持久化和子智能体执行留待用户验收。此前另轮发现的 `auth.json` 并发变更来源仍独立待查。注释收口为浏览器入口、面板、授权控制器/控件及项目边界的最窄写入例外，LLM 契约和凭据管线未改。
