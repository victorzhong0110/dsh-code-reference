// dsh-code-reference decision 流程测试（node:test，零依赖）
// 覆盖：scope 程序化豁免 / no-candidates / ask 用户选择映射 / 询问超时 /
//       auto-fallback / 政策优先级（reuseMode、remoteSearch）/ 参数优先级 / 宿主加载冒烟
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import decisionPlugin from '../plugins/decision.mjs'
import { createCore } from '../plugins/core.mjs'

// ═══ 测试脚手架 ═══

function makeSubprocessMock() {
  const body = JSON.stringify({ items: [{ full_name: 'remote/one' }, { full_name: 'remote/two' }] })
  return {
    async resolveExecutable() { return 'curl' },
    spawn() {
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: {
          stdout: { readFrom: () => ({ text: body + '\n__DSH_GH_STATUS__:200\n__DSH_GH_HEADERS__:{}' }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }
    },
  }
}

// 可配置的内存 fs：files = { 路径: 内容 }，dirs = { 目录: [entries] }
function makeFsMock({ files = {}, dirs = {} } = {}) {
  const calls = { listDir: 0, readText: 0 }
  return {
    calls,
    async resolve(p) { return p },
    async stat(target) { return Object.prototype.hasOwnProperty.call(files, target) || Object.prototype.hasOwnProperty.call(dirs, target) ? {} : null },
    async readText(target) {
      calls.readText++
      if (Object.prototype.hasOwnProperty.call(files, target)) return files[target]
      throw new Error('ENOENT: ' + target)
    },
    async listDir(dir) {
      calls.listDir++
      return dirs[dir] || []
    },
    processPath(t) { return t },
  }
}

// 构造 decision 插件的 mock 宿主 ctx，并返回注册的工具表
function boot({ files, dirs, policy = {}, userQuestions, timer, remoteSearchOverride, scopeOverride } = {}) {
  const fsMock = makeFsMock({ files, dirs })
  const core = createCore({
    subprocess: makeSubprocessMock(),
    web: undefined,
    fs: fsMock,
    sandboxPolicy: { workspaceRoot: '/ws' },
    env: {},
  })
  // spy：统计 githubSearchCandidates 调用次数（远程搜索开关验证）
  let remoteSearchCalls = 0
  const origGithub = core.githubSearchCandidates
  core.githubSearchCandidates = async (...a) => { remoteSearchCalls++; return origGithub(...a) }

  const tools = []
  const ctx = {
    codeRef: core,
    tools: { register: (t) => tools.push(t) },
    // decision.mjs 通过 ctx.timeout 访问 timer 服务（90 秒询问超时）
    timeout: timer || (() => ({ dispose: () => {} })),
    systemPrompt: { section: () => {} },
    sandboxPolicy: { workspaceRoot: '/ws' },
    userQuestions,
  }
  decisionPlugin.apply(ctx)
  const survey = tools.find((t) => t.name === 'reuse_survey')
  assert.ok(survey, '应注册 reuse_survey 工具')
  const exec = { signal: undefined, agent: 'test-agent' }
  const run = (args) => survey.execute(Object.assign({ requirement: 'search index 检索' }, args), exec)
  return { survey, run, fsMock, remoteSearchCalls: () => remoteSearchCalls, core }
}

// ═══ 宿主加载冒烟 ═══

describe('decision 插件宿主加载冒烟', () => {
  test('export default 形状正确（name/inject/apply）', () => {
    assert.equal(decisionPlugin.name, 'code-ref-decision')
    assert.ok(Array.isArray(decisionPlugin.inject))
    assert.equal(typeof decisionPlugin.apply, 'function')
  })
  test('apply 注册 reuse_value_assessment 与 reuse_survey 两个工具', () => {
    const { survey } = boot()
    assert.equal(survey.name, 'reuse_survey')
    assert.ok(survey.parameters && survey.parameters.properties)
    assert.ok(survey.parameters.properties.scope)
  })
})

// ═══ scope 程序化豁免 ═══

describe('scope=skip 程序化小任务豁免', () => {
  test('直接返回 minor-skip，不读文件不弹窗不访问远程', async () => {
    const { run, fsMock, remoteSearchCalls } = boot({ scopeOverride: true })
    const r = await run({ scope: 'skip' })
    assert.equal(r.mode, 'minor-skip')
    assert.equal(r.answer.status, 'skipped')
    assert.equal(r.answer.reason, 'minor-scope')
    assert.equal(r.survey.includes('未进行调查'), true)
    assert.equal(fsMock.calls.listDir, 0, '不应触发任何目录扫描')
    assert.equal(remoteSearchCalls(), 0, '不应触发远程搜索')
  })
  test('scope=auto 或省略时正常调查', async () => {
    const { run, fsMock } = boot()
    const r = await run({ scope: 'auto', remoteSearch: false })
    assert.equal(r.mode, 'no-candidates')
    assert.ok(fsMock.calls.listDir > 0, '应触发本地扫描')
  })
})

// ═══ no-candidates ═══

describe('no-candidates 模式', () => {
  test('无本地候选 + 关闭远程 + 无系统 → skipped(no-candidates)，不弹窗', async () => {
    const asked = []
    const { run } = boot({ userQuestions: { ask: async (q) => { asked.push(q); return { answers: [{ selected: [] }] } } }, dirs: {}, files: {} })
    const r = await run({ remoteSearch: false })
    assert.equal(r.mode, 'no-candidates')
    assert.equal(r.answer.status, 'skipped')
    assert.equal(r.answer.reason, 'no-candidates')
    assert.equal(asked.length, 0)
    assert.equal(r.decision.choice, 'rewrite')
  })
})

// ═══ 有候选时的询问流程 ═══

function candidateFixture() {
  return {
    dirs: { '/v': [{ name: 'search.ts', type: 'file', target: '/v/search.ts', size: 40 }] },
    files: { '/v/search.ts': 'export function searchItems() { return [] }\n' },
  }
}

describe('ask 询问流程', () => {
  test('用户选择映射到 answer.answered', async () => {
    const { run } = boot(Object.assign(candidateFixture(), {
      userQuestions: { ask: async () => ({ answers: [{ selected: ['复用本地 search.ts（匹配 50/100）'], custom: '' }] }) },
    }))
    const r = await run({ root: '/v', remoteSearch: false })
    assert.equal(r.mode, 'ask')
    assert.equal(r.answer.status, 'answered')
    assert.equal(r.answer.selected[0].includes('复用本地 search.ts'), true)
    assert.ok(r.survey.includes('本地文件候选'))
    assert.ok(r.localCandidates.length >= 1)
  })

  test('询问超时（timer 立即触发）→ unanswered(timeout)', async () => {
    const { run } = boot(Object.assign(candidateFixture(), {
      userQuestions: { ask: () => new Promise(() => { /* 永不返回 */ }) },
      timer: (fn) => { fn(); return { dispose: () => {} } },
    }))
    const r = await run({ root: '/v', remoteSearch: false })
    assert.equal(r.mode, 'ask')
    assert.equal(r.answer.status, 'unanswered')
    assert.equal(r.answer.reason, 'timeout')
    assert.ok(r.answer.error.includes('90 秒'))
  })

  test('userQuestions 不可用 → auto-fallback（unanswered/ask-unavailable）', async () => {
    const { run } = boot(Object.assign(candidateFixture(), { userQuestions: undefined }))
    const r = await run({ root: '/v', remoteSearch: false })
    assert.equal(r.mode, 'auto-fallback')
    assert.equal(r.answer.status, 'unanswered')
    assert.equal(r.answer.reason, 'ask-unavailable')
  })

  test('answer 为 null（auto 模式不询问）', async () => {
    const { run } = boot(Object.assign(candidateFixture(), { userQuestions: { ask: async () => { throw new Error('不应被调用') } } }))
    const r = await run({ root: '/v', remoteSearch: false, ask: false })
    assert.equal(r.mode, 'auto')
    assert.equal(r.answer, null)
  })
})

// ═══ 政策优先级 ═══

describe('政策文件优先级（reuseMode / remoteSearch）', () => {
  const policyFixture = (policyJson) => ({
    dirs: { '/ws': [{ name: 'x.ts', type: 'file', target: '/ws/x.ts', size: 30 }] },
    files: {
      '/ws/x.ts': 'export function search() {}\n',
      '/ws/.code-reference-policy.json': policyJson,
    },
  })

  test('政策 reuseMode=auto → ask 省略时 mode=auto 不询问', async () => {
    const { run } = boot(Object.assign(policyFixture(JSON.stringify({ reuseMode: 'auto', remoteSearch: false })), {
      userQuestions: { ask: async () => { throw new Error('不应被调用') } },
    }))
    const r = await run({ root: '/ws' })
    assert.equal(r.mode, 'auto')
    assert.equal(r.answer, null)
    assert.ok(r.policyChecks !== undefined)
  })

  test('政策 remoteSearch=false → 不调用远程搜索', async () => {
    const { run, remoteSearchCalls } = boot(Object.assign(policyFixture(JSON.stringify({ reuseMode: 'ask', remoteSearch: false })), {
      userQuestions: { ask: async () => ({ answers: [{ selected: [], custom: '' }] }) },
    }))
    await run({ root: '/ws' })
    assert.equal(remoteSearchCalls(), 0)
  })

  test('显式 remoteSearch=true 覆盖政策 remoteSearch=false', async () => {
    const { run, remoteSearchCalls } = boot(Object.assign(policyFixture(JSON.stringify({ reuseMode: 'ask', remoteSearch: false })), {
      userQuestions: { ask: async () => ({ answers: [{ selected: [], custom: '' }] }) },
    }))
    const r = await run({ root: '/ws', remoteSearch: true })
    assert.ok(remoteSearchCalls() > 0, '显式参数应覆盖政策')
    assert.ok(r.remoteCandidates.length >= 1)
  })

  test('政策 note 进入调查摘要', async () => {
    const { run } = boot(Object.assign(policyFixture(JSON.stringify({ reuseMode: 'auto', remoteSearch: false })), {}))
    const r = await run({ root: '/ws' })
    assert.ok(r.survey.includes('政策：已加载公司政策文件'))
    assert.equal(r.mode, 'auto')
  })
})
