#!/usr/bin/env node
// dsh-code-reference bundle manifest 校验（CI 用，零依赖）
// 检查：package.json 声明 dsh.bundle；patch 文件存在；patch 中每个 name 行
// 以包名子路径引用且对应文件存在于仓库；exports 允许该子路径。
import { readFileSync, existsSync } from 'node:fs'

const fail = (msg) => { console.error('❌ ' + msg); process.exit(1) }
const ok = (msg) => console.log('✅ ' + msg)

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const bundle = pkg.dsh && pkg.dsh.bundle
if (!bundle || !bundle.patch) fail('package.json 缺少 dsh.bundle.patch 声明')
ok('dsh.bundle.patch = ' + bundle.patch)

if (!existsSync(bundle.patch)) fail('patch 文件不存在: ' + bundle.patch)
const patchText = readFileSync(bundle.patch, 'utf8')
if (!patchText.includes('- insert:')) fail('patch 缺少 insert 段')

const name = pkg.name
const exportsMap = pkg.exports || {}
const lines = patchText.split('\n')
let refs = 0
for (const line of lines) {
  const m = /^\s+name:\s*(\S+)/.exec(line)
  if (!m) continue
  const ref = m[1]
  if (!ref.startsWith(name + '/')) fail('patch 行未以包名子路径引用: ' + ref + '（应为 ' + name + '/...）')
  const rel = ref.slice(name.length + 1)
  if (!existsSync(rel)) fail('patch 引用的文件不存在: ' + rel)
  // exports 子路径通配检查：./plugins/*.mjs
  const allowed = Object.keys(exportsMap).some((k) => {
    if (!k.includes('*')) return k.replace(/^\.\//, '') === rel
    const [prefixRaw, suffix] = k.split('*')
    const prefix = prefixRaw.replace(/^\.\//, '')
    return rel.startsWith(prefix) && rel.endsWith(suffix)
  })
  if (!allowed) fail('exports 未允许子路径: ' + rel)
  refs++
  ok('插件入口: ' + ref)
}
if (refs < 3) fail('patch 应引用至少 3 个插件入口，实际 ' + refs)

if (!existsSync('plugins/core.mjs') || !existsSync('plugins/tools.mjs') || !existsSync('plugins/decision.mjs')) {
  fail('plugins/ 缺少 core/tools/decision 三文件')
}
ok('bundle manifest 完整（' + name + ' v' + pkg.version + '，' + refs + ' 个插件入口）')

// ═══ inject 完整性：apply 内使用 ctx.<svc> 的服务必须声明在 inject（防部署 boot 失败）═══
for (const file of ['plugins/core.mjs', 'plugins/tools.mjs', 'plugins/decision.mjs']) {
  const src = readFileSync(file, 'utf8')
  const injectMatch = /inject:\s*\[([^\]]*)\]/.exec(src)
  if (!injectMatch) fail(file + ': 缺少 inject 声明')
  const inject = [...injectMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  const used = new Set()
  const re = /ctx\.([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(src)) !== null) used.add(m[1])
  // 排除非服务引用（ctx 局部对象的方法调用等）：只校验已知服务形态
  const missing = []
  for (const svc of used) {
    if (['subprocess', 'web', 'fs', 'sandboxPolicy', 'tools', 'timer', 'systemPrompt', 'userQuestions', 'codeRef', 'logger', 'router', 'waterfall'].includes(svc) && !inject.includes(svc)) {
      missing.push(svc)
    }
  }
  if (missing.length > 0) fail(file + ': apply 使用 ctx.' + missing.join(', ctx.') + ' 但 inject 未声明（当前 inject: ' + inject.join(', ') + '）')
  ok(file + ': inject 声明完整（' + inject.join(', ') + '）')
}
