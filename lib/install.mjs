// Background installer for a GitHub-hosted DSH plugin or skill.
// Spawned detached by index.js so it is not bound by the bridge's 60s handler timeout.
// usage: node install.mjs <github-url> <state-file> [profile]
//
// 策略链（依次尝试，全部失败才报错）：
//   A. DSH bundle 插件  —— package.json 有 dsh.bundle.patch
//   B. 技能集合仓库     —— 仓库内（含子目录）有多个 SKILL.md
//   C. 单一技能仓库     —— 根目录或单层子目录有 SKILL.md
//   D. README 指令解析  —— 从 README 里找 npx / npm i / dsh plugin add 等安装方式
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, renameSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const [repoUrlArg = '', stateFile = '', profile = 'web'] = process.argv.slice(2)
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CACHE = process.env.DSH_GH_INSTALLER_CACHE_DIR
  || join(DSH_HOME, 'dsh-go', 'plugins', 'dsh-gh-installer', 'cache')
const SKILLS_DIR = join(DSH_HOME, 'skills')

// 日志分两级：log() 进摘要（面板默认显示），trace() 进全量（面板可展开）
let state = { phase: 'start', message: '准备中…', log: [], trace: [], done: false, ok: false, strategy: '', detail: '' }
function save(patch = {}) {
  state = { ...state, ...patch }
  try {
    mkdirSync(dirname(stateFile), { recursive: true })
    const tmp = stateFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, stateFile)
  } catch {}
}
function log(line) {
  state.log.push(String(line).slice(0, 300))
  if (state.log.length > 60) state.log.shift()
  save()
}
/** 全量轨迹：每一步做了什么、HTTP 返回什么、命令输出什么。用户排查时看这个。 */
function trace(line) {
  state.trace.push(String(line).slice(0, 800))
  if (state.trace.length > 200) state.trace.shift()
  save()
}
async function get(url, tries = 5, label = '') {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer())
        trace(`GET ${label || url} → ${r.status} ${buf.length}B`)
        return buf
      }
      trace(`GET ${label || url} → ${r.status}（第 ${i + 1}/${tries} 次）`)
      if (r.status === 404) {
        // 404 是确定的「没有」，不必重试
        const e = new Error(`404 Not Found: ${label || url}`)
        e.status = 404
        throw e
      }
      log(`下载返回 ${r.status}，重试 ${i + 1}/${tries}`)
    } catch (e) {
      if (e.status === 404) throw e
      trace(`GET ${label || url} 失败：${e.message}（第 ${i + 1}/${tries} 次）`)
      log(`连接中断，重试 ${i + 1}/${tries}`)
    }
    await sleep(600 * (i + 1))
  }
  throw new Error('多次重试后仍无法下载：' + (label || url).slice(0, 140))
}
/** 试读一个文件，不存在返回 null。 */
async function tryGet(url, label) {
  try { return await get(url, 1, label) } catch { return null }
}

