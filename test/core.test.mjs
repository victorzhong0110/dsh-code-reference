// dsh-code-reference core 单元测试（node:test，无第三方依赖）
// 运行：node --test test/
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createCore, capabilityLabelsOf, architectureSimilarity, matchScoreOf,
  queryWords, assessWords, defaultConfig, effortOf, normalizePolicy,
  extToLanguage, extractImports, findCycles, resolveModule,
  buildPolicyChecks, decide, monthsSince, encodePath, parseJson,
  CODE_EXTS, SKIP_DIRS, parseFileTypes, mergePolicy,
} from '../plugins/core.mjs'

// ═══ 纯函数 ═══

describe('queryWords / assessWords', () => {
  test('提取英文与中文词、小写化、过滤短词、上限 8 个', () => {
    assert.deepEqual(queryWords('Markdown 编辑器 Syntax Highlighting'), ['markdown', '编辑器', 'syntax', 'highlighting'])
    assert.deepEqual(queryWords('a b c'), [])
  })
  test('assessWords 过滤停用词', () => {
    assert.deepEqual(assessWords('markdown editor with syntax highlighting for the web'), ['markdown', 'editor', 'syntax', 'highlighting', 'web'])
    assert.deepEqual(assessWords('the and with'), [])
  })
})

describe('capabilityLabelsOf', () => {
  test('中文需求提取 15 类中的能力标签', () => {
    const labels = capabilityLabelsOf('图书馆检索系统：图书检索、借阅归还、读者管理、馆藏分类')
    assert.deepEqual(labels, ['检索与索引', '元数据与分类', '资源与借还', '组织与机构', '管理后台'])
  })
  test('英文关键词同样命中并去重', () => {
    const labels = capabilityLabelsOf('user auth login admin dashboard report export')
    assert.ok(labels.includes('用户与权限'))
    assert.ok(labels.includes('管理后台'))
    assert.ok(labels.includes('报表与统计'))
    assert.ok(labels.includes('导入导出与批处理'))
  })
  test('空输入返回空数组', () => {
    assert.deepEqual(capabilityLabelsOf(''), [])
    assert.deepEqual(capabilityLabelsOf(undefined), [])
  })
})

describe('architectureSimilarity', () => {
  test('空需求相似度为 0', () => {
    const r = architectureSimilarity([], ['检索与索引'])
    assert.equal(r.similarity, 0)
    assert.deepEqual(r.overlap, [])
  })
  test('全重叠 = 100，部分重叠按比例', () => {
    assert.equal(architectureSimilarity(['A', 'B'], ['A', 'B', 'C']).similarity, 100)
    assert.equal(architectureSimilarity(['A', 'B'], ['A', 'C']).similarity, 50)
    assert.equal(architectureSimilarity(['A', 'B'], ['C']).similarity, 0)
  })
  test('返回 overlap 与 missing', () => {
    const r = architectureSimilarity(['A', 'B'], ['A', 'C'])
    assert.deepEqual(r.overlap, ['A'])
    assert.deepEqual(r.missing, ['B'])
  })
})

describe('matchScoreOf', () => {
  test('ASCII：内容 70% + 文件名 30%', () => {
    assert.equal(matchScoreOf('src/search.ts', 'export function searchItems() { return [] }', ['search', 'index']), 50)
  })
  test('中文词按内容命中计分', () => {
    assert.equal(matchScoreOf('src/x.ts', '// 用户认证登录', ['用户', '认证']), 100)
  })
  test('无命中返回 0', () => {
    assert.equal(matchScoreOf('src/x.ts', 'hello world', ['unrelated', 'stuff']), 0)
  })
})

describe('defaultConfig', () => {
  test('默认阈值', () => {
    assert.deepEqual(defaultConfig({}), { reuseThreshold: 70, adaptThreshold: 40, remoteThreshold: 50, smallLines: 300, mediumLines: 800, maxComplexityPercent: 12 })
  })
  test('越界钳制与 adapt<=reuse', () => {
    const cfg = defaultConfig({ reuseThreshold: 20, adaptThreshold: 50, maxComplexityPercent: 999 })
    assert.equal(cfg.reuseThreshold, 20)
    assert.equal(cfg.adaptThreshold, 20)
    assert.equal(cfg.maxComplexityPercent, 100)
  })
})

