// dsh-code-reference core 服务（与动态版 crfco-2/pkg-27 一致）
export default {
  name: 'code-ref-core',
  inject: ['subprocess', 'web', 'fs', 'sandboxPolicy'],
  apply(ctx) {
    const README_CHARS = 6000
    const FILE_CHARS = 8000
    const MAX_FILES = 3
    const STATUS_MARKER = '__DSH_GH_STATUS__:'
    const HEADER_MARKER = '__DSH_GH_HEADERS__:'
    const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.c', '.cpp', '.cc', '.h', '.hpp', '.cs', '.php', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.py', '/__init__.py']

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

    async function collectFiles(rootTarget, allowedExts, signal, fileSet, budget) {
      const pending = []
      const stack = [rootTarget]
      let scanned = 0
      let truncated = false
      const start = Date.now()
      const fileBudget = budget && budget.fileBudget ? budget.fileBudget : MAX_SCAN_FILES
      const timeBudget = budget && budget.timeBudgetMs ? budget.timeBudgetMs : 0
      while (stack.length > 0) {
        if (signal && signal.aborted) throw new Error('检索已取消')
        if (timeBudget > 0 && Date.now() - start > timeBudget) {
          truncated = true
          break
        }
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
            if (scanned >= fileBudget) {
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

    async function collectLocalCandidates(query, rootPath, signal, budget) {
      const words = queryWords(query)
      if (words.length === 0) return { words, candidates: [], scanned: 0, truncated: false }
      const exts = CODE_EXTS
      let root = String(rootPath || '').trim()
      if (!root) {
        root = ctx.sandboxPolicy.workspaceRoot || ''
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
        collected = await collectFiles(rootTarget, exts, signal, undefined, budget)
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
      const readStart = Date.now()
      const readBudgetMs = budget && budget.timeBudgetMs ? budget.timeBudgetMs : 0
      for (let i = 0; i < pending.length; i += 8) {
        if (signal && signal.aborted) return { words, candidates: [], scanned: 0, truncated: collected.truncated, error: '检索已取消' }
        if (readBudgetMs > 0 && Date.now() - readStart > readBudgetMs) break
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
      const ws = ctx.sandboxPolicy.workspaceRoot || ''
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

    function buildPolicyChecks(policy, locals, remotes) {
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
      if (p.allowedLicenses.length > 0 && Array.isArray(remotes)) {
        for (const r of remotes) {
          if (!r.error && r.license) {
            const ok = p.allowedLicenses.some((x) => String(x).toLowerCase() === String(r.license).toLowerCase())
            if (!ok) {
              r.blocked = true
              checks.push({ rule: 'license', status: 'fail', detail: '候选许可证 ' + r.license + ' 不在公司允许列表（' + p.allowedLicenses.join(', ') + '）中' })
            }
          }
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
      const licenseBlocked = remote ? checks.some((c) => c.rule === 'license' && c.status === 'fail' && c.detail.indexOf(remote.license || '') >= 0) : false
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

    async function githubSearchCandidates(words, signal) {
      const ascii = words.filter((w) => /^[a-zA-Z0-9_]+$/.test(w))
      if (ascii.length === 0) return []
      const seen = new Set()
      const attempts = []
      for (const n of [6, 4, 3]) {
        const group = ascii.slice(0, n).join(' ')
        if (!seen.has(group)) {
          seen.add(group)
          attempts.push(group)
        }
      }
      if (attempts.length === 0) attempts.push(ascii.join(' '))
      for (const q of attempts) {
        const r = await apiRequest('https://api.github.com/search/repositories?q='
          + encodeURIComponent(q + ' archived:false') + '&sort=stars&order=desc&per_page=8',
          { signal })
        if (r.error === undefined && r.status === 200) {
          const parsed = parseJson(r)
          if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) {
            return parsed.items.slice(0, 5).map((i) => i.full_name).filter(Boolean)
          }
        }
      }
      return []
    }

    async function assessCandidates(requirement, localPaths, remoteSpecs, cfg, signal) {
      const words = assessWords(requirement)
      const policy = await loadPolicy(undefined, localPaths, signal)
      const locals = []
      for (const p of localPaths) {
        const a = await analyzeLocalCandidate(p, words, signal)
        locals.push(a)
        if (signal && signal.aborted) return { words, policy, locals, remotes: [], checks: [], error: '评估已取消' }
      }
      const remotes = []
      if (Array.isArray(remoteSpecs)) {
        for (const spec of remoteSpecs) {
          const r = await analyzeRemoteCandidate(spec, words, signal)
          if (r && !r.error) remotes.push(r)
          if (signal && signal.aborted) return { words, policy, locals, remotes, checks: [], error: '评估已取消' }
        }
      }
      remotes.sort((a, b) => b.matchScore - a.matchScore)
      const checks = buildPolicyChecks(policy, locals, remotes)
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
      for (const r of remotes) {
        r.reasons = []
        r.reasons.push('描述匹配 ' + r.matchScore + '/100')
        const m = r.lastUpdated || r.lastPublish || ''
        const mm = monthsSince(m)
        if (mm !== null) r.reasons.push('最近更新于 ' + mm + ' 个月前（' + (mm < 12 ? '维护活跃' : '维护沉寂') + '）')
        r.reasons.push((r.stars || 0) + ' stars')
        r.reasons.push(r.license ? '许可证 ' + r.license : '许可证未知')
        if (r.blocked) r.reasons.push('被公司许可证政策排除')
      }
      const usableLocal = locals.filter((l) => !l.error && l.verdict !== 'not-suitable')
      const bestLocal = usableLocal.length > 0
        ? usableLocal.sort((a, b) => (b.matchScore + (b.verdict === 'direct-reuse' ? 100 : 0)) - (a.matchScore + (a.verdict === 'direct-reuse' ? 100 : 0)))[0]
        : undefined
      const bestRemote = remotes.find((r) => !r.blocked)
      const decision = decide(bestLocal, bestRemote, cfg, checks)
      return { words, policy, locals, remotes, bestRemote, checks, bestLocal, decision }
    }

    ctx.provide('codeRef', {
      apiRequest,
      rateLimitInfo,
      apiError,
      parseJson,
      webSearchFallback,
      safeQuery,
      clampLimit,
      encodePath,
      collectFiles,
      collectLocalCandidates,
      queryWords,
      assessWords,
      analyzeLocalCandidate,
      analyzeRemoteCandidate,
      assessCandidates,
      loadPolicy,
      buildPolicyChecks,
      decide,
      defaultConfig,
      githubSearchCandidates,
      monthsSince,
      extToLanguage,
      matchScoreOf,
      README_CHARS,
      FILE_CHARS,
      MAX_FILES,
      ARCH_EXTS: new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'php']),
      RESOLVE_EXTS,
      resolveModule,
      extractImports,
      findCycles,
    })

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
  },
}