async function main() {
  save({ phase: 'parse', message: '解析地址…' })
  const m = String(repoUrlArg).trim().match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  if (!m) throw new Error('不是有效的 GitHub 仓库地址（需要 https://github.com/用户/仓库）')
  const [owner, repo] = [m[1], m[2]]
  trace(`目标仓库：${owner}/${repo}`)

  // ── 版本探测 ──
  save({ phase: 'tag', message: '查询版本…' })
  let tag = 'main'
  try {
    const raw = await get(`https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}`, 3, 'versions')
    const j = JSON.parse(raw.toString())
    if (j.versions?.[0]?.version) tag = j.versions[0].version
    trace(`可用版本：${(j.versions ?? []).slice(0, 5).map(v => v.version).join(', ') || '无'}`)
  } catch (e) {
    trace('版本查询失败，回退 main 分支：' + e.message)
  }
  log(`版本：${tag}`)

  // ── 文件清单（main 失败则试 master）──
  save({ phase: 'list', message: '读取文件清单…' })
  let files = []
  let usedTag = tag
  for (const t of [tag, 'master'].filter((v, i, a) => a.indexOf(v) === i)) {
    try {
      const raw = await get(`https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}@${t}?structure=flat`, 2, `list@${t}`)
      files = JSON.parse(raw.toString()).files?.map(f => f.name) ?? []
      if (files.length) { usedTag = t; break }
    } catch (e) { trace(`清单 @${t} 失败：${e.message}`) }
  }
  if (!files.length) throw new Error('没有取到文件清单（仓库可能为空或没有可访问的 tag/分支）')
  trace(`文件总数 ${files.length}，版本 ${usedTag}`)

  const work = mkdtempSync(join(tmpdir(), 'ghins-'))
  try {
    const cdn = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${usedTag}`
    const download = async (names, phaseLabel) => {
      let i = 0, skipped = 0
      const failed = []
      for (const name of names) {
        i++
        if (i % 8 === 0 || i === names.length) save({ phase: 'download', message: `${phaseLabel} ${i}/${names.length}` })
        const dest = join(work, name)
        mkdirSync(dirname(dest), { recursive: true })
        try {
          writeFileSync(dest, await get(cdn + name, 3, name))
        } catch (e) {
          skipped++
          failed.push(`${name}: ${e.message}`)
          trace(`跳过 ${name}：${e.message}`)
          try { rmSync(dest, { force: true }) } catch {}
        }
      }
      if (failed.length) trace(`下载失败/跳过 ${failed.length} 个：\n` + failed.slice(0, 20).join('\n'))
      log(`下载完成 ${names.length - skipped}/${names.length}${skipped ? `（跳过 ${skipped}）` : ''}`)
      return skipped
    }

    // ══ 策略 A：DSH bundle 插件 ══
    save({ phase: 'detect', message: '识别仓库类型…' })
    let pkgRaw = await tryGet(cdn + '/package.json', 'package.json')
    let pkg = null
    if (pkgRaw) {
      try { pkg = JSON.parse(pkgRaw.toString()) } catch (e) { trace('package.json 解析失败：' + e.message) }
    }
    trace(pkg ? `package.json: name=${pkg.name} version=${pkg.version} hasBundle=${Boolean(pkg.dsh?.bundle?.patch)}` : '没有 package.json')

    if (pkg?.dsh?.bundle?.patch) {
      save({ strategy: 'A', detail: `DSH 插件包 ${pkg.name}@${pkg.version}` })
      log(`识别为 DSH 插件：${pkg.name}@${pkg.version}`)
      return await installBundle({ pkg, files, cdn, work, download })
    }

    // ══ 策略 B/C：技能仓库（找 SKILL.md）══
    const skillFiles = files.filter(f => /(^|\/)SKILL\.md$/i.test(f))
    trace(`发现 SKILL.md ${skillFiles.length} 个：${skillFiles.slice(0, 12).join(', ')}`)

    if (skillFiles.length > 0) {
      // 只取技能目录本身：SKILL.md 所在目录及其下的 references/scripts/assets 等
      const dirs = [...new Set(skillFiles.map(f => f.replace(/\/SKILL\.md$/i, '')))]
      trace(`技能目录：${dirs.join(' | ')}`)
      // 关键优化：只下载技能目录内的文件，跳过仓库里其它无关目录（tests/、docs/、.github/ 等）
      const inSkillDir = (f) => {
        if (/(^|\/)(node_modules|\.git|\.github|dist|build)\//.test(f)) return false
        if (/\.(gif|mp4|mov|pdf|zip|tgz|woff2?|ttf)$/i.test(f)) return false
        return dirs.some(d => d === '' ? true : f === `${d}/SKILL.md` || f.startsWith(`${d}/`))
      }
      const keep = files.filter(inSkillDir)
      save({ strategy: skillFiles.length > 1 ? 'B' : 'C', detail: `${dirs.length} 个技能` })
      log(`识别为技能仓库：${dirs.length} 个技能，共 ${keep.length} 个文件`)
      await download(keep, '下载技能文件')

      const installed = []
      const conflicts = []
      for (const dir of dirs) {
        const name = dir.split('/').pop() || repo
        const dest = join(SKILLS_DIR, name)
        try {
          if (existsSync(join(dest, 'SKILL.md')) && !dir) {
            // 同名技能已存在：不覆盖，提醒用户
            conflicts.push(name)
            trace(`技能 ${name} 已存在，跳过覆盖`)
            continue
          }
          mkdirSync(dest, { recursive: true })
          // 把该技能目录下的内容整体复制过去
          const prefix = dir ? dir + '/' : ''
          let copied = 0
          for (const f of keep) {
            if (!f.startsWith(prefix)) continue
            const rel = f.slice(prefix.length)
            if (!rel) continue
            const src = join(work, f)
            if (!existsSync(src)) continue
            const target = join(dest, rel)
            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, readFileSync(src))
            copied++
          }
          if (copied > 0) { installed.push(name); trace(`安装技能 ${name}：${copied} 个文件 → ${dest}`) }
        } catch (e) {
          trace(`安装技能 ${name} 失败：${e.message}`)
        }
      }
      if (!installed.length) throw new Error('找到 SKILL.md 但没能复制任何文件' + (conflicts.length ? `（${conflicts.join('、')} 已存在，删掉旧目录再试）` : ''))
      const msg = installed.length === 1
        ? `已安装技能「${installed[0]}」，重启引擎后可用`
        : `已安装 ${installed.length} 个技能：${installed.slice(0, 3).join('、')}${installed.length > 3 ? '…' : ''}`
      if (conflicts.length) trace(`跳过的同名技能：${conflicts.join('、')}`)
      return save({ phase: 'done', message: msg, done: true, ok: true, skills: installed })
    }

    // ══ 策略 D：README 指令解析 ══
    log('未找到 SKILL.md，尝试从 README 识别安装方式…')
    const readmeRaw = await tryGet(cdn + '/README.md', 'README.md') || await tryGet(cdn + '/readme.md', 'readme.md')
    if (!readmeRaw) throw new Error('仓库里既没有 package.json/plugin 声明，也没有 SKILL.md 或 README.md，无法判断安装方式')
    const readme = readmeRaw.toString()
    trace(`README ${readme.length} 字符`)

    const plan = parseReadmeInstall(readme, { owner, repo, pkg })
    trace('README 解析结果：' + JSON.stringify(plan, null, 0).slice(0, 600))

    if (plan.kind === 'npm-package') {
      save({ strategy: 'D', detail: `README 指示 npm 包 ${plan.spec}` })
      log(`README 指向 npm 包：${plan.spec}`)
      save({ phase: 'install', message: `安装 npm 包 ${plan.spec}…` })
      const r = await run('dsh', ['plugin', '--profile', profile, 'add', plan.spec], { timeout: 300000 })
      const out = (r.stdout + r.stderr).trim()
      trace('dsh plugin add 输出：\n' + out)
      log(out.split('\n').filter(l => /^\+ |Done|error/i.test(l)).slice(-3).join(' | ') || '已安装')
      return save({
        phase: 'done', message: `已按 README 安装 ${plan.spec}，重启引擎后生效`, done: true, ok: true,
      })
    }

    if (plan.kind === 'dsh-plugin-add') {
      save({ strategy: 'D', detail: `README 指示 dsh plugin add ${plan.spec}` })
      save({ phase: 'install', message: '按 README 安装…' })
      const r = await run('dsh', ['plugin', '--profile', profile, 'add', plan.spec], { timeout: 300000 })
      const out = (r.stdout + r.stderr).trim()
      trace('输出：\n' + out)
      return save({ phase: 'done', message: `已按 README 安装，重启引擎后生效`, done: true, ok: true })
    }

    if (plan.kind === 'clone-skill' || plan.kind === 'manual') {
      // README 说要手动放目录：我们直接按通用技能方式装（有 .md 就当技能）
      const mdFiles = files.filter(f => f.toLowerCase().endsWith('.md'))
      if (mdFiles.length) {
        save({ strategy: 'D', detail: 'README 提示手动安装，按技能目录装入' })
        await download(files.filter(f => !/(^|\/)(node_modules|\.git)\//.test(f) && !/\.(gif|mp4|mov|pdf|zip)$/i.test(f)), '下载文件')
        const name = repo
        const dest = join(SKILLS_DIR, name)
        mkdirSync(dest, { recursive: true })
        let copied = 0
        for (const f of files) {
          const src = join(work, f)
          if (!existsSync(src)) continue
          const target = join(dest, f.replace(/^\//, ''))
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, readFileSync(src))
          copied++
        }
        if (copied) return save({ phase: 'done', message: `已装入技能目录「${name}」（${copied} 个文件），重启引擎后可用`, done: true, ok: true })
      }
    }

    throw new Error(plan.reason || 'README 里没有识别到可自动执行的安装方式，请查看全量日志')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ── 策略 A 的具体实现（已验证过）──
async function installBundle({ pkg, files, cdn, work, download }) {
  const keep = n => /^\/(package\.json|SKILL\.md|cordis\.patch\.yml|(assets\/(icon\.(png|svg)|.*\.(png|svg)))|(references|scripts|examples)\/)/.test(n)
  const selected = files.filter(keep)
  if (!selected.length) throw new Error('插件包没有任何可下载文件')
  log(`需下载 ${selected.length}/${files.length} 个文件`)
  await download(selected, '下载插件文件')
  for (const must of ['package.json', 'cordis.patch.yml']) {
    if (!existsSync(join(work, must))) throw new Error(`核心文件缺失：${must}`)
  }
  save({ phase: 'pack', message: '打包中…' })
  mkdirSync(CACHE, { recursive: true })
  const safe = String(pkg.name || 'plugin').replace(/[^\w.-]/g, '_')
  const tgz = join(CACHE, `${safe}-${pkg.version || '0.0.0'}.tgz`)
  const tar = await run('tar', ['czf', tgz, '-C', work, '.'], { timeout: 120000 })
  trace('tar 完成：' + tgz)
  log('打包完成')
  save({ phase: 'install', message: '安装到引擎…' })
  const r = await run('dsh', ['plugin', '--profile', profile, 'add', tgz], { timeout: 300000 })
  const out = (r.stdout + r.stderr).trim()
  trace('dsh plugin add 输出：\n' + out)
  log(out.split('\n').filter(l => /^\+ |Done|error/i.test(l)).slice(-3).join(' | ') || '已安装')
  save({
    phase: 'done', ok: true, done: true,
    message: `已安装 ${pkg.name}@${pkg.version}，请到「设置→引擎」重启引擎`,
    strategy: 'A',
  })
}

/** 从 README 里猜安装方式。返回 { kind, spec?, reason? }。 */
function parseReadmeInstall(readme, ctx) {
  const text = readme.replace(/\r/g, '')
  // 去掉 HTML 注释与图片，避免误匹配
  const clean = text.replace(/<!--[\s\S]*?-->/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')

  // 1) npx <pkg> / npx -y <pkg>
  const npx = clean.match(/\bnpx\s+(?:-y\s+|--yes\s+)?(@?[\w./-]+)(?:\s+(?:install|add|i)\b)?/)
  if (npx) {
    const spec = npx[1]
    if (!/^(node|npm|pnpm|yarn)$/.test(spec) && spec.includes('-')) {
      return { kind: 'npm-package', spec: normalizeSpec(spec, ctx) }
    }
  }

  // 2) dsh plugin --profile web add <spec>
  const dshAdd = clean.match(/dsh\s+plugin\s+(?:--profile\s+\S+\s+)?add\s+([^\s`'"]+)/)
  if (dshAdd) return { kind: 'dsh-plugin-add', spec: normalizeSpec(dshAdd[1], ctx) }

  // 3) npm i -g <pkg> / npm install <pkg> / pnpm add <pkg>
  const npmI = clean.match(/\b(?:npm\s+(?:i|install)|pnpm\s+(?:add|i)|yarn\s+add)\s+(?:-g\s+|--global\s+)*(-[\w-]+\s+)*(@?[\w./-]+)/)
  if (npmI) {
    const spec = npmI[npmI.length - 1]
    if (spec.includes('-') && !spec.startsWith('-')) {
      return { kind: 'npm-package', spec: normalizeSpec(spec, ctx) }
    }
  }

  // 4) 明确说「放到 ~/.dsh/skills」或「clone 到 skills」→ 当技能装
  if (/(\.dsh\/skills|\.agents\/skills|skills\s*(目录|文件夹|directory|folder))/i.test(clean)) {
    return { kind: 'clone-skill' }
  }

  // 5) 有 SKILL.md 字样 → 当技能
  if (/SKILL\.md/i.test(clean)) return { kind: 'clone-skill' }

  return {
    kind: 'manual',
    reason: 'README 里没有找到 npx / npm / dsh plugin add / skills 目录等可自动识别的安装方式',
  }
}

/** 把 README 里的裸包名补成可安装的 spec。 */
function normalizeSpec(spec, ctx) {
  const s = String(spec).replace(/[`'"）),。；;]$/g, '').replace(/^\.\//, '')
  if (/^(@[\w.-]+\/)?[\w.-]+$/.test(s)) return s                    // 纯包名
  if (/^github:/.test(s)) return s
  if (/^https?:\/\//.test(s)) return s
  return s
}

main().catch(e => {
  const msg = e?.message ?? String(e)
  trace('失败原因：\n' + (e?.stack ?? msg).slice(0, 1600))
  log('失败：' + msg.slice(0, 240))
  save({
    phase: 'failed',
    message: '安装失败：' + msg.slice(0, 120),
    detail: msg.slice(0, 400),
    done: true, ok: false,
  })
})