describe('effortOf', () => {
  const cfg = defaultConfig({})
  test('高匹配 + 小代码 + 低复杂度 → low', () => {
    assert.equal(effortOf(80, 100, 0.05, cfg).level, 'low')
  })
  test('中匹配或中规模 → medium', () => {
    assert.equal(effortOf(50, 500, 0.05, cfg).level, 'medium')
    assert.equal(effortOf(20, 100, 0.2, cfg).level, 'medium')
  })
  test('低匹配 + 大代码 → high', () => {
    assert.equal(effortOf(20, 2000, 0.2, cfg).level, 'high')
  })
})

describe('normalizePolicy', () => {
  test('默认值：ask + remoteSearch 开启', () => {
    const p = normalizePolicy({})
    assert.equal(p.reuseMode, 'ask')
    assert.equal(p.remoteSearch, true)
    assert.deepEqual(p.allowedLicenses, [])
    assert.deepEqual(p.blockedLanguages, [])
    assert.equal(p.requireTests, false)
    assert.equal(p.minCommentRatio, 0)
  })
  test('auto + remoteSearch=false 生效', () => {
    const p = normalizePolicy({ reuseMode: 'auto', remoteSearch: false })
    assert.equal(p.reuseMode, 'auto')
    assert.equal(p.remoteSearch, false)
  })
})

describe('extToLanguage', () => {
  test('扩展名映射与未知扩展回退', () => {
    assert.equal(extToLanguage('a.ts'), 'typescript')
    assert.equal(extToLanguage('a.py'), 'python')
    assert.equal(extToLanguage('a.go'), 'go')
    assert.equal(extToLanguage('a.unknown'), 'unknown')
    assert.equal(extToLanguage('noext'), '')
  })
})

describe('extractImports', () => {
  test('JS 相对导入', () => {
    assert.deepEqual(extractImports("import { x } from './foo'\nimport y from '../bar.ts'\nimport z from 'pkg'", 'js'), ['./foo', '../bar.ts'])
  })
  test('Python 相对导入', () => {
    const out = extractImports('from .models import User\nfrom . import utils\nimport os', 'py')
    assert.ok(out.includes('.models'))
    assert.ok(out.includes('.'))
    assert.ok(!out.includes('os'))
  })
  test('Go 导入提取', () => {
    const out = extractImports('"strings"\n"fmt"', 'go')
    assert.ok(out.includes('strings'))
    assert.ok(out.includes('fmt'))
  })
})

describe('findCycles', () => {
  test('检测单环', () => {
    const cycles = findCycles({ a: ['b'], b: ['c'], c: ['a'] }, 5)
    assert.equal(cycles.length, 1)
    assert.deepEqual(cycles[0].path, ['a', 'b', 'c', 'a'])
  })
  test('无环返回空', () => {
    assert.deepEqual(findCycles({ a: ['b'], b: [] }, 5), [])
  })
  test('环数量上限', () => {
    const cycles = findCycles({ a: ['b'], b: ['a'], c: ['d'], d: ['c'] }, 1)
    assert.equal(cycles.length, 1)
  })
})

describe('resolveModule', () => {
  test('扩展名解析', () => {
    assert.equal(resolveModule('/p/src/a.ts', '../lib/b', new Set(['/p/lib/b.ts', '/p/lib/b/index.ts'])), '/p/lib/b.ts')
  })
  test('index 解析', () => {
    assert.equal(resolveModule('/p/src/a.ts', './dir', new Set(['/p/src/dir/index.ts'])), '/p/src/dir/index.ts')
  })
  test('未找到返回 undefined', () => {
    assert.equal(resolveModule('/p/src/a.ts', './nope', new Set(['/p/src/a.ts'])), undefined)
  })
})

