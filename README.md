# pi-auth-bridge (dsh-pi-auth-bridge)

> **中文** | [English](./README.en.md)

把本机 **pi**（pi-mono / Pi coding agent）的认证配置（`auth.json` + `models.json`）在**内存中**转换为 dsh 的 LLM 路由 —— 即转即用、凭据绝不落盘。相当于一座认证适配桥：你在 pi 里登录过的 provider，dsh 直接可用。

- **零配置**：默认读取 `$PI_CODING_AGENT_DIR`，否则 `~/.pi/agent`（Windows 即 `%USERPROFILE%\.pi\agent`）。
- **只进不出**：凭据全程只存在于进程内存；不写 dsh 凭据存储、不回写 `~/.pi`、不写任何临时文件。
- **不拖累组合**：找不到 pi 目录、配置损坏、或没有任何可用凭据时，插件空挂载并打 warn，绝不抛错。

## 安装

### git 安装（推荐，免 clone）

`dsh plugin add` 本质是 pnpm 转发，可直接按 git tag 安装指定版本：

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
     dsh-pi-auth-bridge: true
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

依赖：`@earendil-works/pi-ai`（运行时）；`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`（peer，由 dsh 组合提供）。

> Node 版本：pi-ai 0.84.x 声明 `node >= 22.19`；本插件的全部功能在 Node 20 上实测通过（安装时仅有 EBADENGINE 警告），但建议与 dsh 保持一致使用 Node 22+。

## 在 dsh 中使用

### 作为 dsh bundle（官方方式）

本包遵循 dsh 插件官方规范：入口导出 `name` / `inject: ['llm']` / `Config` / `apply`，`package.json` 声明 `dsh.bundle.patch` 指向根目录的 `cordis.patch.yml`（默认零配置挂载，id 为 `pi-auth-bridge`）。装入 profile：

```bash
dsh plugin --profile <name> add /abs/path/dsh-pi-auth-bridge   # 本地路径或 git URL 均可（git 安装见上方「安装」）
```

装入后需**重启 dsh 进程**（Ctrl+C 后重跑 `dsh --profile <name>`）才会出现在模型列表。启动日志出现 `pi-auth-bridge: bridged N route(s) from ...` 即桥接成功；只有 warn 时按提示检查 pi 目录与凭据。

需要改配置时，在 profile 层 `cordis.patch.yml` 用同 id 覆盖：

```yaml
- insert:
    - id: pi-auth-bridge
      name: dsh-pi-auth-bridge
      config:
        # piDir: /custom/pi/agent        # 覆盖 pi 配置目录
        # providers: [anthropic, openai] # 只桥接白名单内的 provider
        includeOAuth: true                # 是否桥接 OAuth 凭据
        commandTimeoutMs: 10000           # !cmd 取值命令超时
```

### 绝对路径直挂（开发调试）

不经 bundle 机制、直接在任意 cordis 配置层 `insert`，两种入口均可：

```yaml
# 直接加载 TypeScript 源码（dsh 支持按绝对路径加载 TS 插件入口）
- insert: [{ id: pi-auth-bridge, name: '/abs/path/pi-auth-bridge/src/index.ts' }]

# 或加载构建产物
- insert: [{ id: pi-auth-bridge, name: '/abs/path/pi-auth-bridge/dist/index.js' }]
```

挂载后，路由名固定为 `pi/<providerId>`（如 `pi/openai`），分组标题恒以「Pi · 」开头（如 `Pi · OpenAI`）——dsh web 的模型选择器只有「分组 → 模型」两级，pi 无法成为真正的第三级渠道，出处由路由前缀与分组标题共同表达，与 dsh 原生 provider 一眼可分。模型目录来自 pi-ai 内置目录或 `models.json` 的自定义声明。

## 工作原理

```
locatePiDir → readPiAuth/readPiModels → buildRoutes → PiAuthBridgeAdapter → ctx.llm.registerAdapter
```

