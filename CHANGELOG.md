# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本（[SemVer](https://semver.org/lang/zh-CN/)）。

## [v4.1.0] - 2026-08-15

> 依据外部评审（产品思路 8/10、实现 6/10、生产可用性 4/10）迭代：聚焦**可测试性、安全、隐私、流程摩擦**。

### 新增
- **单元测试**：`test/core.test.mjs`（node:test，54 个用例）覆盖纯函数（能力标签/相似度/匹配分/阈值/政策/决策/依赖分析/环检测）、扫描边界（SKIP_DIRS、文件大小、fileBudget 截断、扩展名过滤）、远程 API mock（Token 携带与隔离、多档关键词重试、端到端评估）
- **GITHUB_TOKEN 支持**：api.github.com 请求自动携带 `Authorization: Bearer`（环境变量 `DSH_GITHUB_TOKEN` 或 `GITHUB_TOKEN`），仅附加给 GitHub API 域名，不会泄漏到其他站点
- **CI**：GitHub Actions（Node 20/22）— 三文件语法检查 + 单元测试 + 政策文件 JSON 校验
- **SECURITY.md**：安全说明与威胁模型

### 变更
- **可测试性重构**（core.mjs）：纯函数提升到模块顶层并导出；依赖 ctx 的函数收进 `createCore(deps)` 依赖注入工厂；对 DSH 加载而言对外行为不变（codeRef 服务导出键不变）
- **小任务豁免**：提示词与 `reuse_survey` 描述明确——改单个按钮、修 bug、重命名等预估 <50 行且不引入新组件/新项目的小改动**直接修改**，不触发调查与询问
- **候选发现器定位**：架构相似度明确标注为启发式候选信号，需人工确认数据模型/边界兼容；`reuse_survey` 系统骨架候选阈值 50 → **60**（更保守）
- **隐私默认值**：政策文件新增 `remoteSearch` 字段（默认 true）；企业可设 `false` 使 `reuse_survey` 只做本地调查
- **扫描边界**：SKIP_DIRS 增加 `site-packages`（避免扫进第三方 Python 包）、`tests`/`test`/`e2e`

## [v4.0.0] - 2026-08-15

### 新增
- **架构级复用**：15 类业务能力词典（中英文）、`capabilityLabelsOf` 能力标签提取、`extractSystemProfile` 本地系统画像（能力矩阵/规模/语言）、`architectureSimilarity` 架构相似度
- **`architecture_reuse_search` 工具**：需求能力标签 × 本地系统画像 → 相似度排序（跨领域同架构骨架复用，如"图书馆检索系统复用政务文件管理系统骨架"）
- `reuse_survey` 集成系统级骨架候选（相似度 ≥60 进入摘要与询问选项"以本地系统 X 为骨架开发"）

## [v3.0.0] - 2026-08-15

### 变更
- 从单体 `index.mjs` 拆分为**三插件架构**：`core`（共享服务 codeRef）/ `tools`（检索与架构工具）/ `decision`（评估与询问 + 提示词），通过服务注入协作

## [v2.0.0] - 2026-08-14

### 新增
- **询问模式**：需求澄清后 `reuse_survey` 调查 → 向用户呈现候选清单与价值权衡 → 询问是否复用（用户选择候选/改造/直接开发）
- 支持 `reuseMode: "auto"` 不询问直接决策；90 秒询问超时保护；`unanswered` 时禁止写代码

## [v1.0.0] - 2026-08-14

### 新增
- 初始版本：GitHub/GitLab/Gitee/npm 检索 + 本地代码复用检索 + 复用价值评估 + 公司政策（许可证白名单等）+ 工程规范提示词