describe('buildPolicyChecks', () => {
  test('禁止语言 → fail', () => {
    const checks = buildPolicyChecks({ data: { blockedLanguages: ['python'], allowedLicenses: [], requireTests: false, minCommentRatio: 0 } }, [{ path: 'a.py' }], [])
    assert.ok(checks.some((c) => c.rule === 'language' && c.status === 'fail'))
  })
  test('许可证白名单排除 → fail + blocked', () => {
    const remotes = [{ license: 'GPL-3.0' }]
    const checks = buildPolicyChecks({ data: { blockedLanguages: [], allowedLicenses: ['MIT'], requireTests: false, minCommentRatio: 0 } }, [], remotes)
    assert.equal(remotes[0].blocked, true)
    assert.ok(checks.some((c) => c.rule === 'license' && c.status === 'fail'))
  })
  test('requireTests 缺测试 → warn', () => {
    const checks = buildPolicyChecks({ data: { blockedLanguages: [], allowedLicenses: [], requireTests: true, minCommentRatio: 0 } }, [{ path: 'a.js', hasTest: false }], [])
    assert.ok(checks.some((c) => c.rule === 'tests' && c.status === 'warn'))
  })
  test('无政策 → 空检查', () => {
    assert.deepEqual(buildPolicyChecks({ data: null }, [], []), [])
  })
  test('未知许可证 → 默认阻断（fail + blocked），绝不显示"已通过"', () => {
    const remotes = [{ license: '' }]
    const checks = buildPolicyChecks({ data: { blockedLanguages: [], allowedLicenses: ['MIT'], requireTests: false, minCommentRatio: 0 } }, [], remotes)
    assert.equal(remotes[0].blocked, true)
    assert.ok(checks.some((c) => c.rule === 'license' && c.status === 'fail'))
    assert.ok(checks.some((c) => c.detail.includes('许可证未知')))
    // 有错误标记的候选不参与检查
    const errored = [{ error: 'api down', license: 'MIT' }]
    const checks2 = buildPolicyChecks({ data: { blockedLanguages: [], allowedLicenses: ['MIT'], requireTests: false, minCommentRatio: 0 } }, [], errored)
    assert.equal(errored[0].blocked, undefined)
    assert.equal(checks2.length, 0)
  })
  test('未知许可证候选 → 不推荐 dependency（rewrite 且说明被政策排除）', () => {
    const remotes = [{ license: '' }]
    const checks = buildPolicyChecks({ data: { blockedLanguages: [], allowedLicenses: ['MIT'], requireTests: false, minCommentRatio: 0 } }, [], remotes)
    const d = decide(undefined, { matchScore: 80, active: true, license: '' }, defaultConfig({}), checks)
    assert.equal(d.choice, 'rewrite')
    assert.ok(d.reason.includes('政策'))
  })
})

describe('parseFileTypes', () => {
  test('默认回退 CODE_EXTS（空/无效输入）', () => {
    assert.equal(parseFileTypes(undefined), CODE_EXTS)
    assert.equal(parseFileTypes(''), CODE_EXTS)
    assert.equal(parseFileTypes(' , , '), CODE_EXTS)
  })
  test('逗号分隔白名单：去点、小写、去空白', () => {
    assert.deepEqual(Array.from(parseFileTypes('TS, .tsx, js ')).sort(), ['js', 'ts', 'tsx'])
  })
  test('全无效条目回退默认', () => {
    assert.equal(parseFileTypes(' , '), CODE_EXTS)
  })
})

