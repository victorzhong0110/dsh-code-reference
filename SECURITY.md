# Security Policy

## 威胁模型

本插件是运行在 DeepSeek Harness（DSH）进程内的工程工作流插件，具备 `fs`、`subprocess`、`web`、`sandboxPolicy` 等宿主服务能力。以下为已知面与缓解措施：

### 1. 数据外发（Privacy / Data Exfiltration）

| 面 | 说明 | 缓解 |
|---|---|---|
| 需求关键词外发 | 开启远程搜索时，`reuse_survey` 会把从需求中提取的关键词（`assessWords`，最多 8 个 ASCII/中文词）发往 GitHub/npm 检索 API | 政策文件 `"remoteSearch": false` 或工具参数 `remoteSearch=false` 只做本地调查；README 已提示企业默认关闭 |
| 本地代码进入模型上下文 | 本地扫描会把命中文件的路径、匹配行片段（≤160 字符/行）与系统画像摘要放入工具返回结果，随后进入当前 Agent/模型上下文 | 扫描范围受 `root` 参数限制；自动跳过 `node_modules/.git/dist/vendor/tests/site-packages` 等；单文件读取上限 256KB；**本地源文件不会发送给 GitHub/npm 等任何检索平台** |
| Token 泄漏 | `GITHUB_TOKEN` 环境变量 | `Authorization: Bearer` 仅附加给 `https://api.github.com/` 域名的请求，其他域名（npm 等）不携带；不要把 Token 写入政策文件或提交进 git |

### 2. 命令注入（Command Injection）

所有远程请求通过 `subprocess.spawn` 的**参数数组**调用 `curl`（不使用 shell 拼接）；GitHub `owner/repo` 经 `[^\w.-]` 字符过滤；URL 经 `encodeURIComponent` 编码。没有发现可利用的命令注入路径。若未来扩展 `-H`/URL 拼接，需保持参数数组形式。

### 3. 恶意输入 / 解析健壮性

- 所有 JSON 响应解析均有 try/catch，失败返回错误对象而非抛异常
- 外部返回内容只做长度截断（README 6000 / 文件 8000 字符）后进入上下文
- 扫描对目录/文件读取异常逐个容错（跳过而非中断）

### 4. 权限最小化

- 默认 `reuseMode: "ask"`：插件不自动决定复用，始终由用户确认
- 不拦截/不修改任何文件写入：复用与否完全由用户与模型协商
- 建议在企业环境将扫描根目录严格限定为当前仓库

## 支持的版本

| 版本 | 支持状态 |
|---|---|
| v4.2.x（main） | ✅ 支持 |
| v4.1.x | ✅ 支持 |
| v4.0.x | ⚠️ 仅安全修复 |
| v3.x 及更早 | ❌ 不再维护（升级到 v4.2） |

## 报告漏洞

请勿公开披露。通过 GitHub Issues（`Security` 标签）或直接联系维护者，描述：

1. 影响面（数据外发/注入/DoS）
2. 复现步骤
3. 建议修复

我们会在确认后 7 天内回复，并在修复后按 90 天披露窗口公开。
