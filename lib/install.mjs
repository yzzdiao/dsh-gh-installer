// Background installer for a GitHub-hosted DSH skill/plugin bundle.
// Spawned detached by index.js so it is not bound by the bridge's 60s handler timeout.
// usage: node install.mjs <github-url> <state-file> [profile]
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, renameSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const [repoUrlArg = '', stateFile = '', profile = 'web'] = process.argv.slice(2)
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
// Persisted tarballs live here; the profile's file: dependency points at them, so never delete.
const CACHE = process.env.DSH_GH_INSTALLER_CACHE_DIR
  || join(DSH_HOME, 'dsh-go', 'plugins', 'dsh-gh-installer', 'cache')

let state = { phase: 'start', message: '准备中…', log: [], done: false, ok: false }
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
  state.log.push(String(line).slice(0, 200))
  if (state.log.length > 40) state.log.shift()
  save()
}
async function get(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return Buffer.from(await r.arrayBuffer())
      log(`下载返回 ${r.status}，重试 ${i + 1}/${tries}`)
    } catch {
      log(`连接中断，重试 ${i + 1}/${tries}`)
    }
    await sleep(600 * (i + 1))
  }
  throw new Error('多次重试后仍无法下载：' + url.slice(0, 120))
}

async function main() {
  save({ phase: 'parse', message: '解析地址…' })
  const m = String(repoUrlArg).trim().match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  if (!m) throw new Error('不是有效的 GitHub 仓库地址（需要 https://github.com/用户/仓库）')
  const [owner, repo] = [m[1], m[2]]
  log(`仓库：${owner}/${repo}`)

  // 1. 找最新 tag
  save({ phase: 'tag', message: '查询版本…' })
  let tag = 'main'
  try {
    const versionsRaw = await get(`https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}`)
    const j = JSON.parse(versionsRaw.toString())
    if (j.versions?.[0]?.version) tag = j.versions[0].version
  } catch {}
  log(`版本：${tag}`)

  // 2. 文件清单
  save({ phase: 'list', message: '读取文件清单…' })
  const api = `https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}@${tag}?structure=flat`
  const raw = await get(api)
  const files = JSON.parse(raw.toString()).files?.map(f => f.name) ?? []
  if (!files.length) throw new Error('没有取到文件清单（仓库可能没有可发布的 tag）')
  const keep = n => /^\/(package\.json|SKILL\.md|cordis\.patch\.yml|(assets\/icon\.png)|(references|scripts|examples)\/)/.test(n)
  const selected = files.filter(keep)
  log(`需下载 ${selected.length}/${files.length} 个文件（大型素材已跳过）`)

  const work = mkdtempSync(join(tmpdir(), 'ghins-'))
  try {
    // 3. 逐文件下载
    const cdn = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${tag}`
    let i = 0, skipped = 0
    for (const name of selected) {
      i++
      if (i % 10 === 0 || i === selected.length) save({ phase: 'download', message: `下载 ${i}/${selected.length}` })
      const dest = join(work, name)
      mkdirSync(dirname(dest), { recursive: true })
      try {
        writeFileSync(dest, await get(cdn + name, 3))
      } catch {
        // 个别文件（多为 examples 示例）在 CDN 上缺失：跳过，不影响核心插件。
        skipped++
        try { rmSync(dest, { force: true }) } catch {}
      }
    }
    log(`文件下载完成${skipped ? `（跳过 ${skipped} 个缺失文件）` : ''}`)
    // 核心文件必须齐全，否则无法安装
    for (const must of ['package.json', 'SKILL.md', 'cordis.patch.yml']) {
      if (!existsSync(join(work, must))) throw new Error(`核心文件缺失：${must}`)
    }

    // 4. 校验是不是 DSH bundle
    const pkg = JSON.parse(readFileSync(join(work, 'package.json'), 'utf8'))
    if (!pkg.dsh?.bundle?.patch) throw new Error('这不是一个 DSH bundle 插件（package.json 缺少 dsh.bundle.patch）')
    log(`包：${pkg.name}@${pkg.version}`)

    // 5. 打包到持久目录（profile 会 file: 引用，不能删）
    save({ phase: 'pack', message: '打包中…' })
    mkdirSync(CACHE, { recursive: true })
    const safe = String(pkg.name).replace(/[^\w.-]/g, '_')
    const tgz = join(CACHE, `${safe}-${pkg.version}.tgz`)
    await run('tar', ['czf', tgz, '-C', work, '.'], { timeout: 120000 })
    log('打包完成')

    // 6. 安装到 profile
    save({ phase: 'install', message: '安装到引擎…' })
    const { stdout, stderr } = await run('dsh', ['plugin', '--profile', profile, 'add', tgz], { timeout: 180000 })
    log((stdout + stderr).trim().split('\n').filter(l => /^\+ |Done|error/i.test(l)).slice(-3).join(' | '))

    save({ phase: 'done', message: `已安装 ${pkg.name}@${pkg.version}，请到「设置→引擎」重启引擎`, done: true, ok: true })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch(e => {
  log('失败：' + (e?.message ?? String(e)).slice(0, 200))
  save({ phase: 'failed', message: '安装失败，展开面板看日志', done: true, ok: false })
})