describe('mergePolicy（部署级上限 + 工作区仅可收紧）', () => {
  const dep = (over) => ({ source: '/etc/dsh/code-ref-policy.json', data: normalizePolicy(Object.assign({ allowedLicenses: ['MIT'], reuseMode: 'ask', remoteSearch: false }, over)) })
  const ws = (over) => ({ source: '/ws/.code-reference-policy.json', data: normalizePolicy(Object.assign({ allowedLicenses: ['MIT', 'Apache-2.0'], reuseMode: 'auto', remoteSearch: true }, over)) })

  test('工作区不能放宽部署级 remoteSearch=false / reuseMode=ask', () => {
    const m = mergePolicy(dep({}), ws({}))
    assert.equal(m.data.remoteSearch, false)
    assert.equal(m.data.reuseMode, 'ask')
    assert.ok(m.note.includes('仅可收紧'))
  })
  test('许可证白名单取交集（工作区不能扩大）', () => {
    const m = mergePolicy(dep({}), ws({ allowedLicenses: ['MIT', 'Apache-2.0', 'GPL-3.0'] }))
    assert.deepEqual(m.data.allowedLicenses, ['MIT'])
  })
  test('收紧字段取并集/最严：blockedLanguages 并集、requireTests OR、minCommentRatio max', () => {
    const m = mergePolicy(
      dep({ blockedLanguages: ['python'], requireTests: true, minCommentRatio: 0.1 }),
      ws({ blockedLanguages: ['ruby'], requireTests: false, minCommentRatio: 0.2 }),
    )
    assert.deepEqual(m.data.blockedLanguages.sort(), ['python', 'ruby'])
    assert.equal(m.data.requireTests, true)
    assert.equal(m.data.minCommentRatio, 0.2)
  })
  test('仅部署级 → 部署级字段生效；仅工作区 → 工作区字段生效', () => {
    const onlyDep = mergePolicy(dep({}), null)
    assert.equal(onlyDep.data.remoteSearch, false)
    assert.ok(onlyDep.note.includes('部署级'))
    const onlyWs = mergePolicy(null, ws({ allowedLicenses: ['MIT'] }))
    assert.deepEqual(onlyWs.data.allowedLicenses, ['MIT'])
    assert.equal(onlyWs.data.remoteSearch, true)
    assert.ok(onlyWs.note.includes('公司政策文件'))
  })
  test('双方皆无 → null', () => {
    assert.equal(mergePolicy(null, null), null)
    assert.equal(mergePolicy({ source: 'x', data: null }, { source: 'y', data: null }), null)
  })
  test('部署级未设白名单时工作区白名单生效', () => {
    const m = mergePolicy(dep({ allowedLicenses: [] }), ws({ allowedLicenses: ['MIT'] }))
    assert.deepEqual(m.data.allowedLicenses, ['MIT'])
  })
})

describe('decide', () => {
  const cfg = defaultConfig({})
  test('本地高匹配低成本 → reuse', () => {
    const d = decide({ matchScore: 80, effort: { level: 'low' }, hasTest: true }, undefined, cfg, [])
    assert.equal(d.choice, 'reuse')
  })
  test('维护活跃的开源候选 → dependency', () => {
    const d = decide(undefined, { matchScore: 80, active: true, license: 'MIT' }, cfg, [])
    assert.equal(d.choice, 'dependency')
  })
  test('许可证被政策排除 → 不推荐 dependency', () => {
    const checks = [{ rule: 'license', status: 'fail', detail: '候选许可证 GPL-3.0 不在公司允许列表（MIT）中' }]
    const d = decide(undefined, { matchScore: 80, active: true, license: 'GPL-3.0' }, cfg, checks)
    assert.equal(d.choice, 'rewrite')
  })
  test('无候选 → rewrite', () => {
    assert.equal(decide(undefined, undefined, cfg, []).choice, 'rewrite')
  })
})

describe('其他纯函数', () => {
  test('monthsSince 非法日期返回 null', () => {
    assert.equal(monthsSince('not-a-date'), null)
    assert.equal(monthsSince(''), null)
  })
  test('encodePath 编码特殊字符', () => {
    assert.equal(encodePath('a b/c.d'), 'a%20b/c.d')
  })
  test('parseJson 容错', () => {
    assert.deepEqual(parseJson({ body: '{"a":1}' }), { a: 1 })
    assert.equal(parseJson({ body: 'not json' }), undefined)
  })
})

// ═══ createCore：扫描边界与依赖注入（真实临时目录 + fs 适配器）═══

function makeFsAdapter() {
  return {
    async resolve(p) { return p },
    async listDir(dir) {
      const { readdirSync, statSync } = await import('node:fs')
      const entries = readdirSync(dir, { withFileTypes: true })
      return entries.map((e) => {
        const target = join(dir, e.name)
        const st = statSync(target)
        return {
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          target,
          size: st.size,
        }
      })
    },
    async readText(target) { const { readFileSync } = await import('node:fs'); return readFileSync(target, 'utf8') },
    async stat(target) { const { statSync } = await import('node:fs'); return statSync(target) ? {} : null },
    // 注意：processPath 在生产代码中为同步调用（无 await），此处必须保持同步
    processPath(target) { return target },
  }
}

