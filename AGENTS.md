# AGENTS.md

## 响应与规则加载

- 始终使用简体中文。
- 进入仓库后先在根目录运行 `rg --files --max-depth 1 -g 'AGENTS.md' -g 'AGENTS.*.md'`。
- AI 必须同时读取根 `AGENTS.ai.md`；后续若新增 `AGENTS.<platform>.md`，仅在命中对应平台时读取。
- 进入子目录前检查该边界是否有局部 `AGENTS.md` 或 `AGENTS.*.md`。

## 项目边界

- 本库是 dsh 插件：把本机 pi（Pi coding agent）的认证（`auth.json` + `models.json`）在内存中转换为 dsh 的 LLM 路由，即转即用、绝不落地。
- 只读 pi 配置文件；凭据全程只存在于内存：不写 dsh 凭据存储、不写任何文件、不修改 `~/.pi` 与 `$DSH_HOME` 下任何内容。
- LLM 契约以 `@deepseek-ai/dsh-llm` 的公开接口为准，模型调用依赖 `@earendil-works/pi-ai`；禁止重复实现协议或维护第二套凭据体系。
- `docs/spec/2026-08-29-pi-auth-bridge-design.md` 是设计真相源；设计变更先改设计文档，再改代码。

## 开发命令

- 安装：`npm install`
- 测试：`npm test`
- 类型检查：`npm run typecheck`
- 构建：`npm run build`

## 代码与测试

- 遵循 DRY、KISS、SOLID、YAGNI；只改需求直接涉及的代码。
- 单函数尽量不超过 50 行，单文件超过 500 行必须拆分。
- 所有导出符号写中文 JSDoc；入口和跨边界文件写模块头与不变量注释。
- 新行为先写失败测试，再实现；错误必须显式处理，禁止静默失败。
- 测试文件放 `tests/`，命名 `*.test.ts`。

## 安全与文档

- 禁止硬编码密钥、token、用户目录或本机绝对路径。
- 行为、协议、使用和验证变化必须同步 `README.md` 与 `docs/`。
- 最终汇报必须列出已验证项、未验证项、剩余风险和注释收口范围。

## Git

- Commit 使用 Conventional Commits，中文摘要，不添加 AI 小尾巴。
- 禁止 force push；未经当前会话明确授权，不执行 commit、push 或远程写入（含推送 tag）。
- 发版：`npm version patch|minor|major` 手动发版，版本真相源 = `package.json` + `v*` tag，禁止手改 version 字段；发版前 `npm run typecheck && npm test && npm run build` 必须全绿。
- 推送 `v*` tag 后由 `.github/workflows/release.yml` 自动发布 GitHub Release：notes 由 changelogithub 从 Conventional Commits 分组生成（直推 master 无 PR 亦可），并附 `npm pack` 产物；不发布 npm registry。
