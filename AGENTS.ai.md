# AGENTS.ai.md

## AI 工作边界

- 先只读探索，再修改；变更前说明目标、范围和预期影响。
- 使用 `rg` 定位文件和文本，使用非交互式命令。
- 不回退非自己产生的修改，不顺手重构无关代码。
- 需求有歧义、范围扩大或跨仓约束冲突时先询问用户。

## 工具

- 文件读取优先使用 read；精确修改优先使用 edit。
- Shell 使用 PowerShell 7；包管理统一使用 npm。
- pi-intercom 仅用于同机相关会话协作，不得冒充本项目的验收入口。
- 浏览器自动化不是本库默认依赖，不引入浏览器或 GitHub MCP。

## 设计文档

- Superpowers 产出的设计与规格文档写入 `docs/spec/`，将默认的 `docs/superpowers/specs/*` 重定向为 `docs/spec/*`，禁止创建 `docs/superpowers/` 层级。
- 已核实的背景事实记入 `docs/spec/` 设计文档的「背景事实」一节，不重复调研。

## 提交授权

- 默认不得执行 `git commit`、`git push`、`gh repo create` 或其它远程写入。
- 只有用户在当前会话明确授权后才能执行相应动作。
- 提交信息不添加 `Co-Authored-By` 或生成器标记。
