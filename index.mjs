// dsh-code-reference 部署级插件 v2（与动态版 ghref-1/pkg-15 逻辑一致）
// 模式：需求澄清 → reuse_survey 调查 → 询问用户（或 reuseMode=auto 不询问优先复用）；无强制拦截
// 安装：在 cordis.patch.yml / cordis.yml 增加行 { id: code-reference, name: <本文件绝对路径> }
export default {
  inject: ['subprocess', 'web', 'systemPrompt', 'fs', 'timer'],
  apply(ctx) {
    const README_CHARS = 6000
    const FILE_CHARS = 8000
    const MAX_FILES = 3
    const STATUS_MARKER = '__DSH_GH_STATUS__:'
    const HEADER_MARKER = '__DSH_GH_HEADERS__:'

    const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/')

    async function apiRequest(url, opts) {
      const { accept, signal, maxBytes = 4194304 } = opts || {}
      let curl
      try {
        curl = await ctx.subprocess.resolveExecutable('curl')
      } catch (error) {
        return { error: 'curl-unavailable', message: String((error && error.message) || error) }
      }
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv: [
            curl, '-sS', '--max-time', '25',
            '-A', 'dsh-code-reference/1.0',
            '-H', 'Accept: ' + (accept || 'application/json'),
            '-w', '\n' + STATUS_MARKER + '%{http_code}\n' + HEADER_MARKER + '%{header_json}',
            url,
          ],
          cwd: '/',
          stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes: 65536 } },
          graceMs: 5000,
          signal,
        })
      } catch (error) {
        return { error: 'spawn', message: String((error && error.message) || error) }
      }
      const outcome = await handle.done.catch((error) => ({ spawnError: String((error && error.message) || error) }))
      if (outcome.spawnError) return { error: 'spawn', message: outcome.spawnError }
      const raw = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
      const errText = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
      if (outcome.exitCode !== 0) {
        const detail = errText ? errText.slice(0, 300) : raw.slice(0, 300)
        return { error: 'exit-' + String(outcome.exitCode), message: 'curl 退出码 ' + outcome.exitCode + (detail ? ': ' + detail : '') }
      }
      const statusMarker = raw.lastIndexOf(STATUS_MARKER)
      const status = statusMarker >= 0 ? (parseInt(raw.slice(statusMarker + STATUS_MARKER.length).trim(), 10) || 0) : 0
      const body = statusMarker >= 0 ? raw.slice(0, statusMarker) : raw
      const headerMarker = raw.lastIndexOf(HEADER_MARKER)
      const headerJson = headerMarker >= 0 ? raw.slice(headerMarker + HEADER_MARKER.length).trim() : ''
      const header = (name) => {
        try {
          const parsed = JSON.parse(headerJson)
          const values = parsed && typeof parsed === 'object' ? parsed[name] : undefined
          return Array.isArray(values) && values.length > 0 ? String(values[0]) : undefined
        } catch (error) {
          return undefined
        }
      }
      return {
        status,
        body,
        rateLimit: {
          remaining: header('x-ratelimit-remaining') || header('ratelimit-remaining'),
          limit: header('x-ratelimit-limit') || header('ratelimit-limit'),
          reset: header('x-ratelimit-reset') || header('ratelimit-reset'),
        },
      }
    }

    function rateLimitInfo(r) {
      const info = {}
      if (r.rateLimit && r.rateLimit.remaining !== undefined) info.remaining = Number(r.rateLimit.remaining)
      if (r.rateLimit && r.rateLimit.limit !== undefined) info.limit = Number(r.rateLimit.limit)
      if (r.rateLimit && r.rateLimit.reset !== undefined) {
        const t = Number(r.rateLimit.reset)
        if (Number.isFinite(t) && t > 0) info.resetAt = new Date(t * 1000).toISOString()
      }
      return info
    }

    function apiError(r, fallback) {
      let message = fallback || 'HTTP ' + r.status
      try {
        const parsed = JSON.parse(r.body)
        if (parsed && parsed.message) message += ': ' + String(parsed.message)
      } catch (error) { /* keep fallback */ }
      const info = rateLimitInfo(r)
      if ((r.status === 403 || r.status === 429) && info.remaining === 0) {
        message += '（未认证 API 限流：可在 ' + (info.resetAt || '稍后') + ' 重试，或配置访问令牌提高配额）'
      }
      return { ok: false, status: r.status, message, rateLimit: info }
    }

    function parseJson(r) {
      try {
        return JSON.parse(r.body)
      } catch (error) {
        return undefined
      }
    }

    async function webSearchFallback(platform, siteQuery, query, limit, signal) {
      if (ctx.web === undefined) return { ok: false, message: 'curl 不可用且 web 搜索服务未挂载，无法检索 ' + platform }
      try {
        const result = await ctx.web.search({ query: siteQuery + ' ' + query, maxResults: limit }, signal)
        return {
          ok: true,
          provider: platform + '-web-fallback',
          note: '平台 API 不可用，已退化为通用网页搜索（无 star/许可证等结构化字段）',
          results: (result.sources || []).map((s) => ({
            title: s.title || s.url,
            url: s.url,
            snippet: s.snippet || '',
          })),
        }
      } catch (error) {
        return { ok: false, message: 'web 搜索失败: ' + String((error && error.message) || error) }
      }
    }

    const safeQuery = (q) => String(q || '').trim()
    const clampLimit = (n) => Math.min(10, Math.max(1, Number(n) || 5))

    const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', 'coverage', '.idea', '.vscode', 'Pods', '.gradle', 'bin', 'obj', 'tmp', 'temp', '.turbo', '.yarn', '.pnpm-store', '.dsh', '.terraform', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.gitbook', 'docs', 'website'])
    const CODE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'php', 'rb', 'sh', 'lua', 'dart', 'scala', 'ex', 'exs', 'erl', 'clj', 'fs', 'fsx', 'ml', 'r', 'pl', 'sql', 'groovy'])
    const MAX_SCAN_FILES = 4000
    const MAX_FILE_BYTES = 262144

    async function collectFiles(rootTarget, allowedExts, signal, fileSet) {
      const pending = []
      const stack = [rootTarget]
      let scanned = 0
      let truncated = false
      while (stack.length > 0) {
        if (signal && signal.aborted) throw new Error('检索已取消')
        const dir = stack.pop()
        let entries
        try {
          entries = await ctx.fs.listDir(dir, signal)
        } catch (error) {
          continue
        }
        for (const entry of entries) {
          if (signal && signal.aborted) throw new Error('检索已取消')
          if (entry.type === 'directory') {
            if (!SKIP_DIRS.has(entry.name)) stack.push(entry.target)
          } else if (entry.type === 'file') {
            if (scanned >= MAX_SCAN_FILES) {
              truncated = true
              stack.length = 0
              break
            }
            scanned += 1
            const dot = entry.name.lastIndexOf('.')
            const ext = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : ''
            if (!allowedExts.has(ext)) continue
            if (entry.size !== undefined && entry.size > MAX_FILE_BYTES) continue
            let path
            try {
              path = ctx.fs.processPath(entry.target)
            } catch (error) {
              path = entry.name
            }
            if (fileSet) fileSet.add(path)
            pending.push({ entry, path })
          }
        }
      }
      return { pending, truncated }
    }

    function wordDefRegex(w) {
      return new RegExp(
        '^\\s*(?:'
          + '(?:(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s+\\w*' + w + '\\w*\\s*[(])'
          + '|(?:(?:export\\s+)?(?:const|let|var)\\s+\\w*' + w + '\\w*\\s*=\\s*(?:async\\s*)?(?:\\w+\\s*=>|function|[(]))'
          + '|(?:(?:export\\s+)?(?:abstract\\s+)?class\\s+\\w*' + w + '\\w*)'
          + '|(?:(?:export\\s+)?(?:interface|type|enum)\\s+\\w*' + w + '\\w*)'
          + '|(?:(?:async\\s+)?def\\s+\\w*' + w + '\\w*\\s*[(])'
          + '|(?:class\\s+\\w*' + w + '\\w*)'
          + '|(?:(?:pub\\s+)?(?:async\\s+)?fn\\s+\\w*' + w + '\\w*)'
          + '|(?:(?:pub\\s+)?(?:struct|enum|trait|impl)\\s+\\w*' + w + '\\w*)'
          + '|(?:func\\s+\\w*' + w + '\\w*\\s*[(])'
          + '|(?:(?:public|private|protected)\\s+(?:static\\s+|final\\s+|abstract\\s+|async\\s+)*[\\w<>,.?\\[\\]\\s]*\\w*' + w + '\\w*\\s*[(])'
          + '|(?:(?:public|private|protected)\\s+(?:static\\s+)?class\\s+\\w*' + w + '\\w*)'
          + ')',
        'i')
    }

    function wordLooseRegex(w) {
      if (/^[a-zA-Z0-9_]+$/.test(w)) {
        return new RegExp('^\\s*(?:export\\s+)?(?:const|let|var|function|class|interface|type|enum|def|fn|func|struct|trait|impl|public|private|protected|async|static)\\b[^\\n]{0,240}\\b' + w + '\\b', 'i')
      }
      return new RegExp('^\\s*(?:export\\s+)?(?:const|let|var|function|class|interface|type|enum|def|fn|func|struct|trait|impl|public|private|protected|async|static)\\b', 'i')
    }

    function queryWords(query) {
      const words = (query.match(/[a-zA-Z0-9_\u4e00-\u9fa5]+/g) || []).map((w) => w.toLowerCase())
      return words.filter((w) => w.length >= 2).slice(0, 8)
    }

    async function collectLocalCandidates(query, rootPath, signal) {
      const words = queryWords(query)
      if (words.length === 0) return { words, candidates: [], scanned: 0, truncated: false }
      const exts = CODE_EXTS
      let root = String(rootPath || '').trim()
      if (!root) {
        const policy = ctx.get('sandboxPolicy')
        root = policy && policy.workspaceRoot ? policy.workspaceRoot : ''
      }
      if (!root) return { words, candidates: [], scanned: 0, truncated: false, error: '未提供 root 且无法确定工作区根目录' }
      let rootTarget
      try {
        rootTarget = await ctx.fs.resolve(root, { signal })
      } catch (error) {
        return { words, candidates: [], scanned: 0, truncated: false, error: '无法解析检索根目录 ' + root + ': ' + String((error && error.message) || error) }
      }
      const defRegexes = words.map((w) => ({ exact: wordDefRegex(w), loose: wordLooseRegex(w), word: w, ascii: /^[a-zA-Z0-9_]+$/.test(w) }))
      const hits = []
      let collected
      try {
        collected = await collectFiles(rootTarget, exts, signal)
      } catch (error) {
        return { words, candidates: [], scanned: 0, truncated: false, error: String((error && error.message) || error) }
      }
      const readAndMatch = async (entry, path) => {
        let text
        try {
          text = await ctx.fs.readText(entry.target, signal)
        } catch (error) {
          return
        }
        if (text.indexOf('\u0000') >= 0) return
        const lines = text.split('\n')
        const limit = Math.min(lines.length, 20000)
        for (let i = 0; i < limit; i++) {
          const line = lines[i]
          let score = 0
          for (const d of defRegexes) {
            if (d.exact.test(line)) {
              score = Math.max(score, 2)
            } else if (d.loose.test(line) && (d.ascii || line.indexOf(d.word) >= 0)) {
              score = Math.max(score, 1)
            }
          }
          if (score > 0) {
            hits.push({ path, line: i + 1, lineText: line.trim().slice(0, 160), score })
            break
          }
        }
      }
      const pending = collected.pending
      for (let i = 0; i < pending.length; i += 8) {
        if (signal && signal.aborted) return { words, candidates: [], scanned: 0, truncated: collected.truncated, error: '检索已取消' }
        await Promise.all(pending.slice(i, i + 8).map((p) => readAndMatch(p.entry, p.path)))
      }
      const seen = new Set()
      const files = hits.filter((h) => {
        if (seen.has(h.path)) return false
        seen.add(h.path)
        return true
      }).sort((a, b) => b.score - a.score)
      return {
        words,
        root,
        candidates: files.slice(0, 8).map((h) => ({ path: h.path, line: h.line, lineText: h.lineText, score: h.score })),
        scanned: pending.length,
        truncated: collected.truncated,
      }
    }

    // ═══ 复用价值评估（阈值 + 公司政策） ═══
    const STOPWORDS = new Set(['the', 'and', 'with', 'for', 'from', 'this', 'that', 'using', 'use', 'used', 'make', 'create', 'provide', 'based', 'via', 'tool', 'utility', 'module', 'function', 'component', 'support', 'supports', 'like', 'into', 'your', 'our', 'can', 'will', 'does', 'would', 'should', 'need', 'needs', 'want', 'feature', 'features', 'system', 'also', 'all', 'any', 'are', 'was', 'were', 'been', 'has', 'have', 'had', 'its', 'them', 'their', 'there', 'where', 'which', 'when', 'what', 'who', 'how', 'why', 'but', 'not', 'only', 'just', 'more', 'most', 'some', 'such', 'than', 'then', 'other', 'others'])

    function assessWords(query) {
      return queryWords(query).filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    }

    function matchScoreOf(path, text, words) {
      const asciiWords = words.filter((w) => /^[a-zA-Z0-9_]+$/.test(w))
      const cjkWords = words.filter((w) => !/^[a-zA-Z0-9_]+$/.test(w))
      const head = text.slice(0, 4000).toLowerCase()
      const base = path.split('/').pop().replace(/\.[^.]+$/, '')
      const nameTokens = base.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((t) => t.toLowerCase())
      if (asciiWords.length > 0) {
        let contentHits = 0
        for (const w of asciiWords) if (head.indexOf(w) >= 0) contentHits++
        let nameHits = 0
        for (const w of asciiWords) {
          if (nameTokens.some((t) => t.indexOf(w) >= 0 || w.indexOf(t) >= 0)) nameHits++
        }
        let cjkHits = 0
        for (const w of cjkWords) if (head.indexOf(w) >= 0) cjkHits++
        const contentPart = 70 * (contentHits / Math.max(1, asciiWords.length))
        const namePart = 30 * (nameHits / Math.max(1, asciiWords.length))
        const cjkBonus = cjkHits > 0 ? 10 : 0
        return Math.min(100, Math.round(contentPart + namePart + cjkBonus))
      }
      if (cjkWords.length > 0) {
        let cjkHits = 0
        for (const w of cjkWords) if (head.indexOf(w) >= 0) cjkHits++
        return Math.min(100, Math.round(100 * (cjkHits / cjkWords.length)))
      }
      return 0
    }

    function effortOf(match, lines, complexity, cfg) {
      if (match >= cfg.reuseThreshold && lines <= cfg.smallLines && complexity <= cfg.maxComplexityPercent / 100) {
        return { level: 'low', estimate: '约 0.5–2 小时' }
      }
      if (match >= cfg.adaptThreshold || lines <= cfg.mediumLines) {
        return { level: 'medium', estimate: '约 2 小时–1 天' }
      }
      return { level: 'high', estimate: '约 1–3 天' }
    }

    const EXT_LANG = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', c: 'c', cpp: 'c++', cc: 'c++', h: 'c', hpp: 'c++', cs: 'c#', php: 'php', rb: 'ruby', swift: 'swift', sh: 'shell', vue: 'vue', svelte: 'svelte', dart: 'dart', scala: 'scala', sql: 'sql', groovy: 'groovy' }
    const extToLanguage = (path) => {
      const dot = path.lastIndexOf('.')
      const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
      return EXT_LANG[ext] || ext
    }

    function normalizePolicy(d) {
      return {
        allowedLicenses: Array.isArray(d.allowedLicenses) ? d.allowedLicenses.map(String) : [],
        blockedLanguages: Array.isArray(d.blockedLanguages) ? d.blockedLanguages.map(String).map((s) => s.toLowerCase()) : [],
        requireTests: d.requireTests === true,
        minCommentRatio: Number(d.minCommentRatio) > 0 ? Number(d.minCommentRatio) : 0,
        reuseMode: d.reuseMode === 'auto' ? 'auto' : 'ask',
      }
    }

    async function loadPolicy(policyPath, localPaths, signal) {
      const candidates = []
      const explicit = String(policyPath || '').trim()
      if (explicit) candidates.push(explicit)
      const policy = ctx.get('sandboxPolicy')
      const ws = policy && policy.workspaceRoot ? policy.workspaceRoot : ''
      if (ws) candidates.push(ws + '/.code-reference-policy.json')
      for (const p of localPaths) {
        let dir = p.slice(0, p.lastIndexOf('/'))
        for (let i = 0; i < 3 && dir.length > 1; i++) {
          candidates.push(dir + '/.code-reference-policy.json')
          const s = dir.lastIndexOf('/')
          if (s <= 0) break
          dir = dir.slice(0, s)
        }
      }
      const seen = new Set()
      for (const path of candidates) {
        if (seen.has(path)) continue
        seen.add(path)
        let target
        try {
          target = await ctx.fs.resolve(path, { signal })
        } catch (error) {
          continue
        }
        let info
        try {
          info = await ctx.fs.stat(target, signal)
        } catch (error) {
          continue
        }
        if (!info) continue
        let text
        try {
          text = await ctx.fs.readText(target, signal)
        } catch (error) {
          continue
        }
        try {
          const data = JSON.parse(text)
          return { source: path, data: normalizePolicy(data), note: '已加载公司政策文件 ' + path }
        } catch (error) {
          return { source: path, data: null, note: '政策文件不是合法 JSON，使用宽松默认：' + String((error && error.message) || error) }
        }
      }
      const tried = Array.from(seen).join('、')
      return { source: tried || null, data: null, note: '未找到政策文件（尝试：' + (tried || '无') + '），使用宽松默认' }
    }

    function buildPolicyChecks(policy, locals, remote) {
      const checks = []
      const p = policy && policy.data
      if (!p) return checks
      if (p.blockedLanguages.length > 0) {
        for (const l of locals) {
          if (!l.error) {
            const lang = extToLanguage(l.path)
            if (p.blockedLanguages.indexOf(lang) >= 0) {
              checks.push({ rule: 'language', status: 'fail', detail: '候选 ' + l.path + ' 使用语言 ' + lang + '，在公司禁止语言列表中' })
            }
          }
        }
      }
      if (p.allowedLicenses.length > 0 && remote && !remote.error && remote.license) {
        const ok = p.allowedLicenses.some((x) => String(x).toLowerCase() === String(remote.license).toLowerCase())
        if (!ok) {
          checks.push({ rule: 'license', status: 'fail', detail: '候选许可证 ' + remote.license + ' 不在公司允许列表（' + p.allowedLicenses.join(', ') + '）中' })
        }
      }
      if (p.requireTests) {
        for (const l of locals) {
          if (!l.error && !l.hasTest) {
            checks.push({ rule: 'tests', status: 'warn', detail: '候选 ' + l.path + ' 缺少测试文件，而公司要求测试覆盖；复用后需补充测试' })
          }
        }
      }
      if (p.minCommentRatio > 0) {
        for (const l of locals) {
          if (!l.error && l.commentRatio < Math.round(p.minCommentRatio * 100)) {
            checks.push({ rule: 'comments', status: 'warn', detail: '候选 ' + l.path + ' 注释比 ' + l.commentRatio + '% 低于公司要求 ' + Math.round(p.minCommentRatio * 100) + '%' })
          }
        }
      }
      return checks
    }

    async function analyzeLocalCandidate(path, words, signal) {
      let target
      try {
        target = await ctx.fs.resolve(path, { signal })
      } catch (error) {
        return { path, error: '无法解析路径: ' + String((error && error.message) || error) }
      }
      let text
      try {
        text = await ctx.fs.readText(target, signal)
      } catch (error) {
        return { path, error: '读取失败: ' + String((error && error.message) || error) }
      }
      if (text.indexOf('\u0000') >= 0) return { path, error: '二进制文件，跳过' }
      const lines = text.split('\n')
      const total = lines.length
      let comment = 0
      let branches = 0
      let declarations = 0
      for (const l of lines) {
        const t = l.trim()
        if (!t) continue
        if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--') || t.startsWith(';')) comment++
        if (/\b(if|switch|case|for|while|catch)\b/.test(t) || t.indexOf('?') >= 0) branches++
        if (/\b(function|class|def|fn|func|const|let|var|interface|type|enum|struct|impl|public|private)\b/.test(t)) declarations++
      }
      const match = matchScoreOf(path, text, words)
      const complexity = branches / Math.max(1, total)

      let hasTest = false
      try {
        const slash = path.lastIndexOf('/')
        const dirPath = slash >= 0 ? path.slice(0, slash) : path
        const dirTarget = await ctx.fs.resolve(dirPath, { signal })
        const entries = await ctx.fs.listDir(dirTarget, signal)
        const baseName = path.slice(slash + 1).replace(/\.[^.]+$/, '')
        hasTest = entries.some((e) => e.type === 'file' && e.name.startsWith(baseName) && (e.name.indexOf('.test.') >= 0 || e.name.indexOf('.spec.') >= 0 || e.name.indexOf('_test.') >= 0))
      } catch (error) { /* 忽略 */ }

      return {
        path,
        language: extToLanguage(path),
        lines: total,
        commentRatio: Math.round((100 * comment) / Math.max(1, total)),
        branches,
        declarations,
        matchScore: match,
        complexityPercent: Math.round(complexity * 100),
        hasTest,
        reasons: [],
      }
    }

    async function analyzeRemoteCandidate(spec, words, signal) {
      if (!spec) return null
      const s = String(spec).trim()
      if (s.startsWith('npm:')) {
        const name = s.slice(4).trim()
        const r = await apiRequest('https://registry.npmjs.org/' + encodeURIComponent(name), { signal })
        if (r.status !== 200) return { spec: s, error: 'npm 查询失败（HTTP ' + r.status + '）' }
        const m = parseJson(r)
        if (!m) return { spec: s, error: 'npm 返回无法解析的数据' }
        const latest = m['dist-tags'] && m['dist-tags'].latest ? m['dist-tags'].latest : ''
        const version = latest && m.versions && m.versions[latest] ? m.versions[latest] : {}
        const desc = String(m.description || '').toLowerCase()
        const asciiWords = words.filter((w) => /^[a-zA-Z0-9_]+$/.test(w))
        let hits = 0
        for (const w of asciiWords) if (desc.indexOf(w) >= 0) hits++
        const match = Math.round((100 * hits) / Math.max(1, asciiWords.length))
        const published = version.date || (m.time && m.time[latest]) || ''
        const months = monthsSince(published)
        return {
          spec: s,
          kind: 'npm',
          name,
          version: latest,
          description: m.description || '',
          license: version.license || '',
          matchScore: match,
          lastPublish: published || '',
          active: months !== null && months < 12,
        }
      }
      const clean = s.replace(/^https?:\/\//, '').replace(/^github\.com\//, '').replace(/\/$/, '')
      const parts = clean.split('/').filter(Boolean)
      if (parts.length < 2) return { spec: s, error: '无法识别的仓库格式（应为 owner/repo 或 https://github.com/owner/repo）' }
      const owner = parts[0].replace(/[^\w.-]/g, '')
      const repo = parts[1].replace(/[^\w.-]/g, '')
      const r = await apiRequest('https://api.github.com/repos/' + owner + '/' + repo, { signal })
      if (r.status === 404) return { spec: s, error: '仓库不存在或为私有' }
      if (r.status !== 200) return { spec: s, error: 'GitHub 查询失败（HTTP ' + r.status + '）' }
      const m = parseJson(r)
      if (!m) return { spec: s, error: 'GitHub 返回无法解析的数据' }
      const desc = String(m.description || '').toLowerCase()
      const asciiWords = words.filter((w) => /^[a-zA-Z0-9_]+$/.test(w))
      let hits = 0
      for (const w of asciiWords) if (desc.indexOf(w) >= 0) hits++
      const match = Math.round((100 * hits) / Math.max(1, asciiWords.length))
      const months = monthsSince(m.updated_at || '')
      return {
        spec: s,
        kind: 'github',
        fullName: m.full_name || owner + '/' + repo,
        description: m.description || '',
        stars: m.stargazers_count || 0,
        license: m.license && m.license.spdx_id ? m.license.spdx_id : '',
        matchScore: match,
        lastUpdated: m.updated_at || '',
        active: months !== null && months < 12,
      }
    }

    function monthsSince(iso) {
      if (!iso) return null
      const t = Date.parse(iso)
      if (Number.isNaN(t)) return null
      return Math.max(0, Math.round((Date.now() - t) / (1000 * 60 * 60 * 24 * 30)))
    }

    function decide(localBest, remote, cfg, checks) {
      const licenseBlocked = checks.some((c) => c.rule === 'license' && c.status === 'fail')
      const languageBlocked = (l) => l !== undefined && checks.some((c) => c.rule === 'language' && c.status === 'fail' && c.detail.indexOf(l.path) >= 0)
      const testsRequired = checks.some((c) => c.rule === 'tests' && c.status === 'warn')

      if (localBest && !languageBlocked(localBest)) {
        const needsTests = testsRequired && !localBest.hasTest
        if (localBest.matchScore >= cfg.reuseThreshold && localBest.effort.level === 'low') {
          if (needsTests) {
            return {
              choice: 'adapt',
              confidence: 'medium',
              reason: '本地候选匹配度 ' + localBest.matchScore + '>= ' + cfg.reuseThreshold + ' 且改造成本低（' + localBest.effort.estimate + '），但公司政策要求测试覆盖而候选缺少测试：建议复用并补充测试后交付。',
            }
          }
          return {
            choice: 'reuse',
            confidence: 'high',
            reason: '本地候选匹配度 ' + localBest.matchScore + '>= ' + cfg.reuseThreshold + ' 且改造成本低（' + localBest.effort.estimate + '），复用总成本显著低于自制，建议直接复用。',
          }
        }
        if (localBest.matchScore >= cfg.adaptThreshold) {
          return {
            choice: 'adapt',
            confidence: 'medium',
            reason: '本地候选匹配度 ' + localBest.matchScore + '（阈值 ' + cfg.adaptThreshold + '），需改造（' + localBest.effort.estimate + '）。若改造工作量小于从零实现（同规模约 2-3 倍于改造工作量），建议改造复用；否则自制。' + (needsTests ? '注意：公司要求测试覆盖，改造时需补测试。' : ''),
          }
        }
      }
      if (remote && !remote.error && !licenseBlocked && remote.matchScore >= cfg.remoteThreshold && remote.active) {
        return {
          choice: 'dependency',
          confidence: 'medium',
          reason: '开源候选维护活跃且描述匹配（' + remote.matchScore + '>= ' + cfg.remoteThreshold + '），引入依赖通常优于自制；许可证 ' + (remote.license || '未知') + ' 已通过公司政策检查。',
        }
      }
      const policyNote = licenseBlocked ? '（候选许可证未通过公司政策检查，已排除）' : ''
      return {
        choice: 'rewrite',
        confidence: 'high',
        reason: '未找到匹配度足够高、改造成本足够低的候选，或候选被公司政策排除' + policyNote + '；从零实现的成本低于复用的总成本，建议自制。',
      }
    }

    const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

    function defaultConfig(args) {
      const cfg = {
        reuseThreshold: Math.min(100, Math.max(1, Number(args && args.reuseThreshold) || 70)),
        adaptThreshold: Math.min(100, Math.max(1, Number(args && args.adaptThreshold) || 40)),
        remoteThreshold: Math.min(100, Math.max(1, Number(args && args.remoteThreshold) || 50)),
        smallLines: Math.max(1, Number(args && args.smallLines) || 300),
        mediumLines: Math.max(1, Number(args && args.mediumLines) || 800),
        maxComplexityPercent: Math.min(100, Math.max(1, Number(args && args.maxComplexityPercent) || 12)),
      }
      if (cfg.adaptThreshold > cfg.reuseThreshold) cfg.adaptThreshold = cfg.reuseThreshold
      return cfg
    }

    async function assessCandidates(requirement, localPaths, remoteSpec, cfg, signal) {
      const words = assessWords(requirement)
      const policy = await loadPolicy(undefined, localPaths, signal)
      const locals = []
      for (const p of localPaths) {
        const a = await analyzeLocalCandidate(p, words, signal)
        locals.push(a)
        if (signal && signal.aborted) return { words, policy, locals, remote: null, checks: [], error: '评估已取消' }
      }
      const remote = await analyzeRemoteCandidate(remoteSpec, words, signal)
      const checks = buildPolicyChecks(policy, locals, remote)
      const languageBlocked = (l) => l !== undefined && checks.some((c) => c.rule === 'language' && c.status === 'fail' && c.detail.indexOf(l.path) >= 0)
      for (const l of locals) {
        if (l.error) continue
        l.effort = effortOf(l.matchScore, l.lines, l.complexityPercent / 100, cfg)
        if (languageBlocked(l)) {
          l.verdict = 'not-suitable'
        } else if (l.matchScore >= cfg.reuseThreshold && l.effort.level === 'low') {
          l.verdict = 'direct-reuse'
        } else if (l.matchScore >= cfg.adaptThreshold) {
          l.verdict = 'adapt-reuse'
        } else {
          l.verdict = 'not-suitable'
        }
        l.reasons = []
        if (l.matchScore >= cfg.reuseThreshold) l.reasons.push('与需求关键词高度重合（匹配 ' + l.matchScore + '/100）')
        else if (l.matchScore >= cfg.adaptThreshold) l.reasons.push('与需求部分重合（匹配 ' + l.matchScore + '/100），需要适配')
        else l.reasons.push('与需求重合度低（匹配 ' + l.matchScore + '/100）')
        if (l.lines <= cfg.smallLines) l.reasons.push('代码量小（' + l.lines + ' 行），改造成本可控')
        else if (l.lines <= cfg.mediumLines) l.reasons.push('代码量中等（' + l.lines + ' 行），改造需谨慎')
        else l.reasons.push('代码量大（' + l.lines + ' 行），改造/维护成本高')
        if (l.hasTest) l.reasons.push('存在对应测试文件，质量信号较好')
        if (l.branches > 0) l.reasons.push('分支/条件 ' + l.branches + ' 处，复杂度 ' + l.complexityPercent + '%')
      }
      if (remote && !remote.error) {
        remote.reasons = []
        remote.reasons.push('描述匹配 ' + remote.matchScore + '/100')
        const m = remote.lastUpdated || remote.lastPublish || ''
        const mm = monthsSince(m)
        if (mm !== null) remote.reasons.push('最近更新于 ' + mm + ' 个月前（' + (mm < 12 ? '维护活跃' : '维护沉寂') + '）')
        remote.reasons.push((remote.stars || 0) + ' stars')
        remote.reasons.push(remote.license ? '许可证 ' + remote.license : '许可证未知')
      }
      const usableLocal = locals.filter((l) => !l.error && l.verdict !== 'not-suitable')
      const bestLocal = usableLocal.length > 0
        ? usableLocal.sort((a, b) => (b.matchScore + (b.verdict === 'direct-reuse' ? 100 : 0)) - (a.matchScore + (a.verdict === 'direct-reuse' ? 100 : 0)))[0]
        : undefined
      const decision = decide(bestLocal, remote, cfg, checks)
      return { words, policy, locals, remote, checks, bestLocal, decision }
    }

    // ═══ 1. GitHub 仓库检索 ═══
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
        const query = safeQuery(args.query)
        if (query === '') throw new Error('query 不能为空')
        const limit = clampLimit(args.limit)
        const sort = ['updated', 'forks', 'help-wanted-issues'].indexOf(String(args.sort || '')) >= 0 ? String(args.sort) : 'stars'
        let qualifiers = 'archived:false'
        if (args.language) {
          const lang = String(args.language).replace(/[^A-Za-z0-9+#.-]/g, '')
          if (lang) qualifiers += ' language:' + lang
        }
        const r = await apiRequest('https://api.github.com/search/repositories?q='
          + encodeURIComponent(query + ' ' + qualifiers) + '&sort=' + sort + '&order=desc&per_page=' + limit,
          { signal: exec.signal })
        if (r.error) return webSearchFallback('github', 'github open source', query, limit, exec.signal)
        if (r.status !== 200) return apiError(r, 'GitHub 仓库检索失败')
        const parsed = parseJson(r)
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
          rateLimit: rateLimitInfo(r),
        }
        if (args.includeReadme === true && results.length > 0) {
          const parts = results[0].fullName.split('/')
          const rd = await apiRequest('https://api.github.com/repos/' + parts[0] + '/' + parts[1] + '/readme', {
            accept: 'application/vnd.github.raw+json',
            signal: exec.signal,
          })
          out.topReadme = rd.status === 200 && rd.body ? rd.body.slice(0, README_CHARS) : null
        }
        return out
      },
    })

    // ═══ 2. GitHub 仓库详情 ═══
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
        const meta = await apiRequest('https://api.github.com/repos/' + owner + '/' + repo, { signal: exec.signal })
        if (meta.error) return { ok: false, message: meta.message }
        if (meta.status === 404) {
          return { ok: false, status: 404, message: '仓库 ' + owner + '/' + repo + ' 不存在或为私有仓库', rateLimit: rateLimitInfo(meta) }
        }
        if (meta.status !== 200) return apiError(meta, '获取仓库信息失败')
        const m = parseJson(meta)
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
          rateLimit: rateLimitInfo(meta),
        }
        if (args.includeReadme !== false) {
          const rd = await apiRequest('https://api.github.com/repos/' + owner + '/' + repo + '/readme', {
            accept: 'application/vnd.github.raw+json',
            signal: exec.signal,
          })
          out.readme = rd.status === 200 && rd.body ? rd.body.slice(0, README_CHARS) : null
        }
        if (args.paths) {
          const wanted = String(args.paths).split(',').map((p) => p.trim()).filter(Boolean).slice(0, MAX_FILES)
          out.files = []
          for (const p of wanted) {
            const fr = await apiRequest('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + encodePath(p), {
              accept: 'application/vnd.github.raw+json',
              signal: exec.signal,
            })
            if (fr.status === 200 && fr.body) {
              out.files.push({ path: p, text: fr.body.slice(0, FILE_CHARS), truncated: fr.body.length > FILE_CHARS })
            } else {
              out.files.push({ path: p, text: null, error: '无法获取（HTTP ' + fr.status + '，文件可能超过 1MB 或路径不存在）' })
            }
          }
        }
        return out
      },
    })

    // ═══ 3. GitLab 检索 ═══
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
        const query = safeQuery(args.query)
        if (query === '') throw new Error('query 不能为空')
        const limit = clampLimit(args.limit)
        const r = await apiRequest('https://gitlab.com/api/v4/projects?search=' + encodeURIComponent(query)
          + '&order_by=star_count&sort=desc&per_page=' + limit + '&simple=true',
          { signal: exec.signal })
        if (r.error) return webSearchFallback('gitlab', 'site:gitlab.com', query, limit, exec.signal)
        if (r.status !== 200) return apiError(r, 'GitLab 检索失败')
        const parsed = parseJson(r)
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
          rateLimit: rateLimitInfo(r),
        }
      },
    })

    // ═══ 4. Gitee 检索 ═══
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
        const query = safeQuery(args.query)
        if (query === '') throw new Error('query 不能为空')
        const limit = clampLimit(args.limit)
        const r = await apiRequest('https://gitee.com/api/v5/search/repositories?q=' + encodeURIComponent(query)
          + '&sort=stars_count&order=desc&per_page=' + limit,
          { signal: exec.signal })
        if (r.error) return webSearchFallback('gitee', 'site:gitee.com', query, limit, exec.signal)
        if (r.status !== 200) return apiError(r, 'Gitee 检索失败')
        const parsed = parseJson(r)
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
          rateLimit: rateLimitInfo(r),
        }
      },
    })

    // ═══ 5. npm 包检索 ═══
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
        const query = safeQuery(args.query)
        if (query === '') throw new Error('query 不能为空')
        const limit = clampLimit(args.limit)
        const r = await apiRequest('https://registry.npmjs.org/-/v1/search?text=' + encodeURIComponent(query) + '&size=' + limit,
          { signal: exec.signal })
        if (r.error) return webSearchFallback('npm', 'npm package', query, limit, exec.signal)
        if (r.status !== 200) return apiError(r, 'npm 检索失败')
        const parsed = parseJson(r)
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

    // ═══ 6. 本地代码复用检索 ═══
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
        const collected = await collectLocalCandidates(args.query, args.root, exec.signal)
        if (collected.error) return { ok: false, message: collected.error }
        const maxResults = Math.min(20, Math.max(1, Number(args.maxResults) || 10))
        return {
          ok: true,
          provider: 'local',
          query: safeQuery(args.query),
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

    // ═══ 7. 架构自检 ═══
    const ARCH_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'php'])
    const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.c', '.cpp', '.cc', '.h', '.hpp', '.cs', '.php', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.py', '/__init__.py']

    function resolveModule(baseFile, rel, fileSet) {
      const parts = baseFile.split('/')
      parts.pop()
      for (const seg of rel.split('/')) {
        if (seg === '.' || seg === '') continue
        if (seg === '..') parts.pop()
        else parts.push(seg)
      }
      const base = parts.join('/')
      for (const suffix of RESOLVE_EXTS) {
        if (fileSet.has(base + suffix)) return base + suffix
      }
      return undefined
    }

    function extractImports(text, lang) {
      const out = []
      if (lang === 'py') {
        const re = /^\s*from\s+(\.+[\w.]*)\s+import|^\s*import\s+(\.+[\w.]+)/gm
        let m
        while ((m = re.exec(text)) !== null) {
          const spec = m[1] || m[2]
          if (spec && spec.startsWith('.')) out.push(spec)
        }
      } else if (lang === 'go') {
        const re = /^\s*"([^"]+)"/gm
        let m
        while ((m = re.exec(text)) !== null) {
          if (m[1]) out.push(m[1])
        }
      } else {
        const re = /(?:import\s+(?:[^'"]*?\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
        let m
        while ((m = re.exec(text)) !== null) {
          if (m[1] && (m[1].startsWith('./') || m[1].startsWith('../'))) out.push(m[1])
        }
      }
      return out
    }

    function findCycles(graph, maxCycles) {
      const cycles = []
      const color = new Map()
      const stack = []
      const nodes = Object.keys(graph)
      const visit = (node) => {
        color.set(node, 1)
        stack.push(node)
        for (const dep of graph[node] || []) {
          if (color.get(dep) === 1) {
            const idx = stack.indexOf(dep)
            if (idx >= 0) {
              const cycle = stack.slice(idx).concat(dep)
              if (cycle.length <= 12) cycles.push({ path: cycle, length: cycle.length })
              if (cycles.length >= maxCycles) return true
            }
          } else if (color.get(dep) === undefined) {
            if (visit(dep)) return true
          }
        }
        stack.pop()
        color.set(node, 2)
        return false
      }
      for (const n of nodes) {
        if (color.get(n) === undefined) {
          if (visit(n)) break
        }
      }
      return cycles
    }

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
        if (!rootPath) {
          const policy = ctx.get('sandboxPolicy')
          rootPath = policy && policy.workspaceRoot ? policy.workspaceRoot : ''
        }
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
          collected = await collectFiles(rootTarget, ARCH_EXTS, exec.signal, fileSet)
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
          const deps = extractImports(text, lang)
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
              const r = resolveModule(path, dep, fileSet)
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

        const cycles = findCycles(graph, maxCycles)

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

    // ═══ 8. 复用价值评估 ═══
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
        const requirement = safeQuery(args.requirement)
        if (requirement === '') throw new Error('requirement 不能为空')
        const words = assessWords(requirement)
        if (words.length === 0) return { ok: false, message: 'requirement 中未找到有效关键词（描述过短或全为停用词）' }
        const cfg = defaultConfig(args)
        const localPaths = String(args.localCandidates || '').split(',').map((p) => p.trim()).filter(Boolean).slice(0, 5)
        const result = await assessCandidates(requirement, localPaths, args.remoteCandidate, cfg, exec.signal)
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
          remoteCandidate: result.remote,
          decision: result.decision,
        }
      },
    })

    // ═══ 9. 复用调查：调查 → 价值权衡 → 询问用户 ═══
    ctx.tools.register({
      name: 'reuse_survey',
      description:
        '复用调查（需求澄清后调用）：先自动调查本地代码库与开源平台的可复用候选并评估价值权衡，'
        + '然后把"候选清单 + 价值对比"呈现给用户并询问是否复用（用户可选择复用哪个候选/改造/不复用直接开发）。'
        + '若政策文件配置 reuseMode="auto"（或传 ask=false）则不询问，直接采用评估给出的推荐决策（优先复用）。'
        + '适合在澄清需求之后、开始写代码之前调用一次。',
      parameters: {
        type: 'object',
        properties: {
          requirement: { type: 'string', description: '目标需求/功能描述（建议含英文术语关键词），调查与评估的基准' },
          root: { type: 'string', description: '本地检索根目录（绝对路径）；省略时使用当前工作区根目录' },
          remoteSearch: { type: 'boolean', default: true, description: '是否同时调查开源平台（GitHub/npm 等），默认 true' },
          ask: { type: 'boolean', description: '是否询问用户；省略时读政策 reuseMode（默认询问）；false 时不询问直接返回推荐决策' },
          reuseThreshold: { type: 'integer', description: '直接复用匹配度阈值，默认 70' },
          adaptThreshold: { type: 'integer', description: '改造复用匹配度阈值，默认 40' },
          remoteThreshold: { type: 'integer', description: '远程候选匹配度阈值，默认 50' },
        },
        required: ['requirement'],
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: 120000,
      presentCall: (args) => ({ card: 'generic', kind: 'read', title: '复用调查: ' + String((args && args.requirement) || '') }),
      async execute(args, exec) {
        const requirement = safeQuery(args.requirement)
        if (requirement === '') throw new Error('requirement 不能为空')
        const cfg = defaultConfig(args)

        // 1) 本地调查
        const local = await collectLocalCandidates(requirement, args.root, exec.signal)
        if (local.error) return { ok: false, message: local.error }
        const localPaths = local.candidates.slice(0, 5).map((c) => c.path)

        // 2) 开源调查（GitHub 为主）
        let remoteSpec
        if (args.remoteSearch !== false) {
          const query = safeQuery(args.requirement)
          const r = await apiRequest('https://api.github.com/search/repositories?q='
            + encodeURIComponent(query + ' archived:false') + '&sort=stars&order=desc&per_page=5',
            { signal: exec.signal })
          if (r.error === undefined && r.status === 200) {
            const parsed = parseJson(r)
            if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) {
              const top = parsed.items[0]
              remoteSpec = top.full_name
            }
          }
        }

        // 3) 价值权衡评估
        const result = await assessCandidates(requirement, localPaths, remoteSpec, cfg, exec.signal)
        if (result.error) return { ok: false, message: result.error }

        // 4) 权衡摘要
        const lines = []
        lines.push('需求：' + requirement)
        if (result.locals.length > 0) {
          lines.push('本地候选（' + result.locals.length + ' 个）：')
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
        if (result.remote && !result.remote.error) {
          lines.push('开源候选：' + (result.remote.fullName || result.remote.name) + '（匹配 ' + result.remote.matchScore + '/100，' + (result.remote.active ? '维护活跃' : '维护沉寂') + '，许可证 ' + (result.remote.license || '未知') + '，' + (result.remote.stars || 0) + ' stars）')
        } else if (args.remoteSearch !== false) {
          lines.push('开源平台未发现合适候选。')
        }
        if (result.policy && result.policy.note) lines.push('政策：' + result.policy.note)
        for (const c of result.checks) lines.push('政策检查[' + c.status + '] ' + c.detail)
        lines.push('推荐决策：' + result.decision.choice + '（' + result.decision.confidence + '）— ' + result.decision.reason)
        const summary = lines.join('\n')

        // 5) 询问用户（或按政策/参数跳过）
        const policyMode = result.policy && result.policy.data ? result.policy.data.reuseMode : 'ask'
        const shouldAsk = args.ask === undefined ? policyMode !== 'auto' : args.ask === true

        let answer = null
        if (shouldAsk) {
          const uq = ctx.get('userQuestions')
          if (uq === undefined) {
            return {
              ok: true,
              provider: 'reuse-survey',
              requirement,
              mode: 'auto-fallback',
              note: '用户询问服务不可用（当前上下文无法询问），已按推荐决策返回',
              survey: summary,
              localCandidates: result.locals,
              remoteCandidate: result.remote,
              policyChecks: result.checks,
              decision: result.decision,
            }
          }
          const options = []
          for (const l of result.locals) {
            if (l.error || l.verdict === 'not-suitable') continue
            const base = l.path.split('/').pop()
            options.push({
              label: '复用本地 ' + base + '（匹配 ' + l.matchScore + '/100，' + (l.effort ? l.effort.estimate : '') + '）',
              description: l.path,
            })
          }
          if (result.remote && !result.remote.error) {
            options.push({
              label: '复用开源 ' + (result.remote.fullName || result.remote.name) + '（匹配 ' + result.remote.matchScore + '/100）',
              description: '许可证 ' + (result.remote.license || '未知') + '，' + (result.remote.stars || 0) + ' stars',
            })
          }
          options.push({ label: '不复用，直接开发', description: '按从零实现处理（评估建议为 rewrite 时的默认选项）' })
          try {
            const askResult = await Promise.race([
              (async () => {
                const res = await uq.ask({
                  questions: [{
                    id: 'reuse-choice',
                    header: '复用调查结果',
                    question: '是否需要复用已有代码？以下是调查与价值权衡：',
                    detail: summary,
                    options,
                  }],
                  agent: exec.agent,
                  signal: exec.signal,
                })
                const item = res && res.answers && res.answers[0]
                return item ? { selected: item.selected || [], custom: item.custom || '' } : null
              })(),
              new Promise((resolve) => {
                ctx.timeout(() => resolve({ timeout: true }), 90000)
              }),
            ])
            if (askResult && askResult.timeout) {
              answer = { error: '等待用户回答超时（90 秒）。若当前上下文无法询问用户，请用 ask=false 跳过询问。' }
            } else {
              answer = askResult
            }
          } catch (error) {
            answer = { error: String((error && error.message) || error) }
          }
        }

        return {
          ok: true,
          provider: 'reuse-survey',
          requirement,
          mode: shouldAsk ? 'ask' : 'auto',
          survey: summary,
          localCandidates: result.locals,
          remoteCandidate: result.remote,
          policyChecks: result.checks,
          decision: result.decision,
          answer,
        }
      },
    })

    // ═══ 系统提示词：需求澄清后调查并询问，不再机械拦截 ═══
    ctx.systemPrompt.section({
      name: 'tool:code-reference',
      order: 120,
      text:
        'CODE REUSE WORKFLOW (code-reference):\n'
        + '1. CLARIFY REQUIREMENTS FIRST, THEN SURVEY, THEN ASK. When the user asks you to develop a new project, '
        + 'component, or feature, first clarify the requirements (scope, language, constraints). After the '
        + 'requirements are clear, run the reuse_survey tool once before writing code: it investigates the local '
        + 'codebase (local_code_reuse_search logic) and open-source platforms (GitHub etc.), evaluates the '
        + 'reuse-vs-rewrite value tradeoff (reuse_value_assessment logic), and then ASKS the user which candidate '
        + 'to reuse (or whether to skip reuse and build from scratch) with the tradeoffs shown. Follow the user\'s '
        + 'choice. If the company policy file (.code-reference-policy.json) sets reuseMode="auto" (or the user '
        + 'prefers no asking), skip the question and adopt the recommended decision directly, preferring reuse.\n'
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