describe('createCore 扫描边界', () => {
  let tmp
  let core
  const fsAdapter = makeFsAdapter()

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dsh-coderef-test-'))
    // 项目目录：应只收集 src/ 下的代码文件
    mkdirSync(join(tmp, 'proj', 'src'), { recursive: true })
    writeFileSync(join(tmp, 'proj', 'src', 'search.ts'), 'export function searchItems(q) { return [] } // 全文检索\n')
    writeFileSync(join(tmp, 'proj', 'src', 'index.ts'), "import { searchItems } from './search'\n")
    writeFileSync(join(tmp, 'proj', 'src', 'search.test.ts'), "import { test } from 'node:test'\n")
    // 应被 SKIP_DIRS 跳过的目录
    for (const d of ['node_modules', 'dist', 'vendor', 'tests', 'site-packages', 'docs']) {
      mkdirSync(join(tmp, 'proj', d), { recursive: true })
      writeFileSync(join(tmp, 'proj', d, 'x.js'), 'module.exports = 1\n')
    }
    // 超大文件（>256KB）应被跳过
    writeFileSync(join(tmp, 'proj', 'big.ts'), 'x'.repeat(300 * 1024))
    // 非代码扩展名应被跳过
    writeFileSync(join(tmp, 'proj', 'readme.md'), '# hi\n')
    writeFileSync(join(tmp, 'proj', 'data.json'), '{}')
    // 系统画像：systemA 有 3+ 文件，systemB 只有 1 个
    mkdirSync(join(tmp, 'systemA', 'api'), { recursive: true })
    mkdirSync(join(tmp, 'systemA', 'core'), { recursive: true })
    writeFileSync(join(tmp, 'systemA', 'api', 'user.py'), '# 用户认证登录 login user\n')
    writeFileSync(join(tmp, 'systemA', 'api', 'order.py'), '# order payment 订单支付\n')
    writeFileSync(join(tmp, 'systemA', 'core', 'models.py'), 'class Model: pass\n')
    mkdirSync(join(tmp, 'systemB'), { recursive: true })
    writeFileSync(join(tmp, 'systemB', 'tiny.py'), 'x = 1\n')
    // 政策文件
    writeFileSync(join(tmp, '.code-reference-policy.json'), JSON.stringify({ reuseMode: 'ask', remoteSearch: false }))

    core = createCore({ subprocess: undefined, web: undefined, fs: fsAdapter, sandboxPolicy: { workspaceRoot: tmp }, env: {} })
  })

  after(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('collectFiles 跳过 SKIP_DIRS / 超大文件 / 非代码扩展名', async () => {
    const rootTarget = join(tmp, 'proj')
    const collected = await core.collectFiles(rootTarget, CODE_EXTS, undefined, new Set())
    const names = collected.pending.map((p) => p.path.split('/').pop()).sort()
    assert.deepEqual(names, ['index.ts', 'search.test.ts', 'search.ts'])
    assert.equal(collected.truncated, false)
  })

  test('collectFiles 遵守 fileBudget 并标记 truncated', async () => {
    const collected = await core.collectFiles(join(tmp, 'proj'), CODE_EXTS, undefined, new Set(), { fileBudget: 1 })
    assert.equal(collected.truncated, true)
    assert.ok(collected.pending.length <= 1)
  })

  test('collectLocalCandidates 命中声明名（exact 优先）', async () => {
    const r = await core.collectLocalCandidates('search 检索', join(tmp, 'proj'), undefined, { fileBudget: 100 })
    assert.equal(r.error, undefined)
    assert.ok(r.candidates.some((c) => c.path.endsWith('search.ts') && c.score === 2))
  })

  test('collectLocalCandidates 未提供 root 时回退 workspaceRoot', async () => {
    const r = await core.collectLocalCandidates('search', undefined, undefined, { fileBudget: 50 })
    assert.ok(r.root === tmp || r.error)
  })

  test('collectLocalCandidates 支持 fileTypes 白名单', async () => {
    // proj/src 下有 ts 文件；临时加一个同关键词的 py 文件验证过滤
    writeFileSync(join(tmp, 'proj', 'src', 'search.py'), 'def search_items(): return []\n')
    try {
      const tsOnly = await core.collectLocalCandidates('search', join(tmp, 'proj'), undefined, { fileBudget: 100 }, 'ts,tsx')
      assert.ok(tsOnly.candidates.some((c) => c.path.endsWith('search.ts')))
      assert.ok(!tsOnly.candidates.some((c) => c.path.endsWith('search.py')))
      const pyOnly = await core.collectLocalCandidates('search', join(tmp, 'proj'), undefined, { fileBudget: 100 }, 'py')
      assert.ok(pyOnly.candidates.some((c) => c.path.endsWith('search.py')))
      assert.ok(!pyOnly.candidates.some((c) => c.path.endsWith('search.ts')))
      // 缺省（不传）时仍扫描默认扩展名
      const all = await core.collectLocalCandidates('search', join(tmp, 'proj'), undefined, { fileBudget: 100 })
      assert.ok(all.candidates.some((c) => c.path.endsWith('search.ts')))
      assert.ok(all.candidates.some((c) => c.path.endsWith('search.py')))
    } finally {
      rmSync(join(tmp, 'proj', 'src', 'search.py'), { force: true })
    }
  })

  test('assessCandidates 透传 policyPath（显式政策优先于工作区文件）', async () => {
    const explicit = join(tmp, 'explicit-policy.json')
    writeFileSync(explicit, JSON.stringify({ allowedLicenses: ['MIT'], reuseMode: 'ask', remoteSearch: false }))
    const r = await core.assessCandidates('search index 检索', [join(tmp, 'proj', 'src', 'search.ts')], [], defaultConfig({}), undefined, explicit)
    assert.ok(r.policy.source.includes(explicit))
    assert.equal(r.policy.data.remoteSearch, false)
    rmSync(explicit, { force: true })
  })

  test('extractSystemProfile 生成系统画像（忽略 <3 文件目录）', async () => {
    const profile = await core.extractSystemProfile(tmp, undefined, { maxSystems: 10, timeBudgetMs: 5000 })
    const names = profile.systems.map((s) => s.name)
    assert.ok(names.includes('systemA'))
    assert.ok(!names.includes('systemB'))
    assert.ok(!names.includes('proj') === false || names.includes('proj')) // proj 文件数>=3，应出现
    const sysA = profile.systems.find((s) => s.name === 'systemA')
    assert.ok(sysA.files >= 3)
    assert.ok(sysA.capabilities.includes('用户与权限'))
    assert.ok(sysA.capabilities.includes('订单与交易'))
  })

  test('loadPolicy 加载政策文件（remoteSearch=false 生效）', async () => {
    const policy = await core.loadPolicy(undefined, [join(tmp, 'proj', 'src', 'search.ts')], undefined)
    assert.equal(policy.data.remoteSearch, false)
    assert.equal(policy.data.reuseMode, 'ask')
  })

  test('loadPolicy：部署级政策是不可放宽的上限（DSH_CODE_REFERENCE_POLICY）', async () => {
    const deploy = join(tmp, 'deploy-policy.json')
    writeFileSync(deploy, JSON.stringify({ allowedLicenses: ['MIT'], reuseMode: 'ask', remoteSearch: false }))
    try {
      const core2 = createCore({ subprocess: undefined, web: undefined, fs: fsAdapter, sandboxPolicy: { workspaceRoot: tmp }, env: { DSH_CODE_REFERENCE_POLICY: deploy } })
      // 工作区文件声称 auto + remoteSearch true（仓库内容不可信场景）
      const policy = await core2.loadPolicy(undefined, [join(tmp, 'proj', 'src', 'search.ts')], undefined)
      assert.equal(policy.data.reuseMode, 'ask', '工作区 reuseMode=auto 不能放宽部署级 ask')
      assert.equal(policy.data.remoteSearch, false, '工作区 remoteSearch=true 不能放宽部署级 false')
      assert.deepEqual(policy.data.allowedLicenses, ['MIT'], '白名单取交集')
      assert.ok(policy.source.includes('deploy-policy.json'))
      assert.ok(policy.note.includes('仅可收紧'))
    } finally {
      rmSync(deploy, { force: true })
    }
  })

  test('loadPolicy：部署级文件缺失时给出明确提示（不静默）', async () => {
    const deploy = join(tmp, 'missing-deploy-policy.json')
    const core2 = createCore({ subprocess: undefined, web: undefined, fs: fsAdapter, sandboxPolicy: { workspaceRoot: tmp }, env: { DSH_CODE_REFERENCE_POLICY: deploy } })
    const policy = await core2.loadPolicy(undefined, [join(tmp, 'proj', 'src', 'search.ts')], undefined)
    assert.ok(policy.note.includes('不存在') || policy.note.includes('失败'), '缺失的部署级政策必须可见：' + policy.note)
  })

  test('analyzeLocalCandidate 统计与 hasTest 检测', async () => {
    const a = await core.analyzeLocalCandidate(join(tmp, 'proj', 'src', 'search.ts'), ['search'], undefined)
    assert.equal(a.lines, 2) // 内容 + 末尾换行
    assert.equal(a.hasTest, true) // 同目录存在 search.test.ts
    const b = await core.analyzeLocalCandidate(join(tmp, 'proj', 'src', 'index.ts'), ['index'], undefined)
    assert.equal(b.hasTest, false)
    assert.equal(b.matchScore, 30) // 仅文件名命中（30% 名称权重），内容未含关键词
  })

  test('analyzeLocalCandidate 对缺失文件返回 error', async () => {
    const a = await core.analyzeLocalCandidate(join(tmp, 'nope.ts'), ['x'], undefined)
    assert.ok(a.error)
  })
})