1. **定位**（`pi-locator.ts`）：显式 `piDir` > `$PI_CODING_AGENT_DIR` > `homedir()/.pi/agent`；目录须含 `auth.json` 或 `models.json` 至少其一。
2. **读取**（`pi-auth.ts`）：文件缺失 → `undefined`；JSON 损坏 → 带路径的 `PiAuthBridgeError`（插件层捕获后空挂载 + warn）；单条非法条目 → 跳过 + warn。
3. **转换**（`convert.ts`，纯函数）：
   - `auth.json` 中有凭据的 provider → 内置路由（provider 元数据交给 pi-ai 内置目录）；
   - `models.json` 中的自定义 provider → `{ api, baseURL, models, headers, authHeader }` 全字段映射；
   - apiKey 优先级：`auth.json` 同名条目 > `models.json` 的 `apiKey` 字段；
   - 取值解析与 pi 一致：`"$ENV_VAR"` 读环境变量、`"!cmd args"` 执行 shell 命令取 stdout（默认 10s 超时，内存缓存，每次挂载最多执行一次）、其余为字面量。
4. **适配**（`provider.ts` / `request.ts` / `stream.ts` / `adapter.ts`）：`PiAuthBridgeAdapter extends LlmAdapter`，用 `createModels` 构建 pi-ai 集合，请求级 `apiKey` override 传入凭据（`authHeader: true` 的路由改为以 `Authorization: Bearer <key>` 头发送 key）；遵守 dsh 适配器协议（`usage` 先于 `finish`、`finish` 后无 chunk、tool-call `arguments` 为原始 JSON 字符串、流式用 `argumentsDelta`、块 `index` 按首次出现分配并复用、错误只走 `LlmError` 或 `finish {kind:'error'|'aborted'}`、遵守 `options.signal`、不支持的 option 抛 `UNSUPPORTED_OPTION`）；每次请求携带 dsh-llm 强制的 `attributionHeaders()` 归因头（撞名的自定义头让位并在构建期 warn）。图片附件 v1 不支持：遇 image block 抛 `UNSUPPORTED_OPTION`。

## OAuth 凭据的处理与限制

- access token **未过期**（或无 `expires`）→ 直接当 bearer key 使用；
- **已过期但有 refresh token** → 注入 pi-ai 的**内存** `CredentialStore`，由 pi-ai 自己的 OAuth 刷新机制在请求时刷新；刷新出的新 token 只活在内存里，**绝不回写** `auth.json`。注意：刷新能力来自 pi-ai 内置目录中该 provider 自带的 OAuth 定义，因此仅对目录内的 provider（如 anthropic、openai-codex 等）有效；刷新失败时该 provider 的请求会以错误终止，重新在 pi 侧登录即可恢复；
- 已过期且无 refresh token → 跳过该 provider 并 warn；
- 自定义 provider（不在 pi-ai 目录内）只持过期 OAuth → 无法刷新，构建期跳过并 warn（不会注册成必然 401 的死路由）；
- `includeOAuth: false` 可整体关闭 OAuth 桥接。

## 与 `@deepseek-ai/dsh-llm-pi-ai` 的区别

| | dsh-llm-pi-ai（官方） | pi-auth-bridge（本插件） |
|---|---|---|
| 凭据来源 | harness 自有凭据存储 / 登录流程（`ctx.credentials`、OAuth 登录） | 复用本机 pi 已有的 `auth.json` 登录态 |
| 配置 | settings seam，profile 逐字段覆盖目录 | 零配置（仅 5 个可选项） |
| 凭据落盘 | 会写入 harness 凭据存储 | 绝不写任何文件，纯内存 |
| 重试 | 配合 dsh-llm-retry / retry policy | 无（`maxRetries: 0`） |
| 图片 | 支持（经 dsh-attachment） | v1 不支持，显式 `UNSUPPORTED_OPTION` |
| 自定义 provider | settings.yaml 声明 | 直接复用 pi 的 `models.json` |

一句话：官方适配器面向 harness 自有凭据/登录体系；本插件把 pi 当作认证来源，只做一次性、只读的桥接。

## 安全说明

- 对 pi 配置文件**只读**：不创建、不修改、不删除 `~/.pi`（或 `$PI_CODING_AGENT_DIR`）下任何文件；
- 凭据全程只在进程内存：不调用 `ctx.credentials.set`，不写 dsh 凭据存储，不写临时文件，OAuth 刷新结果也不回写；
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
npm run build       # tsc -p tsconfig.build.json → dist/
npm test            # vitest run，72 个用例
```

测试全部使用临时目录 fixture 与 mock（注入的 `execCmd`、fake pi-ai 流），不访问真实 `~/.pi`，不访问网络。

## 许可证

[MIT](./LICENSE)

## English

完整英文版见 [README.en.md](./README.en.md)。
