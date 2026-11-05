# dsh-pi-auth-bridge (@xnightsky/dsh-pi-auth-bridge)

[![npm version](https://img.shields.io/npm/v/%40xnightsky%2Fdsh-pi-auth-bridge)](https://www.npmjs.com/package/@xnightsky/dsh-pi-auth-bridge)
[![License](https://img.shields.io/github/license/xnightsky/dsh-pi-auth-bridge)](./LICENSE)
[![Release](https://github.com/xnightsky/dsh-pi-auth-bridge/actions/workflows/release.yml/badge.svg)](https://github.com/xnightsky/dsh-pi-auth-bridge/actions/workflows/release.yml)

> **中文** | [English](./README.en.md)

把本机 **pi**（pi-mono / Pi coding agent）的认证配置（`auth.json` + `models.json`）在**内存中**转换为 dsh 的 LLM 路由 —— 即转即用、凭据绝不落盘。相当于一座认证适配桥：你在 pi 里登录过的 provider，dsh 直接可用。

- **零配置**：默认读取 `$PI_CODING_AGENT_DIR`，否则 `~/.pi/agent`（Windows 即 `%USERPROFILE%\.pi\agent`）。
- **只进不出**：凭据全程只存在于进程内存；不写 dsh 凭据存储、不回写 `~/.pi`、不写任何临时文件。
- **不拖累组合**：找不到 pi 目录、配置损坏、或没有任何可用凭据时，插件空挂载并打 warn，绝不抛错。

## 安装

### npm 安装（推荐）

发布版包内已包含构建产物，安装时不需要额外的 `allowBuilds`：

```bash
# 最新发布版
dsh plugin --profile <name> add @xnightsky/dsh-pi-auth-bridge

# 固定版本
dsh plugin --profile <name> add @xnightsky/dsh-pi-auth-bridge@<version>
```

### git 安装（免 clone）

`dsh plugin add` 本质是 pnpm 转发，也可直接从 git tag 安装指定版本：

```bash
# 指定版本 tag（推荐，可复现）
dsh plugin --profile <name> add git+https://github.com/xnightsky/dsh-pi-auth-bridge.git#v0.1.0

# 或跟踪最新 main
dsh plugin --profile <name> add git+https://github.com/xnightsky/dsh-pi-auth-bridge.git
```

git 安装由包的 `prepare` 脚本自动构建 `dist/`。pnpm 默认拦截依赖的构建脚本，需要两轮放行。注意：**allowlist 写在安装方（profile 目录）的 `pnpm-workspace.yaml` 里，与本仓库无关，全程不需要 clone 本仓库**。`allowBuilds` 是 pnpm 10 原生 key（`true` 等价于加入 `onlyBuiltDependencies`）：

1. 首装报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` → 在 `<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 下按包名加一行，重跑：

   ```yaml
   allowBuilds:
     "@xnightsky/dsh-pi-auth-bridge": true
   ```

2. 再报 `ERR_PNPM_IGNORED_BUILDS`，或仅出现 `Ignored build scripts` 警告（pi-ai 的传递依赖 `@google/genai` / `protobufjs` 带构建脚本）→ 若 pnpm 已把占位条目写进同一文件，把值改成 `true`；没有占位条目就按上面同样的格式手动补一行，再重跑一次。

### 本地安装（开发调试）

```bash
git clone git@github.com:xnightsky/dsh-pi-auth-bridge.git
cd dsh-pi-auth-bridge
npm install
npm run build   # 产出 dist/（ESM + .d.ts）
dsh plugin --profile <name> add /abs/path/dsh-pi-auth-bridge
```

依赖：`@earendil-works/pi-ai`（运行时）、`undici`（代理 fetch）、`zod`（Typert 产物 schema）；`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-attachment`、`@deepseek-ai/dsh-typert-protocol`、`react`（peer，由 dsh 组合提供；`LlmAdapter` 的 `imageRequestPricing` 沿用基类默认的「不声明图片计价」）。本版本支持 DSH `^0.2.1-rc.4`：即 0.2.1-rc.4 起的所有 0.2.x（含预发布），到 dsh 进入 0.3.0 线之前为止，不再逐版本列举。适配独立 `tool` 角色、`developer` 工具增删与延迟声明、原生 system 历史，以及 `imageRequestTarget()` 图片投影契约；0.2.2-rc.1 相对 rc.5 的契约变化均为可选增补，桥未使用、无需改动；不再支持 0.1.6。

三个 dsh peer 声明同一个跟随式窗口 `^0.2.1-rc.4`（等价 `>=0.2.1-rc.4 <0.3.0-0`）：0.2.1-rc.4 及以后的所有 0.2.x 宿主（含 rc）都放行，dsh 进入 0.3.0 线时才需要重新核对；下界仍是首个已核实版本，因此 0.2.1-rc.2 / rc.3 继续被拒绝。不使用 `engines.dsh` 或版本豁免。开发测试基线保持 `devDependencies` 0.2.2-rc.1 精确锁定，lockfile 与本地安装均解析为 0.2.2-rc.1；`devDependencies` 的 `@deepseek-ai/cordis` 升至 `^4.1.0`，peer 仍为 `^4.0.5`（该范围本身已接纳 4.1.0）。注意范围必须写成 `^0.2.1-rc.4` 或显式 `<0.3.0-0`：宿主判定带 `includePrerelease`，写成 `>=0.2.1-rc.4 <0.3.0` 会误放行 `0.3.0-rc.1`。代价：0.2.x 内的运行时语义漂移不再被宿主前置闸门拦截，由插件自带的启动自检（`dsh-llm-contract` / `dsh-attachment-contract`）与面板自健康兜底；出现异常时回退到上一个插件版本即可。升级插件后请重启 dsh。

> Node 版本：pi-ai 1.x 声明 `node >= 22.19`，请使用 Node 22.19+，并与 dsh 的运行时要求保持一致。

## 在 dsh 中使用

### 作为 dsh bundle（官方方式）

本包遵循 dsh 插件官方规范：入口导出 `name` / `inject: ['llm']` / `Config` / `apply`，`package.json` 声明 `dsh.bundle.patch` 指向根目录的 `cordis.patch.yml`（默认零配置挂载，id 为 `dsh-pi-auth-bridge`）。装入 profile：

```bash
dsh plugin --profile <name> add /abs/path/dsh-pi-auth-bridge   # 本地路径；npm/git 安装见上方「安装」
```

装入后需**重启 dsh 进程**（Ctrl+C 后重跑 `dsh --profile <name>`）才会出现在模型列表。启动日志出现 `dsh-pi-auth-bridge: bridged N route(s) from ...` 即桥接成功；只有 warn 时按提示检查 pi 目录与凭据。

需要改配置时，在 profile 层 `cordis.patch.yml` 用同 id 覆盖：

```yaml
- insert:
    - id: dsh-pi-auth-bridge
      name: "@xnightsky/dsh-pi-auth-bridge"
      config:
        # piDir: /custom/pi/agent        # 覆盖 pi 配置目录
        # providers: [anthropic, openai] # 只桥接白名单内的 provider
        includeOAuth: true                # 是否桥接 OAuth 凭据
        commandTimeoutMs: 10000           # !cmd 取值命令超时
        proxy: true                       # 嗅探代理环境变量并注入代理 fetch（见「代理支持」）
```

### 绝对路径直挂（开发调试）

不经 bundle 机制、直接在任意 cordis 配置层 `insert`，两种入口均可：

```yaml
# 直接加载 TypeScript 源码（dsh 支持按绝对路径加载 TS 插件入口）
- insert: [{ id: dsh-pi-auth-bridge, name: '/abs/path/dsh-pi-auth-bridge/src/index.ts' }]

# 或加载构建产物
- insert: [{ id: dsh-pi-auth-bridge, name: '/abs/path/dsh-pi-auth-bridge/dist/index.js' }]
```

挂载后，路由名固定为 `pi/<providerId>`（如 `pi/openai`），分组标题恒以「Pi · 」开头（如 `Pi · OpenAI`）——dsh web 的模型选择器只有「分组 → 模型」两级，pi 无法成为真正的第三级渠道，出处由路由前缀与分组标题共同表达，与 dsh 原生 provider 一眼可分。模型目录来自 pi-ai 内置目录或 `models.json` 的自定义声明。

**模型目录版本**：插件依赖 `@earendil-works/pi-ai@^1.5.0`，内置 Kimi 目录包含 `k3.1-pro` 和 `k3.1-pro-highspeed`。插件使用自身安装的 SDK，不读取 `pi --list-models` 输出；仅升级全局 pi 不会同步插件目录。若 pi 中可见而 Bridge 面板缺失，请更新插件及其依赖并重启 dsh。模型进入目录不等于已获子智能体授权或真实调用验证。

## 工作原理

```
locatePiDir → readPiAuth/readPiModels → buildRoutes → PiAuthBridgeAdapter → ctx.llm.registerAdapter
```

1. **定位**（`pi/locator.ts`）：显式 `piDir` > `$PI_CODING_AGENT_DIR` > `homedir()/.pi/agent`；目录须含 `auth.json` 或 `models.json` 至少其一。
2. **读取**（`pi/auth.ts`）：文件缺失 → `undefined`；JSON 损坏 → 带路径的 `PiAuthBridgeError`（插件层捕获后空挂载 + warn）；单条非法条目 → 跳过 + warn。
3. **转换**（`convert.ts`，纯函数）：
   - `auth.json` 中有凭据的 provider → 内置路由（provider 元数据交给 pi-ai 内置目录）；
   - `models.json` 中的自定义 provider → `{ api, baseURL, models, headers, authHeader }` 全字段映射；
   - apiKey 优先级：`auth.json` 同名条目 > `models.json` 的 `apiKey` 字段；
   - 模型条目的 `input` 声明（如 `["text", "image"]`）透传为模型的输入模态——dsh 据此判定图片能力；未声明时回退 pi-ai 目录同名模型，目录也没有时视为纯文本；
   - 取值解析与 pi 一致：`"$ENV_VAR"` 读环境变量、`"!cmd args"` 执行 shell 命令取 stdout（默认 10s 超时，内存缓存，每次挂载最多执行一次）、其余为字面量。
4. **适配**（`provider.ts` / `request.ts` / `stream.ts` / `adapter.ts`）：`PiAuthBridgeAdapter extends LlmAdapter`，用 `createModels` 构建 pi-ai 集合，API key 通过请求级 `apiKey` override 传入，可刷新的 OAuth 则交 SDK 内存凭据存储管理（`authHeader: true` 的路由改为以 `Authorization: Bearer <key>` 头发送 key）；遵守 dsh 适配器协议（`usage` 先于 `finish`、`finish` 后无 chunk、tool-call `arguments` 为原始 JSON 字符串、流式用 `argumentsDelta`、块 `index` 按首次出现分配并复用、错误只走 `LlmError` 或 `finish {kind:'error'|'aborted'}`、遵守 `options.signal`、不支持的 option 抛 `UNSUPPORTED_OPTION`）；每次请求携带 dsh-llm 强制的 `attributionHeaders()` 归因头（撞名的自定义头让位并在构建期 warn）。图片附件：模型声明 image 输入且 dsh 组合挂了 dsh-attachment 服务时，durable 引用经 `readImageRequest` 投影（按 ref 尺寸换算 `{width, height, maxBytes}` target，默认 2048×2048 / 1 MiB；请求级 20 MiB 预算超出时抛 `IMAGE_OFFLOAD_REQUIRED` 由宿主标记卸载后重试）后以 base64 内联为 pi-ai image 块；模型不支持图片输入、附件服务缺失或非 user/tool 角色带图时显式抛 `UNSUPPORTED_CONTENT`，不静默丢图。

文本与图片路径都会在合并开头 system 消息、读取附件前校验完整历史：system 只允许纯文本，非法内容显式抛 `UNSUPPORTED_CONTENT`，不静默丢弃。

## 代理支持

pi-ai 与 dsh 都不读 `http_proxy` 等代理环境变量（pi 本体能走代理，靠的是 pi CLI 启动时的全局 dispatcher 补丁）。本插件在**不触碰全局状态**的前提下补上这一环：

- **默认开启**（`proxy: true`）：挂载时嗅探 `http_proxy` / `https_proxy` / `all_proxy`（大小写均认）；探测到就用 `undici` 的 `EnvHttpProxyAgent`（与 pi CLI 同款参数）构造代理 fetch，经 `SimpleStreamOptions.fetch` 只注入本桥自己的请求——不动 `globalThis.fetch`，不影响 dsh 其他适配器。`no_proxy` 生效；未设代理变量时不注入，行为与之前完全一致。
- **关闭**：`proxy: false`。适用于代理变量是留给 git/npm 等工具、而 LLM 端点必须直连的场景（内网镜像、本地端点等）。
- **google 线路例外**：`google-generative-ai` / `google-vertex` 的 pi-ai adapter 拒绝自定义 fetch，这两条路由不注入（每路由 warn 一次）。如需给它们走代理，以 `NODE_USE_ENV_PROXY=1`（Node ≥ 24.5）启动 dsh，让 Node 内建 fetch 自己读代理变量——这也是不想依赖 undici 时的全局备选。
- **OAuth 刷新例外**：SDK 内部刷新调用全局 `fetch`，不会使用本插件的模型请求代理，也不受 `proxy: false` 控制。受限网络中请使用 Node ≥ 24.5，在启动 dsh 前设置 `NODE_USE_ENV_PROXY=1`，并配置 `HTTP_PROXY` / `HTTPS_PROXY`（或对应小写变量）；不能只依赖 `all_proxy`。插件不会替宿主修改全局 fetch 或 dispatcher。
- **全局代理隔离**：本库将 `undici` 限制在 7.x，避免 8.x 导入时覆盖 Node 内置的全局代理 dispatcher。宿主其他依赖若自行重置 dispatcher，仍需由宿主协调；仅设置代理地址并不能保证 OAuth 刷新走代理。
- 启动日志出现 `dsh-pi-auth-bridge: proxy environment detected; ...` 即代理注入已生效。

## 插件面板（Settings → Pi Auth Bridge）

本插件是双面（dual-face）插件：除 host 半区的 LLM 桥外，还带一个浏览器半区，在 dsh web 的 **Settings 面板**中注册「Pi Auth Bridge」区块，展示：

- **桥状态**：已桥接 / 空挂载（含原因：未找到 pi 目录、配置不可读、无可用凭据等）；
- **路由与模型清单**：每条 `pi/*` 路由可展开完整模型子表（模型 id、上下文窗口、输入模态）——**凭据本体绝不进入面板**；
- **能力探测矩阵**：每模型行内「测试」（跑全部适用维度）+ 点击能力徽章按维度单测，对文本、图片、推理、工具调用四个维度逐一探测（✓ 可用 / ✗ 失败 / — 不适用 / ? 不确定）。探测是点击触发的真实 API 调用，走本桥完整管线（请求转换 + 流翻译），适用性按模型声明裁剪（不支持图片/推理的模型对应维度记「—」）；每维结果带诊断详情（终态、usage、回复预览、异常类型等，面板可见且与 host 日志同源，出问题可事后回溯）；最近一次探测结果缓存进状态快照（按维度合并），重开面板可见；
- **插件自健康**：关键组件版本表（插件 / dsh-llm / dsh-attachment / pi-ai）、启动自检（dsh-llm 归因头契约、dsh-attachment 图片换算契约、附件服务是否挂载）与近期请求错误（新→旧最多 20 条）——升级后桥是否健康一眼可见；
- **生效配置回显**（白名单 / OAuth 开关 / 取值命令超时）、**代理嗅探结果**与桥接过程的全部**警告**；
- **逐模型子智能体授权**：在模型行直接切换「允许子智能体使用」，再保存到 dsh 原生授权清单；保留其他模型授权，带版本冲突校验，不重复配置连接或密钥；
- 静态能力说明（桥接范围、安全边界）。

实现机制：host 半区挂载一个 Typert Remote 服务（`piAuthBridge/status` 只读快照 + `piAuthBridge/probe` 能力探测），浏览器半区经 `ctx.remote.$mount` 调用并渲染进 `settings.section` 槽位。子智能体授权复用宿主 `configForms` 官方设置接口，仅显式保存时修改 `enabled` / `allowedModels`，不新增 host RPC、不直接写文件。面板只在 dsh web 组合中生效，headless 组合无副作用。

### 将 PI 模型用于子智能体

1. 在 Bridge 面板的「子智能体模型选择」区显式开启「允许 Agent 为子智能体选择模型」。
2. 展开下方路由，在每个模型旁切换 **「允许子智能体使用」**，然后点击 **「保存子智能体授权」**。开关修改的是临时草稿；点击「取消授权修改」或离开面板会丢弃尚未保存的修改。
3. **新建会话**，让 `list_subagent_models` 根据该会话的授权发现模型。保存不改变已有会话；关闭自主选模不等于禁止子智能体继承父模型。

对话查询示例：**「请调用 `list_subagent_models`，先列出 provider，再逐个查询模型，汇总本会话的子智能体候选清单。」** 这是工具名，不是输入即执行的命令；无参数只列 provider，带 provider 才列模型，须当前会话提供该工具。结果受本会话授权及目录限制，不代表真实调用已验证；修改授权后请新建会话再查询。

本面板与官方 **插件 → 子智能体 → 模型选择** 共用一份 `allowedModels`，保留所有非目标授权，不自动授权新模型。总开关关闭时保留已选模型；开启时至少需要一个授权，不能将空清单保存为开启状态。宿主只读、设置缺失或保存失败会显式提示；遇到其他页面的并发修改时，请取消草稿后重新选择，避免覆盖最新授权。

「打开插件」是可选的官方页面入口：只打开插件首页并关闭 Settings 弹层，需再进入「子智能体」；官方候选列表可在框内滚动。缺少导航或授权编辑服务不影响原有桥状态与探测。模型进入候选目录只证明已注册，不代表已授权或真实模型/子智能体调用成功。

## OAuth 凭据的处理与限制

- **新版 OpenAI**：支持 pi-ai ≥ 1.4.0 的 `openai` / Sign in with ChatGPT，dsh 路由为 `pi/openai`。保留续期必需的 `clientId`，以及 `scopes` 等 provider 元数据；集合查询仍用 `pi/openai`，实际 SDK 请求恢复原始 OpenAI 身份，以保留 ChatGPT 专用的请求参数处理。不新增旧 `openai-codex` 专用兼容分支。
- **有 refresh token** → 无论启动时 access 是否过期，始终注入 pi-ai 的**内存** `CredentialStore`。首次请求等待凭据就绪，之后由 SDK 自动续期并复用轮换后的 token；缺省 `expires` 时交 SDK 先刷新。选中的 OAuth 不会被 `models.json.apiKey` 或环境 API key 偷偷替代；刷新失败时请求明确失败。
- **无 refresh token** → access 尚有效（或无 `expires`）时仅作为静态 key 使用，不具备自动续期能力；已过期则跳过该 provider 并 warn。
- **无 OAuth handler** → 自定义非目录 provider 或目录内不支持 OAuth 的 provider，持有可刷新 OAuth 时构建期跳过并 warn，不能仅因有 token 就视为可服务。
- **只读与轮换限制**：新 access / refresh 及 provider 元数据只留当前进程内存，绝不回写 `auth.json`，也不自动重读 pi 登录态。重启后会重读原文件；如果 refresh 已轮换，原文件里的旧值可能失效。pi 与多个 dsh 进程之间不共享刷新锁，避免并行使用同一轮换凭据；必要时重新在 pi 登录后重启 dsh。
- **刷新网络**：需保证宿主全局 fetch 能访问 OpenAI OAuth 端点，模型请求代理成功不代表刷新成功，配置见上方「代理支持」。
- `includeOAuth: false` 可整体关闭 OAuth 桥接。

真实验证（2026-10-28，Node 24.14.0 / pi-ai 1.4.0 / undici 7.30.1）：真实 OAuth 刷新 HTTP 200，轮换后连续两次 `gpt-6-sol` 请求均返回 HTTP 200 / `OK`，无重复刷新、无 API key 回退；pi 配置文件前后校验一致。验证使用当前构建产物，不代表已部署到用户 dsh profile 或完成 Web UI 验收。

## 与 `@deepseek-ai/dsh-llm-pi-ai` 的区别

| | dsh-llm-pi-ai（官方） | dsh-pi-auth-bridge（本插件） |
|---|---|---|
| 凭据来源 | harness 自有凭据存储 / 登录流程（`ctx.credentials`、OAuth 登录） | 复用本机 pi 已有的 `auth.json` 登录态 |
| 配置 | settings seam，profile 逐字段覆盖目录 | 零配置（仅 6 个可选项） |
| 凭据落盘 | 会写入 harness 凭据存储 | 凭据不落盘，仅保存在内存 |
| 重试 | 配合 dsh-llm-retry / retry policy | 无（`maxRetries: 0`） |
| 图片 | 支持（经 dsh-attachment） | 支持（同样经 dsh-attachment，策略与官方一致） |
| 自定义 provider | settings.yaml 声明 | 直接复用 pi 的 `models.json` |

一句话：官方适配器面向 harness 自有凭据/登录体系；本插件把 pi 当作认证来源，只做一次性、只读的桥接。

## 安全说明

- 对 pi 配置文件**只读**：不创建、不修改、不删除 `~/.pi`（或 `$PI_CODING_AGENT_DIR`）下任何文件；
- 凭据全程只在进程内存：不调用 `ctx.credentials.set`，不写 dsh 凭据存储，不写临时文件，OAuth 刷新结果也不回写；
- **授权写入例外**：用户在面板显式保存时，由 dsh 原生设置接口持久化子智能体 `enabled` / `allowedModels`；不包含凭据、不建立第二份白名单，不改其他宿主配置；
- `"!cmd"` 取值命令来自 pi 自己的配置文件（与你直接运行 pi 时执行的命令相同），默认 10s 超时、结果仅在内存缓存；
- warn/日志不包含凭据内容。

## 免责声明

- 本插件只是一个**只读的本地配置桥**：它读取你本机 pi 已有的登录态并在内存中转发为 dsh 路由，不提供任何凭据、不绕过任何付费墙、不破解任何鉴权。
- **API key 桥接**没有条款风险——key 本就设计为可被任意客户端使用。
- **订阅制 OAuth token 不同**：部分厂商明确限定其只能用于官方客户端。例如 Anthropic 的消费者服务条款规定，Free/Pro/Max 订阅的 OAuth token 仅限 Claude Code 与 Claude.ai 使用，在任何第三方工具中使用即构成违约，且已有用户因此被封号的公开案例。经本桥在 dsh 中使用此类 token 的行为由**使用者自行判断并承担全部后果**（包括但不限于账号被限制或封禁）。
- 使用前请自行阅读并遵守各 provider 的服务条款；`includeOAuth: false` 可整体关闭 OAuth 桥接，只用 API key 路径。
- 本项目与 pi、Anthropic、OpenAI、DeepSeek 等任何厂商均无隶属或背书关系。本节内容不构成法律意见。

## 平台支持

- **Linux / macOS**：默认目录 `~/.pi/agent`；
- **Windows**：默认目录 `%USERPROFILE%\.pi\agent`（`os.homedir()` 天然跨平台）；
- 两平台均可用 `$PI_CODING_AGENT_DIR` 或配置项 `piDir` 覆盖；
- 路径拼接逻辑通过注入 `env` / `homedir` / `joinPath` 的纯函数实现，win32 与 posix 样本均有单元测试覆盖。

## 开发与测试

```bash
npm run typecheck   # tsc --noEmit，严格模式零错误
npm run build       # tsc → dist/（host + Typert 产物），tsdown → dist/client.js（浏览器半区）
npm test            # vitest run
```

`npm test` 全部使用临时目录 fixture 与 mock，不访问真实 `~/.pi` 或外网。新版 OpenAI OAuth 回归使用真实 pi-ai 配合拦截的刷新 / Responses fetch，覆盖首次认证、启动后过期、轮换 refresh 复用、进程内并发刷新、刷新失败不回退、ChatGPT 参数处理和面板不泄露元数据。

DSH 基线回归同时检查包清单、lockfile、实际安装版本和中英文文档一致，避免以旧的本地依赖误验新宿主。

pi-ai 1.5.0 升级验证：两个 K3.1 的适配器模型列表、元数据与面板回填新增 3 项回归，升级前失败、升级后通过；类型检查、205 项测试、构建及依赖树检查全部通过。构建产物的离线 Kimi 目录冒烟通过，用户随后确认模型显示修复有效；代理未修改用户配置，真实 K3.1 云端调用与完整 UI 验收仍未覆盖。

2026-11-06 对接 `0.2.2-rc.1`：用户桌面 DSH 已为 `0.2.2-rc.1`，其 app.asar 内 `@deepseek-ai/dsh-desktop-runtime` 的 dependencies 精确锁定 `@deepseek-ai/dsh-llm`、`dsh-attachment`、`dsh-typert-protocol`、`dsh-typert-registry`、`dsh-api-gateway` 等均为 0.2.2-rc.1，`@deepseek-ai/cordis` 为 4.1.0；用户此前看到宿主提示 v0.6.1 与 0.2.2-rc.1 不兼容。以 npm 上真实的 `@deepseek-ai/dsh-app-boot@0.2.2-rc.1` 的 `evaluatePluginCompatibility` 复现：v0.6.1 清单被判不兼容且警告文案与宿主一致，改为新范围后返回 `undefined`（兼容通过）；该检查按运行中的 dsh 版本逐个比对每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer，不使用 `engines.dsh`，也不受版本豁免影响。同日用户决定改为「跟随式窗口」：三个 peer 从三值并集改为 `^0.2.1-rc.4`（等价 `>=0.2.1-rc.4 <0.3.0-0`），放行 0.2.1-rc.4 起的所有 0.2.x（含预发布），拒绝 0.2.1-rc.2 / rc.3 与整个 0.3.0 线；实测矩阵接受 0.2.1-rc.4 / 0.2.1-rc.5 / 0.2.2-rc.1 / 0.2.2-rc.2 / 0.2.3-rc.1 / 0.2.9 / 0.2.2，拒绝 0.2.1-rc.2 / 0.2.1-rc.3 / 0.3.0-rc.1 / 0.3.0 / 0.4.0-rc.1（注意 `>=0.2.1-rc.4 <0.3.0` 会误放行 `0.3.0-rc.1`，故必须用 `^` 或 `<0.3.0-0`）。契约包比对（npm rc.5 产物 vs 本机 0.2.2-rc.1）：`dsh-llm` 新增 `llm/models-updated` 事件、`LlmModelBadge` / `LlmModelBadgeTone` 与 `LlmModelInfo.badge?`，`GenerateOptions` 的 `purpose` 改为可增广的 `LlmRequestPurposeMap` 派生类型；`dsh-attachment` 新增「已存储图片 + encodedBytes」分支；`dsh-typert-protocol` 的资源声明新增 `resolve` 分支；`dsh-client-ui-settings` 新增可选 `settings.section.icon` 槽位；`dsh-client-ui-slots` 产物与 rc.5 一致——均为可选增补或桥未使用的面，宿主未新增必填成员，`src/` 无需改动。本轮在 0.2.2-rc.1 基线（Node v24.14.1 / npm 11.11.0）下 `npm install`、`npm run typecheck`、`npm run build` 通过，`npm test` 19 个文件共 205 项在文档同步后全绿（同步前仅基线测试中两条「文档未同步」断言失败）。真实宿主冒烟已通过：以桌面 App 内置 0.2.2-rc.1 CLI 在隔离的临时 DSH_HOME 新建 web profile，把本仓库构建产物以 link 方式装入后启动。宿主 stderr 无 `skipping profile bundle ... incompatible`；`--dump-config` 组合树含 `id: dsh-pi-auth-bridge`；首页 `__DSH_BOOT__.entries` 含本插件的 client 条目（74 个 client entries 中在列）；另以临时、只读的 Cordis 日志导出 bundle 捕获到 `dsh-pi-auth-bridge: bridged 8 route(s) from <pi 目录>: ...`（0.2.2-rc.1 CLI 默认不把 info 级 Cordis 日志写到 stdout/stderr，故需临时导出器；该 bundle 不属于插件，验证后已删除）。真实 Typert `piAuthBridge/status` 返回 HTTP 200、`phase=bridged`、10 条路由状态（8 条可服务 + 2 条未知 provider 按预期 warning 跳过）、三项启动自检全 `ok`，`versions` 为 plugin 0.6.1 / dshLlm 0.2.2-rc.1 / dshAttachment 0.2.2-rc.1。浏览器实际点击与面板渲染、真实云端 probe、headless/tui profile 未覆盖；`~/.pi` 全程只读、临时宿主与数据已清理，未触碰用户桌面实例端口。

2026-11-04 对接 `0.2.1-rc.5`：类型检查、175 项测试与构建通过；随后 peer 放宽至 rc.4 / rc.5，保留 rc.5 开发测试基线。构建产物经真实 rc.5 Cordis / LlmRuntime、真实 pi-ai 与内存模拟上游通过文本流冒烟（含认证/归因头、usage→finish、路由释放）。本轮未使用真实凭据、未修改用户配置；尚未验收 rc.5 桌面 UI、实际 profile 安装、云端及图片附件端到端。下列 rc.2/rc.4 记录仅为历史验证，不替代 rc.5 验收。

2026-10-26 另以真实 dsh `0.2.1-rc.2` 临时 Web profile 完成云端文本、user/tool 图片请求及面板 Gateway 四维探测；浏览器实际点击与其他 provider 尚未覆盖。验证范围见[设计文档「背景事实」](docs/spec/dsh-pi-auth-bridge-design.md)。
2026-11-03 另以用户桌面 App 实际运行的 dsh `0.2.1-rc.4`（Node v24.21.0）独立临时 Web profile 验证：本地 link 安装后，rc.4 宿主启动日志无 `skipping profile bundle ... incompatible`，输出 `dsh-pi-auth-bridge: bridged 4 route(s) from ...`；经宿主真实 `piAuthBridge/status` Typert 端点返回 HTTP 200，状态为 `phase=bridged`、三项启动自检均 `ok`，4 条可服务路由的面板模型清单分别回填 4/2/42/305 项；随后对 `pi/deepseek` / `deepseek-flash` 执行真实文本 probe，HTTP 200、921 ms、`finish=stop`、`usage ✓`、回复 `Pong`，状态服务缓存结果与宿主日志一致。浏览器点击、其余能力维度和云端对话未覆盖；`~/.pi` 的 `auth.json` / `models.json` 前后 SHA-256 一致，临时宿主与数据已清理。

## 许可证

[MIT](./LICENSE)

## English

完整英文版见 [README.en.md](./README.en.md)。
