# dsh-code-reference

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

DeepSeek Harness (DSH) 代码参考检索与工程规范插件：在**厘清需求之后**自动调查本地与开源的可复用代码，把"候选清单 + 价值权衡"呈现给用户并**询问是否需要复用**（可选择复用哪个候选/改造/不复用直接开发）；也支持配置为不询问、直接优先复用。

除"内容级"复用（相似的函数/组件/项目）外，还支持**架构级复用**：扫描本地已有的业务系统，判断新系统的整体架构能否直接复用（例如要做图书馆检索系统时，本地某个政务文件管理系统可能与其共享"检索与索引/用户与权限/文档与存储/管理后台"等能力，可直接以它为骨架）。

> **定位：候选发现器，不是自动决策器。** 所有匹配度与架构相似度均为关键词/文件名/能力标签重叠的启发式信号，用于生成候选清单供**用户**选择；数据模型、边界与非功能需求兼容性必须由人工确认。

## 核心工作流

```
用户提出开发需求（新组件 / 新项目 / 大型重构）
  → 澄清需求（范围/语言/约束）
  → reuse_survey：自动调查（本地代码库 + 本地系统架构画像 + GitHub 等开源平台）并评估价值权衡
  → 向用户呈现候选清单 + 价值对比，询问是否复用
      （用户选择：以本地系统为骨架 / 复用某个本地候选 / 复用某个开源项目 / 改造 / 直接开发）
  → 按用户选择执行（复用 → 改造 → 引入依赖 → 从零实现）
```

- **小任务豁免（模型工作流规则）**：改单个按钮、修复空指针/拼写缺陷、变量重命名等小型改动（预估 <50 行且不引入新组件/新项目）**不触发**调查与询问，直接修改；需要程序化强制跳过时给 `reuse_survey` 传 `scope="skip"`（返回 `mode="minor-skip"`，不调查不询问）
- **默认询问**：`reuse_survey` 调查后弹出选项（系统骨架 / 本地候选 / 开源候选 / 不复用直接开发），用户决定
- **可选不询问**：公司政策文件配置 `"reuseMode": "auto"`（或工具传 `ask=false`），跳过询问直接采用评估推荐（优先复用）
- **不做强制拦截**：系统不会阻止写文件，复用与否由用户与模型协商决定

## 工具清单

| 工具 | 用途 |
|---|---|
| `reuse_survey` | **主流程**：调查（本地文件 + 本地系统架构 + 开源）→ 价值权衡 → 询问用户是否复用（或 auto 模式直接决策） |
| `architecture_reuse_search` | **架构级复用**：提取需求业务能力标签（15 类），扫描本地系统画像（能力矩阵/规模/语言），按架构相似度排序输出 |
| `local_code_reuse_search` | 本地代码库（公司/项目）中检索可复用的函数/类/组件/模块 |
| `github_reference_search` | GitHub 仓库检索（star 排序、许可证、README） |
| `github_repo_reference` | GitHub 仓库元数据 + README + 关键文件 |
| `gitlab_reference_search` | GitLab.com 项目检索 |
| `gitee_reference_search` | Gitee（码云）仓库检索 |
| `npm_reference_search` | npm 包检索（依赖选型） |
| `reuse_value_assessment` | 独立的价值评估：复用 vs 从零实现的成本对比决策 |
| `code_architecture_review` | 架构自检：循环依赖/超大模块/扇入扇出热点 |

## 架构级复用（v4 新增）