// ═══ createCore：远程 API mock（subprocess 桩）═══

describe('createCore 远程 API（subprocess mock）', () => {
  function makeMockSubprocess(body, status = 200, exitCode = 0) {
    const marker = '__DSH_GH_STATUS__:'
    const headerMarker = '__DSH_GH_HEADERS__:'
    const raw = body + '\n' + marker + String(status) + '\n' + headerMarker + '{}'
    return {
      async resolveExecutable() { return 'curl' },
      spawn() {
        return {
          done: Promise.resolve({ exitCode }),
          collected: {
            stdout: { readFrom: () => ({ text: raw }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
        }
      },
    }
  }

  test('apiRequest 解析状态码与响应体，携带 GitHub Token', async () => {
    const seen = []
    const subprocess = makeMockSubprocess('{"full_name":"a/b"}')
    const core = createCore({
      subprocess: {
        async resolveExecutable() { return 'curl' },
        spawn(opts) {
          seen.push(opts.argv)
          return {
            done: Promise.resolve({ exitCode: 0 }),
            collected: {
              stdout: { readFrom: () => ({ text: '{"full_name":"a/b"}' + '\n__DSH_GH_STATUS__:200\n__DSH_GH_HEADERS__:{}' }) },
              stderr: { readFrom: () => ({ text: '' }) },
            },
          }
        },
      },
      web: undefined, fs: {}, sandboxPolicy: {},
      env: { GITHUB_TOKEN: 'ghp_test123' },
    })
    const r = await core.apiRequest('https://api.github.com/repos/a/b')
    assert.equal(r.status, 200)
    assert.equal(core.parseJson(r).full_name, 'a/b')
    const argv = seen[0]
    assert.ok(argv.includes('Authorization: Bearer ghp_test123'))
  })

  test('Token 只附加给 api.github.com，不泄漏到其他域名', async () => {
    const seen = []
    const core = createCore({
      subprocess: {
        async resolveExecutable() { return 'curl' },
        spawn(opts) {
          seen.push(opts.argv)
          return {
            done: Promise.resolve({ exitCode: 0 }),
            collected: {
              stdout: { readFrom: () => ({ text: '\n__DSH_GH_STATUS__:200\n__DSH_GH_HEADERS__:{}' }) },
              stderr: { readFrom: () => ({ text: '' }) },
            },
          }
        },
      },
      web: undefined, fs: {}, sandboxPolicy: {},
      env: { GITHUB_TOKEN: 'ghp_test123' },
    })
    await core.apiRequest('https://registry.npmjs.org/some-package')
    assert.ok(!seen[0].some((x) => String(x).includes('Authorization')))
  })

  test('curl 不可用时返回 curl-unavailable', async () => {
    const core = createCore({
      subprocess: { async resolveExecutable() { throw new Error('not found') } },
      web: undefined, fs: {}, sandboxPolicy: {}, env: {},
    })
    const r = await core.apiRequest('https://api.github.com/x')
    assert.equal(r.error, 'curl-unavailable')
  })

  test('analyzeRemoteCandidate 解析 GitHub 仓库（npm 与 github 两种）', async () => {
    const core = createCore({
      subprocess: {
        async resolveExecutable() { return 'curl' },
        spawn(opts) {
          const url = opts.argv[opts.argv.length - 1]
          let body = '{}'
          if (url.includes('registry.npmjs.org')) {
            body = JSON.stringify({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { license: 'MIT', date: '2026-01-01T00:00:00Z' } }, description: 'a markdown editor library', time: { '1.0.0': '2026-01-01T00:00:00Z' } })
          } else if (url.includes('/repos/')) {
            body = JSON.stringify({ full_name: 'owner/repo', description: 'markdown editor for react', stargazers_count: 100, license: { spdx_id: 'MIT' }, updated_at: '2026-01-01T00:00:00Z' })
          }
          return {
            done: Promise.resolve({ exitCode: 0 }),
            collected: {
              stdout: { readFrom: () => ({ text: body + '\n__DSH_GH_STATUS__:200\n__DSH_GH_HEADERS__:{}' }) },
              stderr: { readFrom: () => ({ text: '' }) },
            },
          }
        },
      },
      web: undefined, fs: {}, sandboxPolicy: {}, env: {},
    })
    const words = ['markdown', 'editor']
    const gh = await core.analyzeRemoteCandidate('owner/repo', words, undefined)
    assert.equal(gh.kind, 'github')
    assert.equal(gh.license, 'MIT')
    assert.equal(gh.stars, 100)
    assert.equal(gh.active, true)
    const npm = await core.analyzeRemoteCandidate('npm:some-pkg', words, undefined)
    assert.equal(npm.kind, 'npm')
    assert.equal(npm.license, 'MIT')
  })

  test('githubSearchCandidates 多档关键词重试', async () => {
    const urls = []
    const core = createCore({
      subprocess: {
        async resolveExecutable() { return 'curl' },
        spawn(opts) {
          urls.push(opts.argv[opts.argv.length - 1])
          const body = JSON.stringify({ items: [{ full_name: 'a/b' }, { full_name: 'c/d' }] })
          return {
            done: Promise.resolve({ exitCode: 0 }),
            collected: {
              stdout: { readFrom: () => ({ text: body + '\n__DSH_GH_STATUS__:200\n__DSH_GH_HEADERS__:{}' }) },
              stderr: { readFrom: () => ({ text: '' }) },
            },
          }
        },
      },
      web: undefined, fs: {}, sandboxPolicy: {}, env: {},
    })
    const cands = await core.githubSearchCandidates(['markdown', 'editor', 'react', 'syntax'], undefined)
    assert.deepEqual(cands, ['a/b', 'c/d'])
    assert.ok(decodeURIComponent(urls[0]).includes('markdown editor react syntax'))
  })

  test('assessCandidates 端到端（本地 + 远程 + 政策）', async () => {
    const fs2 = {
      async resolve(p) { return p },
      async listDir(dir) { return [] },
      async readText(target) { return 'export function searchItems() {}' },
      async stat() { return {} },
      async processPath(t) { return t },
    }
    const core = createCore({
      subprocess: {
        async resolveExecutable() { return 'curl' },
        spawn() {
          const body = JSON.stringify({ full_name: 'x/y', description: 'search index library', stargazers_count: 10, license: { spdx_id: 'MIT' }, updated_at: new Date().toISOString() })
          return {
            done: Promise.resolve({ exitCode: 0 }),
            collected: {
              stdout: { readFrom: () => ({ text: body + '\n__DSH_GH_STATUS__:200\n__DSH_GH_HEADERS__:{}' }) },
              stderr: { readFrom: () => ({ text: '' }) },
            },
          }
        },
      },
      web: undefined, fs: fs2, sandboxPolicy: { workspaceRoot: tmpdir() }, env: {},
    })
    const result = await core.assessCandidates('search index 检索', ['/v/search.ts'], ['x/y'], defaultConfig({}), undefined)
    assert.equal(result.error, undefined)
    assert.equal(result.locals.length, 1)
    assert.equal(result.locals[0].verdict, 'adapt-reuse') // 匹配 50，介于 adapt(40) 与 reuse(70) 之间
    assert.equal(result.remotes.length, 1)
    assert.equal(result.decision.choice, 'adapt')
    assert.ok(result.decision.reason)
  })
})

// 防回归：确保 SKIP_DIRS 覆盖评审点出的第三方依赖目录
test('SKIP_DIRS 包含 site-packages 与常见第三方/产物目录', () => {
  for (const d of ['node_modules', 'dist', 'build', 'vendor', '.venv', 'site-packages', 'tests', 'test', 'e2e', '.git']) {
    assert.ok(SKIP_DIRS.has(d), 'SKIP_DIRS 应包含 ' + d)
  }
})
