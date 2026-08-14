# dsh-code-reference

DeepSeek Harness (DSH) 代码参考检索与工程规范插件：在**厘清需求之后**自动调查本地与开源的可复用代码，把"候选清单 + 价值权衡"呈现给用户并**询问是否需要复用**（可选择复用哪个候选/改造/不复用直接开发）；也支持配置为不询问、直接优先复用。

## 核心工作流

```
用户提出开发需求
  → 澄清需求（范围/语言/约束）
  → reuse_survey：自动调查（本地代码库 + GitHub 等开源平台）并评估价值权衡
  → 向用户呈现候选清单 + 价值对比，询问是否复用（用户选择候选/改造/直接开发）
  → 按用户选择执行（复用 → 改造 → 引入依赖 → 从零实现）
```

- **默认询问**：`reuse_survey` 调查后弹出选项（复用哪个本地候选 / 复用哪个开源项目 / 不复用直接开发），用户决定
- **可选不询问**：公司政策文件配置 `"reuseMode": "auto"`（或工具传 `ask=false`），跳过询问直接采用评估推荐（优先复用）
- **不做强制拦截**：系统不会阻止写文件，复用与否由用户与模型协商决定

## 工具清单

| 工具 | 用途 |
|---|---|
| `reuse_survey` | **主流程**：调查（本地+开源）→ 价值权衡 → 询问用户是否复用（或 auto 模式直接决策） |
| `local_code_reuse_search` | 本地代码库（公司/项目）中检索可复用的函数/类/组件/模块 |
| `github_reference_search` | GitHub 仓库检索（star 排序、许可证、README） |
| `github_repo_reference` | GitHub 仓库元数据 + README + 关键文件 |
| `gitlab_reference_search` | GitLab.com 项目检索 |
| `gitee_reference_search` | Gitee（码云）仓库检索 |
| `npm_reference_search` | npm 包检索（依赖选型） |
| `reuse_value_assessment` | 独立的价值评估：复用 vs 从零实现的成本对比决策 |
| `code_architecture_review` | 架构自检：循环依赖/超大模块/扇入扇出热点 |

## 复用价值判断标准

只有当复用的**总成本**（改造工作量 + 质量风险 + 集成成本）显著低于从零实现时才复用：

- **量化维度**：需求匹配度（0-100，内容 70% + 名称 30%）、代码规模/复杂度、注释比、测试覆盖信号、维护活跃度、许可证、star
- **决策四档**：`reuse`（直接复用）/ `adapt`（改造复用）/ `dependency`（引入依赖）/ `rewrite`（自制）
- **阈值可调**：`reuseThreshold`(默认70) / `adaptThreshold`(默认40) / `remoteThreshold`(默认50) / `smallLines`(300) / `mediumLines`(800) / `maxComplexityPercent`(12)

## 公司政策（`.code-reference-policy.json`）

自动查找顺序：显式 `policyPath` → 工作区根 → 本地候选目录向上 3 层。支持字段：

```json
{
  "allowedLicenses": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "Unlicense", "0BSD"],
  "blockedLanguages": [],
  "requireTests": false,
  "minCommentRatio": 0,
  "reuseMode": "ask"
}
```

- `reuseMode: "ask"`（默认）：调查后询问用户
- `reuseMode: "auto"`：不询问，直接采用评估推荐决策（优先复用）
- 政策检查进入评估：许可证不在白名单 → 排除依赖；语言在黑名单 → 候选不可用；要求测试但候选无测试 → 复用降级为"改造 + 补测试"

## 安装

## 架构（拆分为三个小插件，通过 codeRef 服务协作）

| 插件 | 职责 | 文件 |
|---|---|---|
| `code-ref-core` | 共享服务（HTTP 请求、本地扫描、候选评估、政策、决策引擎） | `plugins/core.mjs` |
| `code-ref-tools` | 6 个检索工具 + 架构自检 | `plugins/tools.mjs` |
| `code-ref-decision` | 复用价值评估 + 复用调查询问 + 工程规范提示词 | `plugins/decision.mjs` |

## 安装

### 部署级（推荐：所有会话 + 重启后持久生效）

1. 把 `plugins/` 下三个 `.mjs` 文件放到任意目录（如 `~/.dsh/plugins/code-reference/`）
2. 在 DSH 配置的 patch 层（如 `~/.dsh/profiles/web/cordis.patch.yml`）追加：

```yaml
- insert:
    - id: code-ref-core
      name: /绝对路径/core.mjs
    - id: code-ref-tools
      name: /绝对路径/tools.mjs
    - id: code-ref-decision
      name: /绝对路径/decision.mjs
```

3. 重启 DSH，所有会话自动获得工具与复用调查流程

### 动态级（临时，重启失效）

在会话中用 `cordis_define` / `cordis_run` 加载本插件的 host 代码（适用于调试；部署后请勿同时运行，避免工具重名）。

## 注意事项

- 未认证 API 限流：GitHub 搜索约 10 次/分钟，工具会返回 `resetAt` 重试时间；可配置 Token 提配额
- 远程检索结果为第三方开源项目，复用必须遵守其许可证（`license` 字段）
- 询问等待上限 90 秒（无真人应答的上下文会自动跳过询问并采用推荐决策）

## 许可证

[MIT](./LICENSE)