- **15 类业务能力词典**（中英文关键词）：检索与索引 / 元数据与分类 / 用户与权限 / 审批与流程 / 导入导出与批处理 / 报表与统计 / 审计与日志 / 文档与存储 / 资源与借还 / 订单与交易 / 通知与消息 / API 与服务化 / 任务与待办 / 组织与机构 / 管理后台
- **系统画像**：扫描 `root` 下每个顶层业务目录，生成能力矩阵、文件数、行数、语言
- **相似度** = 需求能力标签与系统能力标签的重叠比例，**仅为候选信号**；`reuse_survey` 将相似度 ≥60 的系统列为骨架候选，是否采纳需人工确认
- 选定骨架后建议用 `code_architecture_review` 检查该系统依赖结构是否健康

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
  "reuseMode": "ask",
  "remoteSearch": true
}
```

- `reuseMode: "ask"`（默认）：调查后询问用户；`"auto"`：不询问，直接采用评估推荐决策（优先复用）
- `remoteSearch: true`（默认）：`reuse_survey` 同时检索 GitHub/npm（会把需求关键词发往对应平台）；企业设 `false` 则只做本地调查
- 政策检查进入评估：许可证不在白名单 → 排除依赖；语言在黑名单 → 候选不可用；要求测试但候选无测试 → 复用降级为"改造 + 补测试"

### 企业环境建议配置

仓库附带企业模板 [`.code-reference-policy.enterprise.json`](./.code-reference-policy.enterprise.json)，复制为 `.code-reference-policy.json` 即可：

```json
{
  "allowedLicenses": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "Unlicense", "0BSD"],
  "blockedLanguages": [],
  "requireTests": true,
  "minCommentRatio": 0,
  "reuseMode": "ask",
  "remoteSearch": false
}
```

配套实践：不要用 `reuseMode: "auto"`；把扫描根目录严格限定在当前仓库；只把它当"候选发现器"，不信任绝对评分。

> 安全默认说明：仓库自带的 `.code-reference-policy.json` 未设置 `remoteSearch`（代码缺省为 `true`，个人试用即可外发需求关键词）。**企业环境必须使用上方模板**（`remoteSearch: false` + `requireTests: true`）并纳入代码审查。

## GitHub API 限流与 Token

未认证的 GitHub 搜索 API 约 10 次/分钟。设置环境变量可显著提高配额（5000 次/小时）：

```bash
export DSH_GITHUB_TOKEN=ghp_xxxxxxxx        # 或 GITHUB_TOKEN
```

插件会自动在 `api.github.com` 请求上附加 `Authorization: Bearer`，**不会**附加给 npm 等其他域名。Token 请勿写入政策文件或提交进 git（参见 [SECURITY.md](./SECURITY.md) 威胁模型）。

## 测试与 CI

- 单元测试：`node --test test/core.test.mjs test/decision.test.mjs`（67 个用例，node:test 零依赖）——core：纯函数、扫描边界（SKIP_DIRS/大小/fileBudget/扩展名）、远程 API mock（Token 携带与隔离、多档重试、端到端评估）；decision：政策优先级（reuseMode/remoteSearch）、询问超时、`no-candidates`、`auto-fallback`、用户选择映射、`scope="skip"` 程序化豁免、宿主加载冒烟
- CI：GitHub Actions（Node 20/22，actions 按 commit SHA 固定）自动运行语法检查 + 单测 + 政策 JSON 校验

## 安装

### 一键安装（`dsh plugin add`，推荐新用户）

本仓库声明了 `dsh.bundle` manifest，可用 DSH 官方插件机制安装（任何目录下）：

```sh
git clone --branch v4.2.1 --depth 1 https://github.com/victorzhong0110/dsh-code-reference.git
dsh plugin --profile web add ./dsh-code-reference
```

卸载：`dsh plugin --profile web remove dsh-code-reference`。也可通过 [dsh-market](https://github.com/dsh-market/dsh-market#readme) 插件市场一键安装。

### 固定版本（推荐）

永远不要跟随 `main` 分支。固定到正式 Release 的 tag（带附件 `plugins/*.mjs` + `SHA256SUMS`）：

```bash
# 方式 A：tag（如 v4.2.1）
git clone --branch v4.2.1 --depth 1 https://github.com/victorzhong0110/dsh-code-reference.git

# 方式 B：固定 commit
git clone https://github.com/victorzhong0110/dsh-code-reference.git
cd dsh-code-reference && git checkout <commit-sha>
```

校验文件完整性（仓库根目录 `SHA256SUMS` 或 Release 附件）：

```bash
shasum -a 256 -c SHA256SUMS
```

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

## 架构（拆分为三个小插件，通过 codeRef 服务协作）

| 插件 | 职责 | 文件 |
|---|---|---|
| `code-ref-core` | 共享服务（HTTP 请求、本地扫描、系统画像与架构相似度、候选评估、政策、决策引擎；v4.1 起为依赖注入工厂 + 顶层纯函数，可单测） | `plugins/core.mjs` |
| `code-ref-tools` | 7 个检索/架构工具 + 架构自检 | `plugins/tools.mjs` |
| `code-ref-decision` | 复用价值评估 + 复用调查询问（含系统骨架候选）+ 工程规范提示词 | `plugins/decision.mjs` |

## 注意事项

- **隐私**：远程搜索会把需求关键词发往 GitHub/npm；本地扫描受 `root` 限制并跳过 `node_modules/.git/dist/vendor/tests/site-packages` 等目录。**本地源文件不会发送给任何检索平台**；命中路径、最长 160 字符的代码片段及系统画像会进入当前 Agent/模型上下文（详见 [SECURITY.md](./SECURITY.md) 威胁模型）
- 远程检索结果为第三方开源项目，复用必须遵守其许可证（`license` 字段）
- 询问等待上限 90 秒（无真人应答的上下文会自动跳过询问并采用推荐决策）
- `reuse_survey` 返回 `answer.status="unanswered"`（未回答/超时）时，模型**不得**开始写代码，须先报告调查结果等待用户决定

## 反馈与贡献

当前状态：**可靠的 beta / 可用于企业内部试点**。距离稳定 GA 主要差真实 DSH 环境端到端测试、长期兼容性验证和更多实际项目反馈。

欢迎任何反馈：试用问题、兼容性报告、新平台/新语言支持需求、架构复用场景案例。请发送邮件至 **victorzhong0110@gmail.com**，或在 GitHub Issues 中提出。

## 许可证

[MIT](./LICENSE)
