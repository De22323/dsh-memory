# Changelog

## 0.2.0 — 2026-11-13

完整版（还在候选，未发布）。

- **自带脚本**：`scripts/` 里带全套记忆脚本，不依赖工作区 `tools/`（有则优先用那边的最新版）
- **工具六件**：`memory_add` / `memory_search` / `memory_tree` / `memory_get` / `memory_feedback` / `memory_stats`
- **定时**：沉降 + state 校正 + 盒子结算
- **首挂初始化**：按 `template/` 补齐 `memory/`（身份 / 待办 / 近况 / 条目.jsonl），已有文件绝不覆盖
- **配套纪律**：`template/AGENTS-记忆纪律.md`（插件只管工具和结构，纪律决定记忆会不会烂）
- **安全边界**：只有 host 半边，没有 `client.js`；`defineTool` 解析不到就降级为不注册，不炸插件树
- 测试：`test/run.mjs`（脚本层）/ `test/apply.mjs`（插件层）/ `test/edge.mjs`（边界）

## 0.1.2 — 2026-10-23

内测版：四个工具 + 定时沉降；脚本仍从工作区 `tools/` 调。

## 0.1.0 — 2026-10-17

第一版：`memory_add` / `memory_search` / `memory_get` / `memory_stats`。
