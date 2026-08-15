// dsh-code-reference 检索与架构工具（与动态版 crfts-3/pkg-25 一致）
export default {
  name: 'code-ref-tools',
  inject: ['codeRef', 'subprocess', 'web', 'fs', 'sandboxPolicy'],
  apply(ctx) {
    const ref = ctx.codeRef
    const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

    ctx.tools.register({
      name: 'github_reference_search',
      description:
        '在 GitHub 上检索公开可复用的开源项目/组件，作为新组件、新项目开发的参考资料（GitHub 为主，另有 gitlab_reference_search / gitee_reference_search / npm_reference_search 覆盖其他平台）。'
        + '适合在开始实现一个功能（如 markdown 编辑器、认证、CLI 脚手架、状态管理、ORM、UI 组件、文件处理等）之前先调用。'
        + '返回按 star 数排序的仓库列表（全名、URL、描述、语言、许可证、star/fork 数、更新时间、主题标签等），可选附带第一名仓库的 README。'
        + '注意：检索结果为第三方开源项目，仅供参考，复用必须遵守其许可证。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '描述目标组件或功能的检索关键词，例如 "react markdown editor"、"typescript cli scaffold"、"oauth2 middleware"' },
          language: { type: 'string', description: '按主语言过滤，例如 TypeScript、Python、Go、Rust（大小写不敏感，可省略）' },
          sort: { type: 'string', enum: ['stars', 'updated', 'forks', 'help-wanted-issues'], default: 'stars', description: '排序方式，默认 stars（star 数降序）' },
          limit: { type: 'integer', default: 5, description: '返回仓库数量，1-10，默认 5' },
          includeReadme: { type: 'boolean', default: false, description: '为 true 时同时获取第一个结果的 README 内容（截断至 6000 字符）' },
        },
        required: ['query'],
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: 60000,
      presentCall: (args) => ({ card: 'generic', kind: 'read', title: 'GitHub 参考检索: ' + String((args && args.query) || '') }),
      async execute(args, exec) {
        const query = ref.safeQuery(args.query)
        if (query === '') throw new Error('query 不能为空')
        const limit = ref.clampLimit(args.limit)
        const sort = ['updated', 'forks', 'help-wanted-issues'].indexOf(String(args.sort || '')) >= 0 ? String(args.sort) : 'stars'
        let qualifiers = 'archived:false'
        if (args.language) {
          const lang = String(args.language).replace(/[^A-Za-z0-9+#.-]/g, '')
          if (lang) qualifiers += ' language:' + lang
        }
        const r = await ref.apiRequest('https://api.github.com/search/repositories?q='
          + encodeURIComponent(query + ' ' + qualifiers) + '&sort=' + sort + '&order=desc&per_page=' + limit,
          { signal: exec.signal })
        if (r.error) return ref.webSearchFallback('github', 'github open source', query, limit, exec.signal)
        if (r.status !== 200) return ref.apiError(r, 'GitHub 仓库检索失败')
        const parsed = ref.parseJson(r)
        if (!parsed || !Array.isArray(parsed.items)) return { ok: false, status: r.status, message: 'GitHub 返回了无法解析的检索结果' }
        const results = parsed.items.map((item) => ({
          fullName: item.full_name || '',
          url: item.html_url || '',
          description: item.description || '',
          stars: item.stargazers_count || 0,
          forks: item.forks_count || 0,
          language: item.language || '',
          topics: Array.isArray(item.topics) ? item.topics : [],
          license: item.license && item.license.spdx_id ? item.license.spdx_id : '',
          updatedAt: item.updated_at || '',
          archived: Boolean(item.archived),
          homepage: item.homepage || '',
        }))
        const out = {
          ok: true,
          provider: 'github',
          query,
          totalCount: parsed.total_count || 0,
          results,
          rateLimit: ref.rateLimitInfo(r),
        }
        if (args.includeReadme === true && results.length > 0) {
          const parts = results[0].fullName.split('/')
          const rd = await ref.apiRequest('https://api.github.com/repos/' + parts[0] + '/' + parts[1] + '/readme', {
            accept: 'application/vnd.github.raw+json',
            signal: exec.signal,
          })
          out.topReadme = rd.status === 200 && rd.body ? rd.body.slice(0, ref.README_CHARS) : null
        }
        return out
      },
    })

    ctx.tools.register({
      name: 'github_repo_reference',
      description:
        '查看 GitHub 上某个具体仓库的元数据、README 与关键文件内容，用于深入学习一个开源项目作为参考实现。'
        + '适合在 github_reference_search 找到候选仓库之后调用。返回仓库描述、star/fork、语言、许可证、主题标签、'
        + 'README（截断至 6000 字符），以及可选的若干文件内容（每个截断至 8000 字符，最多 3 个）。',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织，例如 facebook' },
          repo: { type: 'string', description: '仓库名，例如 react' },
          includeReadme: { type: 'boolean', default: true, description: '是否获取 README 内容（截断至 6000 字符）' },
          paths: { type: 'string', description: '可选：逗号分隔的仓库内文件路径（最多 3 个），如 "package.json,src/index.ts"；单个文件超过 1MB 时 GitHub 会拒绝返回' },
        },
        required: ['owner', 'repo'],
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: 45000,
      presentCall: (args) => ({ card: 'generic', kind: 'read', title: 'GitHub 仓库参考: ' + String((args && args.owner) || '') + '/' + String((args && args.repo) || '') }),
      async execute(args, exec) {
        const owner = String(args.owner || '').trim().replace(/[^\w.-]/g, '')
        const repo = String(args.repo || '').trim().replace(/[^\w.-]/g, '')
        if (!owner || !repo) throw new Error('owner 与 repo 必须为非空字符串')
        const meta = await ref.apiRequest('https://api.github.com/repos/' + owner + '/' + repo, { signal: exec.signal })
        if (meta.error) return { ok: false, message: meta.message }
        if (meta.status === 404) {
          return { ok: false, status: 404, message: '仓库 ' + owner + '/' + repo + ' 不存在或为私有仓库', rateLimit: ref.rateLimitInfo(meta) }
        }
        if (meta.status !== 200) return ref.apiError(meta, '获取仓库信息失败')
        const m = ref.parseJson(meta)
        if (!m) return { ok: false, status: meta.status, message: 'GitHub 返回了无法解析的仓库信息' }
        const out = {
          ok: true,
          provider: 'github',
          fullName: m.full_name || owner + '/' + repo,
          url: m.html_url || '',
          description: m.description || '',
          stars: m.stargazers_count || 0,
          forks: m.forks_count || 0,
          language: m.language || '',
          license: m.license && m.license.spdx_id ? m.license.spdx_id : '',
          topics: Array.isArray(m.topics) ? m.topics : [],
          homepage: m.homepage || '',
          defaultBranch: m.default_branch || 'main',
          archived: Boolean(m.archived),
          createdAt: m.created_at || '',
          updatedAt: m.updated_at || '',
          rateLimit: ref.rateLimitInfo(meta),
        }
        if (args.includeReadme !== false) {
          const rd = await ref.apiRequest('https://api.github.com/repos/' + owner + '/' + repo + '/readme', {
            accept: 'application/vnd.github.raw+json',
            signal: exec.signal,
          })
          out.readme = rd.status === 200 && rd.body ? rd.body.slice(0, ref.README_CHARS) : null
        }
        if (args.paths) {
          const wanted = String(args.paths).split(',').map((p) => p.trim()).filter(Boolean).slice(0, ref.MAX_FILES)
          out.files = []
          for (const p of wanted) {
            const fr = await ref.apiRequest('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + ref.encodePath(p), {
              accept: 'application/vnd.github.raw+json',
              signal: exec.signal,
            })
            if (fr.status === 200 && fr.body) {
              out.files.push({ path: p, text: fr.body.slice(0, ref.FILE_CHARS), truncated: fr.body.length > ref.FILE_CHARS })
            } else {
              out.files.push({ path: p, text: null, error: '无法获取（HTTP ' + fr.status + '，文件可能超过 1MB 或路径不存在）' })
            }
          }
        }
        return out
      },
    })

    ctx.tools.register({
      name: 'gitlab_reference_search',
      description:
        '在 GitLab.com 上检索公开项目作为参考。按 star 数排序返回项目列表（命名空间、URL、描述、star/fork、主题标签、最后活动时间）。'
        + '注意：检索结果为第三方开源项目，仅供参考，复用必须遵守其许可证。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '描述目标组件或功能的检索关键词，如 "markdown editor"、"ci pipeline"' },
          limit: { type: 'integer', default: 5, description: '返回项目数量，1-10，默认 5' },
        },
        required: ['query'],
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: 40000,
      presentCall: (args) => ({ card: 'generic', kind: 'read', title: 'GitLab 参考检索: ' + String((args && args.query) || '') }),
      async execute(args, exec) {
        const query = ref.safeQuery(args.query)
        if (query === '') throw new Error('query 不能为空')
        const limit = ref.clampLimit(args.limit)
        const r = await ref.apiRequest('https://gitlab.com/api/v4/projects?search=' + encodeURIComponent(query)
          + '&order_by=star_count&sort=desc&per_page=' + limit + '&simple=true',
          { signal: exec.signal })
        if (r.error) return ref.webSearchFallback('gitlab', 'site:gitlab.com', query, limit, exec.signal)
        if (r.status !== 200) return ref.apiError(r, 'GitLab 检索失败')
        const parsed = ref.parseJson(r)
        if (!Array.isArray(parsed)) return { ok: false, status: r.status, message: 'GitLab 返回了无法解析的检索结果' }
        return {
          ok: true,
          provider: 'gitlab',
          query,
          results: parsed.map((p) => ({
            fullName: p.path_with_namespace || p.name_with_namespace || '',
            url: p.web_url || '',
            description: p.description || '',
            stars: p.star_count || 0,
            forks: p.forks_count || 0,
            topics: Array.isArray(p.topics) ? p.topics : [],
            updatedAt: p.last_activity_at || '',
          })),
          rateLimit: ref.rateLimitInfo(r),
        }
      },
    })

    ctx.tools.register({
      name: 'gitee_reference_search',
      description:
        '在 Gitee（码云）上检索公开仓库作为参考（适合中文开源生态、国内镜像场景）。按 star 数排序返回仓库列表'
        + '（全名、URL、描述、语言、许可证、star/fork、更新时间）。注意：Gitee 匿名 API 有风控，可能返回空结果；'
        + '此时可改用 github_reference_search 检索同类项目。检索结果为第三方开源项目，仅供参考，复用必须遵守其许可证。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '描述目标组件或功能的检索关键词，如 "markdown 编辑器"、"低代码"、"vue admin"' },
          limit: { type: 'integer', default: 5, description: '返回仓库数量，1-10，默认 5' },
        },
        required: ['query'],
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: 40000,
      presentCall: (args) => ({ card: 'generic', kind: 'read', title: 'Gitee 参考检索: ' + String((args && args.query) || '') }),
      async execute(args, exec) {
        const query = ref.safeQuery(args.query)
        if (query === '') throw new Error('query 不能为空')
        const limit = ref.clampLimit(args.limit)
        const r = await ref.apiRequest('https://gitee.com/api/v5/search/repositories?q=' + encodeURIComponent(query)
          + '&sort=stars_count&order=desc&per_page=' + limit,
          { signal: exec.signal })
        if (r.error) return ref.webSearchFallback('gitee', 'site:gitee.com', query, limit, exec.signal)
        if (r.status !== 200) return ref.apiError(r, 'Gitee 检索失败')
        const parsed = ref.parseJson(r)
        if (!Array.isArray(parsed)) return { ok: false, status: r.status, message: 'Gitee 返回了无法解析的检索结果' }
        if (parsed.length === 0) {
          return {
            ok: true,
            provider: 'gitee',
            query,
            totalCount: 0,
            results: [],
            note: 'Gitee 匿名 API 返回空结果（可能触发风控）。建议改用 github_reference_search 检索同类项目（多数知名项目在 GitHub 有同步仓库）。',
          }
        }
        return {
          ok: true,
          provider: 'gitee',
          query,
          totalCount: parsed.length,
          results: parsed.map((p) => ({
            fullName: p.full_name || p.human_name || '',
            url: p.html_url || p.url || '',
            description: p.description || '',
            stars: p.stargazers_count || 0,
            forks: p.forks_count || 0,
            language: p.language || '',
            license: p.license && p.license.name ? p.license.name : '',
            updatedAt: p.updated_at || '',
          })),
          rateLimit: ref.rateLimitInfo(r),
        }
      },
    })

    ctx.tools.register({
      name: 'npm_reference_search',
      description:
        '在 npm registry 上检索 JavaScript/Node.js 生态的公开包，作为依赖选型与参考实现（适合需要直接复用一个 npm 包、'
        + '或了解某个能力的现成库时调用）。返回包名、版本、描述、关键词、许可证、仓库链接、发布者、下载量与搜索得分。'
        + '注意：检索结果为第三方开源包，仅供参考，复用必须遵守其许可证（license 字段）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '描述目标功能的检索关键词，如 "markdown editor react"、"jwt middleware"、"form validation"' },
          limit: { type: 'integer', default: 5, description: '返回包数量，1-10，默认 5' },
        },
        required: ['query'],
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: 40000,
      presentCall: (args) => ({ card: 'generic', kind: 'read', title: 'npm 参考检索: ' + String((args && args.query) || '') }),
      async execute(args, exec) {
        const query = ref.safeQuery(args.query)
        if (query === '') throw new Error('query 不能为空')
        const limit = ref.clampLimit(args.limit)
        const r = await ref.apiRequest('https://registry.npmjs.org/-/v1/search?text=' + encodeURIComponent(query) + '&size=' + limit,
          { signal: exec.signal })
        if (r.error) return ref.webSearchFallback('npm', 'npm package', query, limit, exec.signal)
        if (r.status !== 200) return ref.apiError(r, 'npm 检索失败')
        const parsed = ref.parseJson(r)
        if (!parsed || !Array.isArray(parsed.objects)) return { ok: false, status: r.status, message: 'npm 返回了无法解析的检索结果' }
        return {
          ok: true,
          provider: 'npm',
          query,
          totalCount: parsed.total || parsed.objects.length,
          results: parsed.objects.map((o) => {
            const p = (o && o.package) || {}
            return {
              name: p.name || '',
              version: p.version || '',
              description: p.description || '',
              keywords: Array.isArray(p.keywords) ? p.keywords : [],
              license: p.license || '',
              npmUrl: (p.links && p.links.npm) || '',
              repositoryUrl: (p.links && p.links.repository) || '',
              publisher: p.publisher && p.publisher.username ? p.publisher.username : '',
              publishedAt: p.date || '',
              searchScore: o.searchScore !== undefined ? Math.round(Number(o.searchScore) * 100) / 100 : undefined,
              monthlyDownloads: o.downloads && o.downloads.monthly !== undefined ? o.downloads.monthly : undefined,
            }
          }),
        }
      },
    })

    ctx.tools.register({
      name: 'local_code_reuse_search',
      description:
        '在本地代码库（默认当前工作区，可指定目录）中检索可复用的函数、类、组件、模块——开发新功能前先查本地是否已有现成实现，避免重复造轮子。'
        + '按"声明名包含关键词"优先匹配（如 function/class/def/fn/func/const 等声明的名字中含检索词的行），'
        + '并支持行内含关键词的宽松匹配；返回匹配文件路径、行号、行内容与前后文。'
        + '自动跳过 node_modules/.git/dist/build/vendor 等目录与大文件（>256KB）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要复用的功能/组件描述或关键词，如 "markdown 解析"、"用户认证"、"datepicker"、"retry"' },
          root: { type: 'string', description: '检索根目录（绝对路径）；省略时使用当前工作区根目录' },
          fileTypes: { type: 'string', description: '可选：文件扩展名白名单（逗号分隔），如 "ts,tsx,js"；默认常见编程语言扩展名' },
          maxResults: { type: 'integer', default: 10, description: '返回匹配数量上限，1-20，默认 10' },
        },
        required: ['query'],
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: 90000,
      presentCall: (args) => ({ card: 'generic', kind: 'read', title: '本地复用检索: ' + String((args && args.query) || '') }),
      async execute(args, exec) {
        const collected = await ref.collectLocalCandidates(args.query, args.root, exec.signal)
        if (collected.error) return { ok: false, message: collected.error }
        const maxResults = Math.min(20, Math.max(1, Number(args.maxResults) || 10))
        return {
          ok: true,
          provider: 'local',
          query: ref.safeQuery(args.query),
          root: collected.root || '',
          scannedFiles: collected.scanned,
          truncated: collected.truncated,
          matchCount: collected.candidates.length,
          matches: collected.candidates.slice(0, maxResults).map((c) => ({
            path: c.path,
            line: c.line,
            lineText: c.lineText,
            score: c.score,
          })),
        }
      },
    })

    ctx.tools.register({
      name: 'code_architecture_review',
      description:
        '对本地代码库（默认当前工作区，可指定目录）做架构自检，贯彻高内聚低耦合：'
        + '分析模块依赖关系，报告循环依赖、超大模块、扇入/扇出热点，并给出改进建议。'
        + '适合在完成一个模块或项目后调用自检（建议在声明完成前运行并修复发现的问题）。'
        + '依赖图基于 import/require/from 相对导入（TS/JS/Python/Go 等），其他语言计入模块规模统计。',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string', description: '分析根目录（绝对路径）；省略时使用当前工作区根目录' },
          maxCycles: { type: 'integer', default: 5, description: '最多报告多少个循环依赖，1-20，默认 5' },
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: 120000,
      presentCall: () => ({ card: 'generic', kind: 'read', title: '架构自检（高内聚低耦合）' }),
      async execute(args, exec) {
        let rootPath = String(args.root || '').trim()
        if (!rootPath) rootPath = ctx.sandboxPolicy.workspaceRoot || ''
        if (!rootPath) return { ok: false, message: '未提供 root 且无法确定工作区根目录，请通过 root 参数指定绝对路径' }
        const maxCycles = Math.min(20, Math.max(1, Number(args.maxCycles) || 5))

        let rootTarget
        try {
          rootTarget = await ctx.fs.resolve(rootPath, { signal: exec.signal })
        } catch (error) {
          return { ok: false, message: '无法解析分析根目录 ' + rootPath + ': ' + String((error && error.message) || error) }
        }

        const fileSet = new Set()
        let collected
        try {
          collected = await ref.collectFiles(rootTarget, ref.ARCH_EXTS, exec.signal, fileSet)
        } catch (error) {
          return { ok: false, message: String((error && error.message) || error) }
        }

        const graph = {}
        const lineCount = {}
        const goModule = {}

        const goModTarget = await ctx.fs.resolve(rootPath + '/go.mod', { signal: exec.signal }).catch(() => undefined)
        if (goModTarget) {
          const goModText = await ctx.fs.readText(goModTarget, exec.signal).catch(() => '')
          const gm = /^module\s+(\S+)/m.exec(goModText)
          if (gm) goModule.prefix = gm[1]
        }

        const readImports = async (entry, path) => {
          let text
          try {
            text = await ctx.fs.readText(entry.target, exec.signal)
          } catch (error) {
            return
          }
          if (text.indexOf('\u0000') >= 0) return
          const lines = text.split('\n')
          lineCount[path] = lines.length
          const dot = path.lastIndexOf('.')
          const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
          const lang = ext === 'tsx' || ext === 'jsx' ? 'js' : ext
          const deps = ref.extractImports(text, lang)
          const resolved = []
          for (const dep of deps) {
            if (lang === 'go') {
              const prefix = goModule.prefix
              if (prefix && dep.startsWith(prefix)) {
                const rel = dep.slice(prefix.length).replace(/^\//, '')
                const first = rel.split('/')[0]
                const dirPath = path.slice(0, path.lastIndexOf('/'))
                const targetDir = dirPath.split('/').slice(0, -1).join('/') + '/' + first
                let found = false
                for (const f of fileSet) {
                  if (f.startsWith(targetDir + '/')) {
                    resolved.push(f)
                    found = true
                    break
                  }
                }
                if (!found && fileSet.has(targetDir)) resolved.push(targetDir)
              }
            } else {
              const r = ref.resolveModule(path, dep, fileSet)
              if (r !== undefined) resolved.push(r)
            }
          }
          if (resolved.length > 0) graph[path] = resolved
        }

        const pending = collected.pending
        for (let i = 0; i < pending.length; i += 8) {
          if (exec.signal && exec.signal.aborted) return { ok: false, message: '分析已取消' }
          await Promise.all(pending.slice(i, i + 8).map((p) => readImports(p.entry, p.path)))
        }

        const cycles = ref.findCycles(graph, maxCycles)

        const fanOut = {}
        const fanIn = {}
        for (const [from, deps] of Object.entries(graph)) {
          fanOut[from] = deps.length
          for (const d of deps) fanIn[d] = (fanIn[d] || 0) + 1
        }
        const topFanOut = Object.entries(fanOut).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => ({ path: p, count: n }))
        const topFanIn = Object.entries(fanIn).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => ({ path: p, count: n }))
        const largeModules = Object.entries(lineCount).filter(([, n]) => n >= 400)
          .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => ({ path: p, lines: n }))

        const suggestions = []
        if (cycles.length > 0) suggestions.push('存在 ' + cycles.length + ' 个循环依赖：请将共享逻辑抽取到独立模块或通过依赖注入/回调反转依赖方向。')
        if (largeModules.length > 0) suggestions.push('存在 ' + largeModules.length + ' 个超大模块（>=400 行）：考虑按职责拆分（单一职责原则）。')
        if (topFanIn.length > 0 && topFanIn[0].count >= 20) suggestions.push('模块 ' + topFanIn[0].path + ' 被 ' + topFanIn[0].count + ' 个模块依赖：确认其接口足够稳定、抽象程度合理。')
        if (topFanOut.length > 0 && topFanOut[0].count >= 15) suggestions.push('模块 ' + topFanOut[0].path + ' 直接依赖 ' + topFanOut[0].count + ' 个内部模块：检查是否职责过宽、需要拆分。')
        if (suggestions.length === 0) suggestions.push('未发现明显问题：依赖方向清晰、无循环依赖、无超大模块，结构符合高内聚低耦合原则。')

        return {
          ok: true,
          provider: 'architecture',
          root: (() => {
            try {
              return ctx.fs.processPath(rootTarget)
            } catch (error) {
              return rootPath
            }
          })(),
          scannedFiles: pending.length,
          truncated: collected.truncated,
          moduleCount: Object.keys(graph).length,
          importEdges: Object.values(graph).reduce((sum, deps) => sum + deps.length, 0),
          cycles,
          largeModules,
          topFanOut,
          topFanIn,
          suggestions,
        }
      },
    })

    ctx.tools.register({
      name: 'architecture_reuse_search',
      description:
        '架构级复用检索：不仅查找相似功能的实现，还判断本地已有系统的整体架构是否可以直接复用。'
        + '根据需求提取业务能力标签（15 类：检索与索引/元数据与分类/用户与权限/审批与流程/导入导出与批处理/报表与统计/审计与日志/文档与存储/资源与借还/订单与交易/通知与消息/API 与服务化/任务与待办/组织与机构/管理后台），'
        + '扫描本地根目录下的每个业务系统（顶层目录），生成系统画像（能力矩阵、文件数、行数、语言），'
        + '计算需求与每个系统的架构相似度并按相似度降序返回。'
        + '典型场景：要做图书馆检索系统时，本地某个政务文件管理系统可能与其共享"检索与索引/用户与权限/文档与存储/管理后台"等能力，可直接以它为骨架。'
        + '注意：本工具是"候选发现器"——相似度仅为能力标签重叠的启发式信号，不代表数据模型、边界与非功能需求兼容，'
        + '是否以某系统为骨架必须由用户/人工确认后再决定。'
        + '隐私提示：扫描范围严格限制在 root 参数指定目录的顶层业务目录内（自动跳过 node_modules/.git/dist/vendor/tests 等）；'
        + '本地源文件不会发送给任何检索平台，命中路径、最长 160 字符的代码片段及系统画像会进入当前 Agent/模型上下文。',
      parameters: {
        type: 'object',
        properties: {
          requirement: { type: 'string', description: '新系统需求描述，如 "图书馆检索系统：图书检索、借阅归还、读者管理、馆藏分类"' },
          root: { type: 'string', description: '本地根目录（绝对路径），其下每个顶层业务目录视为一个系统；省略时使用当前工作区根目录' },
          minSimilarity: { type: 'integer', default: 30, description: '相似度下限（0-100），只返回达到该值的系统，默认 30' },
        },
        required: ['requirement'],
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: 120000,
      presentCall: (args) => ({ card: 'generic', kind: 'read', title: '架构级复用检索: ' + String((args && args.requirement) || '') }),
      async execute(args, exec) {
        const requirement = ref.safeQuery(args.requirement)
        if (requirement === '') throw new Error('requirement 不能为空')
        const minSimilarity = Math.min(100, Math.max(0, args.minSimilarity === undefined || args.minSimilarity === null || args.minSimilarity === '' ? 30 : Number(args.minSimilarity)))
        let rootPath = String(args.root || '').trim()
        if (!rootPath) rootPath = ctx.sandboxPolicy.workspaceRoot || ''
        if (!rootPath) return { ok: false, message: '未提供 root 且无法确定工作区根目录，请通过 root 参数指定绝对路径' }

        const reqLabels = ref.capabilityLabelsOf(requirement)
        if (reqLabels.length === 0) {
          return { ok: false, message: '无法从需求中提取任何业务能力标签。请用业务语言描述需求，例如"图书馆检索系统：图书检索、借阅归还、读者管理、馆藏分类"（可含中文或英文关键词）。' }
        }
        const profile = await ref.extractSystemProfile(rootPath, exec.signal, { maxSystems: 12, timeBudgetMs: 25000 })
        if (profile.error) return { ok: false, message: profile.error }

        const ranked = profile.systems.map((s) => {
          const sim = ref.architectureSimilarity(reqLabels, s.capabilities)
          return Object.assign({}, s, { similarity: sim.similarity, overlap: sim.overlap, missing: sim.missing })
        }).filter((s) => s.similarity >= minSimilarity).sort((a, b) => b.similarity - a.similarity)

        return {
          ok: true,
          provider: 'architecture-reuse',
          requirement,
          capabilityLabels: reqLabels,
          scannedSystems: profile.scanned,
          minSimilarity,
          results: ranked.slice(0, 8),
          note: ranked.length === 0
            ? '没有找到架构相似度达到 ' + minSimilarity + ' 的本地系统；可降低 minSimilarity 或更换 root 后再试。'
            : '相似度 = 需求能力标签与系统能力标签的重叠比例，仅为启发式候选信号。可先用 code_architecture_review 检查最高相似度系统的依赖结构，再与用户/团队确认是否以它为架构骨架（数据模型、边界、非功能需求需人工评估）。',
        }
      },
    })
  },
}
