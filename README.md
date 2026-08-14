# dsh-code-reference

DeepSeek Harness (DSH) 代码参考检索与工程规范插件：在开发新项目/新组件前，**系统强制**先检索本地与开源的可复用代码，并用量化标准判断"复用价值是否大于从零实现"；同时贯彻高内聚低耦合的架构原则。

## 核心能力

### 1. 先复用再开发（两级系统强制，非提示词自觉）

DSH 模型调用 `write` 创建**新文件**时，`tools/pre-execute` 钩子拦截：

- **第 1 级**：本会话未执行过复用检索 → 拒绝写入，要求先检索
- **第 2 级**：检索发现候选但未做价值评估 → 拒绝写入，要求先评估
- 评估建议 `rewrite`（自制）时放行

### 2. 多平台 + 本地复用检索

| 工具 | 用途 |
|---|---|
| `local_code_reuse_search` | 本地代码库（公司/项目）中检索可复用的函数/类/组件/模块 |
| `github_reference_search` | GitHub 仓库检索（star 排序、许可证、README） |
| `github_repo_reference` | GitHub 仓库元数据 + README + 关键文件 |
| `gitlab_reference_search` | GitLab.com 项目检索 |
| `gitee_reference_search` | Gitee（码云）仓库检索 |
| `npm_reference_search` | npm 包检索（依赖选型） |

### 3. 复用价值判断标准（`reuse_value_assessment`）

只有当复用的**总成本**（改造工作量 + 质量风险 + 集成成本）显著低于从零实现时才复用：

- **量化维度**：需求匹配度（0-100，内容 70% + 名称 30%）、代码规模/复杂度、注释比、测试覆盖信号、维护活跃度、许可证、star
- **决策四档**：`reuse`（直接复用）/ `adapt`（改造复用）/ `dependency`（引入依赖）/ `rewrite`（自制）
- **阈值可调**：`reuseThreshold`(默认70) / `adaptThreshold`(默认40) / `remoteThreshold`(默认50) / `smallLines`(300) / `mediumLines`(800) / `maxComplexityPercent`(12)

### 4. 公司政策（`.code-reference-policy.json`）

自动查找顺序：显式 `policyPath` → 工作区根 → 本地候选目录向上 3 层。支持字段：

```json
{
  "allowedLicenses": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "Unlicense", "0BSD"],
  "blockedLanguages": [],
  "requireTests": false,
  "minCommentRatio": 0
}
```

政策检查进入决策：许可证不在白名单 → 排除依赖；语言在黑名单 → 候选不可用；要求测试但候选无测试 → 复用降级为"改造 + 补测试"。

### 5. 架构自检（`code_architecture_review`）

对模块/项目做依赖分析：循环依赖（带路径）、超大模块（≥400 行）、扇入/扇出热点，并给出改进建议。完成模块后应运行并修复问题。

## 安装

### 部署级（推荐：所有会话 + 重启后持久生效）

1. 把 `index.mjs` 放到任意目录（如 `~/.dsh/plugins/code-reference/index.mjs`）
2. 在 DSH 配置的 patch 层（如 `~/.dsh/profiles/web/cordis.patch.yml`）追加：

```yaml
- insert:
    - id: code-reference
      name: /绝对路径/index.mjs
```

3. 重启 DSH，所有会话自动获得工具与强制机制

### 动态级（临时，重启失效）

在会话中用 `cordis_define` / `cordis_run` 加载本插件的 host 代码（适用于调试；部署后请勿同时运行，避免工具重名）。

## 工作流程

```
写新文件 → 系统拦截
  ├─ 未检索     → 拒绝：先 local_code_reuse_search（+ 平台检索）
  ├─ 有候选未评估 → 拒绝：先 reuse_value_assessment
  └─ 已评估     → 按决策执行（复用/改造/引入依赖/自制）
模块完成后 → code_architecture_review 自检 → 修复问题再交付
```

## 注意事项

- 未认证 API 限流：GitHub 搜索约 10 次/分钟，工具会返回 `resetAt` 重试时间；可配置 Token 提配额
- 远程检索结果为第三方开源项目，复用必须遵守其许可证（`license` 字段）
- 强制拦截仅作用于 `write` 工具（机制为强约束，非安全边界）

## 许可证

[MIT](./LICENSE)
