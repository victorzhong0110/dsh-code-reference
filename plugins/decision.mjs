// dsh-code-reference 复用决策工具 + 提示词（与动态版 crfdc-4/pkg-26 一致）
export default {
  name: 'code-ref-decision',
  inject: ['codeRef', 'timer', 'systemPrompt', 'userQuestions'],
  apply(ctx) {
    const ref = ctx.codeRef
    const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    let pendingAsk = null

    ctx.tools.register({
      name: 'reuse_value_assessment',
      description:
        '评估"复用已有代码"与"从零实现"的价值对比，给出结构化决策。'
        + '复用判断标准：只有当复用的总成本（改造工作量 + 质量风险 + 集成成本）显著低于从零实现的成本时才复用。'
        + '对本地候选量化：需求匹配度（0-100）、代码规模、复杂度、注释比、测试覆盖信号、改造工作量估计；'
        + '对开源候选量化：描述匹配度、维护活跃度（最近更新距今）、许可证、star。'
        + '阈值可调：reuseThreshold（默认 70）/ adaptThreshold（默认 40）/ remoteThreshold（默认 50）/ smallLines（默认 300）/ mediumLines（默认 800）/ maxComplexityPercent（默认 12）。'
        + '支持公司政策：默认按顺序查找 显式 policyPath → 工作区根 → 本地候选目录向上 3 层的 .code-reference-policy.json，'
        + '字段：allowedLicenses（许可证白名单）、blockedLanguages（禁止语言）、requireTests（必须带测试）、minCommentRatio（最低注释比 0-1）、reuseMode（ask 询问 / auto 自动优先复用）。'
        + '输出决策：reuse（直接复用）/ adapt（改造复用）/ dependency（引入依赖）/ rewrite（自制）。'
        + '提示：requirement 描述建议同时包含英文术语关键词，中文词对英文代码库的匹配信号较弱。',
      parameters: {
        type: 'object',
        properties: {
          requirement: { type: 'string', description: '目标需求/功能描述（建议含英文术语关键词），评估的基准，如 "带语法高亮的 markdown 编辑器 syntax highlighting markdown editor"' },
          localCandidates: { type: 'string', description: '本地候选文件路径，逗号分隔（通常取自 local_code_reuse_search 的 matches[].path）' },
          remoteCandidate: { type: 'string', description: '单个开源候选：owner/repo、https://github.com/owner/repo 或 npm:包名' },
          reuseThreshold: { type: 'integer', description: '直接复用匹配度阈值，默认 70（1-100）' },
          adaptThreshold: { type: 'integer', description: '改造复用匹配度阈值，默认 40（1-100，须 <= reuseThreshold）' },
          remoteThreshold: { type: 'integer', description: '远程候选匹配度阈值，默认 50（1-100）' },
          smallLines: { type: 'integer', description: '低改造成本的行数上限，默认 300' },
          mediumLines: { type: 'integer', description: '中等改造成本的行数上限，默认 800' },
          maxComplexityPercent: { type: 'integer', description: '低改造成本的复杂度上限（百分比），默认 12' },
          policyPath: { type: 'string', description: '公司政策文件路径（JSON）；省略时自动查找工作区与候选目录' },
        },
        required: ['requirement'],
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: 60000,
      presentCall: (args) => ({ card: 'generic', kind: 'read', title: '复用价值评估: ' + String((args && args.requirement) || '') }),
      async execute(args, exec) {
        const requirement = ref.safeQuery(args.requirement)
        if (requirement === '') throw new Error('requirement 不能为空')
        const words = ref.assessWords(requirement)
        if (words.length === 0) return { ok: false, message: 'requirement 中未找到有效关键词（描述过短或全为停用词）' }
        const cfg = ref.defaultConfig(args)
        const localPaths = String(args.localCandidates || '').split(',').map((p) => p.trim()).filter(Boolean).slice(0, 5)
        const result = await ref.assessCandidates(requirement, localPaths, args.remoteCandidate ? [args.remoteCandidate] : [], cfg, exec.signal)
        if (result.error) return { ok: false, message: result.error }
        return {
          ok: true,
          provider: 'reuse-assessment',
          requirement,
          thresholds: cfg,
          judgmentStandard: '复用价值判断标准（当前阈值）：1) 匹配度 >=' + cfg.reuseThreshold + ' 且改造成本低 → 直接复用；2) 匹配度 ' + cfg.adaptThreshold + '-' + (cfg.reuseThreshold - 1) + ' → 改造复用（改造工作量 < 从零实现的 1/2 时划算）；3) 开源候选维护活跃且匹配 >=' + cfg.remoteThreshold + ' → 引入依赖（需通过公司许可证政策）；4) 其余情况 → 自制。阈值可通过工具参数调整。',
          policy: result.policy,
          policyChecks: result.checks,
          localCandidates: result.locals,
          remoteCandidate: result.bestRemote || null,
          decision: result.decision,
        }
      },
    })

    ctx.tools.register({
      name: 'reuse_survey',
      description:
        '复用调查（需求澄清后调用）：先自动调查本地代码库与开源平台的可复用候选并评估价值权衡，'
        + '然后把"候选清单 + 价值对比"呈现给用户并询问是否复用（用户可选择复用哪个候选/改造/不复用直接开发）。'
        + '同时做架构级复用调查：扫描本地已有业务系统（顶层目录）画像，找出与新需求能力重叠度高的系统作为整体架构骨架候选。'
        + '若政策文件配置 reuseMode="auto"（或传 ask=false）则不询问，直接采用评估给出的推荐决策（优先复用）。'
        + '若无任何候选则不弹窗（mode=no-candidates，推荐 rewrite）。'
        + '注意：若返回 answer.status="unanswered"（用户未回答/询问超时），不得开始写代码，应先把调查结果报告给用户并等待其决定。'
        + '适合在澄清需求之后、开始写代码之前调用一次。'
        + '小任务豁免：改单个按钮、修复空指针/拼写缺陷、变量重命名等小型改动（预估 <50 行且不引入新组件/新项目）是"模型工作流豁免"——'
        + '由模型直接修改、不调用本工具；如需程序化强制跳过调查，可传 scope="skip"（返回 mode="minor-skip"，不调查不询问）。'
        + '隐私提示：远程搜索（GitHub/npm）会把需求中提取的关键词发送到对应平台；企业环境可在政策文件设 remoteSearch=false（或传 remoteSearch=false）只做本地调查。'
        + '本地源文件不会发送给 GitHub/npm 等检索平台；命中路径、最长 160 字符的代码片段及系统画像会进入当前 Agent/模型上下文。',
      parameters: {
        type: 'object',
        properties: {
          requirement: { type: 'string', description: '目标需求/功能描述（建议含英文术语关键词），调查与评估的基准' },
          root: { type: 'string', description: '本地检索根目录（绝对路径），其下每个顶层业务目录视为一个系统；省略时使用当前工作区根目录' },
          scope: { type: 'string', enum: ['auto', 'skip'], default: 'auto', description: '任务范围：skip = 小任务程序化豁免（不调查不询问，返回 mode="minor-skip"）；默认 auto 正常调查' },
          remoteSearch: { type: 'boolean', default: true, description: '是否同时调查开源平台（GitHub/npm 等），默认 true' },
          ask: { type: 'boolean', description: '是否询问用户；省略时读政策 reuseMode（默认询问）；false 时不询问直接返回推荐决策' },
          reuseThreshold: { type: 'integer', description: '直接复用匹配度阈值，默认 70' },
          adaptThreshold: { type: 'integer', description: '改造复用匹配度阈值，默认 40' },
          remoteThreshold: { type: 'integer', description: '远程候选匹配度阈值，默认 50' },
        },
        required: ['requirement'],
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: 150000,
      presentCall: (args) => ({ card: 'generic', kind: 'read', title: '复用调查: ' + String((args && args.requirement) || '') }),
      async execute(args, exec) {
        const requirement = ref.safeQuery(args.requirement)
        if (requirement === '') throw new Error('requirement 不能为空')

        // 程序化小任务豁免：scope="skip" 直接跳过调查与询问（不读文件、不访问网络、不弹窗）
        if (String(args.scope || '') === 'skip') {
          return {
            ok: true,
            provider: 'reuse-survey',
            requirement,
            mode: 'minor-skip',
            note: '小任务豁免已触发（scope=skip）：跳过调查与询问，可直接开始开发。',
            survey: '小任务豁免：未进行调查（scope=skip）。按小改动直接处理，如需复用评估请去掉 scope 参数重跑。',
            systemCandidates: [],
            localCandidates: [],
            remoteCandidates: [],
            policyChecks: [],
            decision: { choice: 'rewrite', confidence: 'high', reason: '小任务豁免（scope=skip），未评估候选；直接开发。' },
            answer: { status: 'skipped', reason: 'minor-scope' },
          }
        }

        const cfg = ref.defaultConfig(args)
        const words = ref.assessWords(requirement)

        const local = await ref.collectLocalCandidates(requirement, args.root, exec.signal, { fileBudget: 1200, timeBudgetMs: 15000 })
        if (local.error) return { ok: false, message: local.error }
        const localPaths = local.candidates.slice(0, 5).map((c) => c.path)

        // 远程搜索默认值：显式参数 > 政策文件 remoteSearch（默认 true，企业可设 false 仅本地调查）
        const prePolicy = await ref.loadPolicy(undefined, localPaths, exec.signal)
        const remoteSearchDefault = prePolicy && prePolicy.data ? prePolicy.data.remoteSearch !== false : true
        const doRemoteSearch = args.remoteSearch === undefined ? remoteSearchDefault : args.remoteSearch === true

        let remoteSpecs = []
        if (doRemoteSearch) {
          remoteSpecs = await ref.githubSearchCandidates(words, exec.signal)
        }

        const result = await ref.assessCandidates(requirement, localPaths, remoteSpecs, cfg, exec.signal)
        if (result.error) return { ok: false, message: result.error }

        // 架构级复用：扫描本地系统画像，找出可作为整体骨架的系统候选（候选发现器，阈值 60 较保守）
        const systemCandidates = []
        let rootPath = String(args.root || '').trim()
        if (!rootPath) rootPath = ctx.sandboxPolicy.workspaceRoot || ''
        if (rootPath) {
          const reqLabels = ref.capabilityLabelsOf(requirement)
          if (reqLabels.length > 0) {
            const profile = await ref.extractSystemProfile(rootPath, exec.signal, { maxSystems: 10, timeBudgetMs: 15000 })
            if (!profile.error && profile.systems.length > 0) {
              for (const s of profile.systems) {
                const sim = ref.architectureSimilarity(reqLabels, s.capabilities)
                if (sim.similarity >= 60) {
                  systemCandidates.push(Object.assign({}, s, { similarity: sim.similarity, overlap: sim.overlap, missing: sim.missing }))
                }
              }
              systemCandidates.sort((a, b) => b.similarity - a.similarity)
            }
          }
        }
        const hasSystemCandidates = systemCandidates.length > 0

        const hasCandidates = result.locals.some((l) => !l.error && l.verdict !== 'not-suitable')
          || result.remotes.some((r) => !r.blocked)
          || hasSystemCandidates

        const lines = []
        lines.push('需求：' + requirement)
        if (hasSystemCandidates) {
          lines.push('本地系统骨架候选（架构级复用，相似度 >=60，候选发现器定位）：')
          for (const s of systemCandidates) {
            lines.push('  - ' + s.name + '：架构相似度 ' + s.similarity + '/100（能力标签重叠比例，需人工确认数据模型/边界兼容后决定），能力 ' + s.capabilities.join('、') + '，' + s.files + ' 文件 / ' + s.lines + ' 行 / ' + s.languages.join(', '))
          }
        }
        if (result.locals.length > 0) {
          lines.push('本地文件候选（' + result.locals.length + ' 个）：')
          for (const l of result.locals) {
            if (l.error) {
              lines.push('  - ' + l.path + '：' + l.error)
              continue
            }
            lines.push('  - ' + l.path + '：匹配 ' + l.matchScore + '/100，' + l.lines + ' 行，改造 ' + (l.effort ? l.effort.estimate : '未知') + '，判定 ' + (l.verdict || 'n/a'))
          }
        } else {
          lines.push('本地未发现相关候选。')
        }
        if (result.remotes.length > 0) {
          for (const r of result.remotes.slice(0, 3)) {
            lines.push('开源候选：' + (r.fullName || r.name) + '（匹配 ' + r.matchScore + '/100，' + (r.active ? '维护活跃' : '维护沉寂') + '，许可证 ' + (r.license || '未知') + '，' + (r.stars || 0) + ' stars' + (r.blocked ? '，被公司政策排除' : '') + '）')
            if (r.description) lines.push('          描述：' + String(r.description).slice(0, 80))
          }
        } else if (doRemoteSearch) {
          lines.push('开源平台未找到匹配候选（可尝试更具体的关键词，或用 github_reference_search 单独检索）。')
        }
        if (result.policy && result.policy.note) lines.push('政策：' + result.policy.note)
        for (const c of result.checks) lines.push('政策检查[' + c.status + '] ' + c.detail)
        lines.push('推荐决策：' + result.decision.choice + '（' + result.decision.confidence + '）— ' + result.decision.reason)
        const summary = lines.join('\n')

        const policyMode = result.policy && result.policy.data ? result.policy.data.reuseMode : 'ask'
        const shouldAsk = args.ask === undefined ? policyMode !== 'auto' : args.ask === true

        if (!hasCandidates) {
          return {
            ok: true,
            provider: 'reuse-survey',
            requirement,
            mode: 'no-candidates',
            note: '未找到任何可复用候选（含系统骨架），无需询问；推荐按评估决策（通常为自制）直接开发。',
            survey: summary,
            systemCandidates,
            localCandidates: result.locals,
            remoteCandidates: result.remotes.slice(0, 3),
            policyChecks: result.checks,
            decision: result.decision,
            answer: { status: 'skipped', reason: 'no-candidates' },
          }
        }

        let answer = null
        if (shouldAsk) {
          if (pendingAsk) {
            answer = { status: 'unanswered', reason: 'previous-pending', error: '上一次复用询问仍在等待回答（90 秒超时）。请先回答旧询问，或改用 ask=false 跳过询问。' }
          } else {
            const uq = ctx.userQuestions
            if (uq === undefined) {
              return {
                ok: true,
                provider: 'reuse-survey',
                requirement,
                mode: 'auto-fallback',
                note: '用户询问服务不可用（当前上下文无法询问），已按推荐决策返回',
                survey: summary,
                systemCandidates,
                localCandidates: result.locals,
                remoteCandidates: result.remotes.slice(0, 3),
                policyChecks: result.checks,
                decision: result.decision,
                answer: { status: 'unanswered', reason: 'ask-unavailable' },
              }
            }
            const options = []
            for (const s of systemCandidates) {
              options.push({
                label: '以本地系统 ' + s.name + ' 为骨架开发（架构相似度 ' + s.similarity + '/100）',
                description: s.path + '：能力 ' + s.capabilities.join('、') + '；复用其整体架构（模块划分/数据模型/权限模型）后替换业务模块',
              })
            }
            for (const l of result.locals) {
              if (l.error || l.verdict === 'not-suitable') continue
              const base = l.path.split('/').pop()
              options.push({
                label: '复用本地 ' + base + '（匹配 ' + l.matchScore + '/100，' + (l.effort ? l.effort.estimate : '') + '）',
                description: l.path,
              })
            }
            for (const r of result.remotes.slice(0, 3)) {
              if (r.blocked) continue
              options.push({
                label: '复用开源 ' + (r.fullName || r.name) + '（匹配 ' + r.matchScore + '/100）',
                description: '许可证 ' + (r.license || '未知') + '，' + (r.stars || 0) + ' stars' + (r.active ? '，维护活跃' : ''),
              })
            }
            options.push({ label: '不复用，直接开发', description: '按从零实现处理（评估建议为 rewrite 时的默认选项）' })
            try {
              const askPromise = (async () => {
                const res = await uq.ask({
                  questions: [{
                    id: 'reuse-choice',
                    header: '复用调查结果',
                    question: '是否需要复用已有代码（或已有系统的架构骨架）？以下是调查与价值权衡：',
                    detail: summary,
                    options,
                  }],
                  agent: exec.agent,
                  signal: exec.signal,
                })
                const item = res && res.answers && res.answers[0]
                return item ? { status: 'answered', selected: item.selected || [], custom: item.custom || '' } : { status: 'answered', selected: [], custom: '' }
              })()
              pendingAsk = askPromise
              const askResult = await Promise.race([
                askPromise,
                new Promise((resolve) => {
                  ctx.timeout(() => resolve({ status: 'unanswered', reason: 'timeout' }), 90000)
                }),
              ])
              if (askResult && askResult.reason === 'timeout') {
                answer = { status: 'unanswered', reason: 'timeout', error: '等待用户回答超时（90 秒）。未获用户确认前不得开始写代码；请向用户报告调查结果并等待其决定。' }
              } else {
                answer = askResult
              }
            } catch (error) {
              answer = { status: 'unanswered', reason: 'error', error: String((error && error.message) || error) }
            } finally {
              pendingAsk = null
            }
          }
        }

        return {
          ok: true,
          provider: 'reuse-survey',
          requirement,
          mode: shouldAsk ? 'ask' : 'auto',
          survey: summary,
          systemCandidates,
          localCandidates: result.locals,
          remoteCandidates: result.remotes.slice(0, 3),
          policyChecks: result.checks,
          decision: result.decision,
          answer,
        }
      },
    })

    ctx.systemPrompt.section({
      name: 'tool:code-reference',
      order: 120,
      text:
        'CODE REUSE WORKFLOW (code-reference):\n'
        + '1. CLARIFY REQUIREMENTS FIRST, THEN SURVEY, THEN ASK. When the user asks you to develop a new project, '
        + 'component, or feature, first clarify the requirements (scope, language, constraints). After the '
        + 'requirements are clear, run the reuse_survey tool once before writing code: it investigates the local '
        + 'codebase (local_code_reuse_search logic) and open-source platforms (GitHub etc. via keyword extraction), '
        + 'evaluates the reuse-vs-rewrite value tradeoff (reuse_value_assessment logic), and then ASKS the user '
        + 'which candidate to reuse (or whether to skip reuse and build from scratch) with the tradeoffs shown. '
        + 'Follow the user\'s choice.\n'
        + 'MINOR TASKS EXEMPTION (workflow-level, not plugin-enforced): do NOT run reuse_survey for small '
        + 'changes — tweaking a single button, fixing a null pointer/typo bug, renaming a variable, or any '
        + 'edit estimated under 50 lines that introduces no new component or new project. Just make the edit '
        + 'directly; the survey flow is for new components, new projects, and substantial refactors where '
        + 'reuse actually pays off. If you need a programmatic skip, call reuse_survey with scope="skip" '
        + '(returns mode="minor-skip", no survey, no prompt).\n'
        + 'CANDIDATE DISCOVERY, NOT VERDICT: all match scores and architecture similarities are heuristic signals '
        + 'computed from keywords/file names/capability-label overlap. They generate a candidate shortlist for '
        + 'the user to choose from; they never replace human judgment about data models, boundaries, or '
        + 'non-functional compatibility. Always present candidates with tradeoffs and let the user decide.\n'
        + 'PRIVACY: remote search (GitHub/npm) sends requirement-derived keywords to those platforms; if the '
        + 'policy file sets remoteSearch=false (or the user passes remoteSearch=false), run the local survey '
        + 'only. Local source files are never sent to GitHub/npm or any retrieval platform; matched paths, '
        + 'up-to-160-char code snippets, and system profiles do enter the current agent/model context. Local '
        + 'scans are bounded by the root parameter and skip node_modules/.git/dist/vendor/tests/site-packages.\n'
        + 'Architecture-level reuse: besides finding similar implementations, also check whether an existing '
        + 'local system\'s overall architecture can be reused as the skeleton for the new system. For example, a '
        + 'library retrieval system may share capabilities (search & indexing, user & permissions, document & '
        + 'storage, admin backend) with a government document management system built earlier, so that system can '
        + 'serve as the skeleton. reuse_survey and architecture_reuse_search scan local top-level business '
        + 'directories, extract capability labels (15 categories), and rank systems by capability-overlap '
        + 'similarity; ask the user whether to build on one as the skeleton before writing code.\n'
        + 'CRITICAL: if reuse_survey returns answer.status === "unanswered" (user did not answer, question timed '
        + 'out, or the question could not be shown), you MUST NOT start writing code. Report the survey results '
        + 'and candidate list to the user in your reply and wait for the user to explicitly choose a candidate '
        + '(or say to proceed from scratch). Only after the user has decided may you start implementing. If '
        + 'mode is "no-candidates", no candidates exist and proceeding with the recommended decision (usually '
        + 'rewrite) is fine without asking. If the company policy file (.code-reference-policy.json) sets '
        + 'reuseMode="auto" (or the user prefers no asking), skip the question and adopt the recommended '
        + 'decision directly, preferring reuse.\n'
        + '2. You may also call the individual tools directly when needed: local_code_reuse_search, '
        + 'github_reference_search / github_repo_reference / gitlab_reference_search / gitee_reference_search / '
        + 'npm_reference_search for searching, reuse_value_assessment for a standalone value judgment. Judgment '
        + 'standard: reuse only when its total cost (adaptation + risk + integration) is clearly below rewriting — '
        + 'matchScore >=70 with low adaptation effort means reuse; 40-69 means adapt (worthwhile when adaptation '
        + '< half the rewrite); active + well-matching open-source candidate means dependency; otherwise rewrite. '
        + 'Thresholds are adjustable; a company policy file may restrict licenses/languages and require tests.\n'
        + '3. HIGH COHESION / LOW COUPLING. Keep every module focused on one responsibility; depend on abstractions, '
        + 'not implementations; never create circular imports; keep cross-module surface minimal; extract shared '
        + 'logic instead of duplicating it; prefer small, composable modules over large god-modules.\n'
        + '4. ARCHITECTURE SELF-CHECK. After completing a module or project, run code_architecture_review on it and '
        + 'fix reported cycles, oversized modules, or coupling hotspots before declaring the work done.\n'
        + '5. LICENSE COMPLIANCE. Reuse is advisory: respect each repository/package license (returned as the '
        + 'license field), never copy code unless the license permits it, and prefer maintained, actively updated projects.',
    })
  },
}
