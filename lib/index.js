// dsh-go native plugin: install a GitHub-hosted DSH bundle from the phone.
// The app draws the manifest in package.json; these handlers run in the engine.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-gh-installer'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALLER = join(HERE, 'install.mjs')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
// Keep runtime state beside this package so it works as a local plugin or an npm package.
const BASE = process.env.DSH_GH_INSTALLER_STATE_DIR || hereStateDir()
const STATE = join(BASE, 'state.json')
const TARGET = join(BASE, 'target.txt')

function hereStateDir() {
  try {
    // Prefer a path under $DSH_HOME so state survives engine reinstalls.
    const d = join(DSH_HOME, 'dsh-go', 'plugins', name)
    mkdirSync(d, { recursive: true })
    return d
  } catch {
    return HERE
  }
}

const PHASES = ['parse', 'tag', 'list', 'download', 'pack', 'install', 'done']
const LABELS = ['解析地址', '查询版本', '读取清单', '下载文件', '打包', '安装到引擎', '完成']

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
function readTarget() {
  try { return readFileSync(TARGET, 'utf8').trim() } catch { return '' }
}
function writeTarget(url) {
  mkdirSync(BASE, { recursive: true })
  writeFileSync(TARGET, url)
}
function normalizeUrl(raw) {
  let url = String(raw ?? '').trim()
  if (!/github\.com\//i.test(url)) return ''
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '')
  return url
}
function startInstall(url) {
  try { rmSync(STATE, { force: true }) } catch {}
  // Detached so the install is not bound by the bridge's 60s handler timeout.
  try {
    const child = spawn(process.execPath, [INSTALLER, url, STATE, 'web'], {
      detached: true, stdio: 'ignore', env: process.env,
    })
    child.unref()
  } catch {}
}

function buildData() {
  const st = readJson(STATE)
  const target = readTarget()
  const phase = st?.phase ?? 'start'
  const failed = phase === 'failed'
  const done = phase === 'done'
  let cur = PHASES.indexOf(phase)
  if (done) cur = 7
  if (cur < 0) cur = 0
  const failedAt = failed ? Math.max(0, PHASES.indexOf(st?.failedAt ?? 'parse')) : -1

  const data = {
    url: target || '',
    message: st?.message || (target
      ? '准备安装中…'
      : '复制 GitHub 仓库地址，或直接在下方粘贴后点「开始安装」'),
    tone: done ? 'good' : failed ? 'bad' : 'info',
    log: (st?.log ?? []).slice(-10).join('\n'),
    showRestart: done ? 'yes' : 'no',
  }
  for (let i = 0; i < PHASES.length; i++) {
    let status
    if (done) status = 'done'
    else if (failed) status = i < failedAt ? 'done' : i === failedAt ? 'failed' : 'todo'
    else status = i < cur ? 'done' : i === cur ? 'current' : 'todo'
    data['st' + i] = status
    data['d' + i] = i === cur && !failed && !done ? (st?.message ?? '') : ''
  }
  if (failed) data['d' + failedAt] = st?.message ?? ''
  return data
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    // 胶囊：读剪贴板里的 GitHub 地址，立即后台安装并打开面板
    ctx.dshGo.on('install', (scope, event) => {
      const url = normalizeUrl(scope.clipboard)
      if (!url) return { toast: '剪贴板里没有 GitHub 仓库地址' }
      writeTarget(url)
      startInstall(url)
      return { open: 'panel:main', toast: '已开始安装，面板里看进度' }
    })

    // 面板：表单输入 + 进度视图 + 轮询数据 + 动作
    ctx.dshGo.panel('main', {
      view: (scope, caps) => ({
        v: 2,
        type: 'stack',
        children: [
          { type: 'text', text: '安装 GitHub 上的 DSH 插件', style: { size: 'title', weight: 'bold' } },
          { type: 'form', submitLabel: '开始安装', submit: { id: 'submit', args: { url: { $: 'data.url' } } }, children: [
            { type: 'textField', label: '仓库地址', bind: 'data.url', placeholder: 'https://github.com/用户/仓库', required: true },
          ] },
          { type: 'callout', text: { $: 'data.message' }, tone: { $: 'data.tone' } },
          { type: 'steps', items: LABELS.map((label, i) => ({
            label, status: { $: 'data.st' + i }, detail: { $: 'data.d' + i },
          })) },
          { type: 'text', text: { $: 'data.log' }, tone: 'muted' },
          { type: 'actions', items: [
            { label: '重启引擎', action: 'restart', icon: 'restart' },
            { label: '重试安装', action: 'retry' },
            { label: '清空记录', action: 'clear' },
          ] },
        ],
      }),
      data: (scope, emit, caps) => {
        emit(buildData())
        const st = readJson(STATE)
        const target = readTarget()
        if (!target || st?.done) return () => {}   // idle: no polling
        const timer = setInterval(() => emit(buildData()), 1500)
        return () => clearInterval(timer)
      },
      actions: {
        submit: (scope, event) => {
          const url = normalizeUrl(event?.value?.args?.url ?? event?.value?.url ?? '')
          if (!url) return { toast: '请输入有效的 GitHub 仓库地址' }
          writeTarget(url)
          startInstall(url)
          return { toast: '已开始安装，面板里看进度', refresh: true }
        },
        restart: () => ({ open: 'engine', toast: '请在引擎页点「重启」使插件生效' }),
        retry: () => {
          const url = readTarget()
          if (!url) return { toast: '还没有地址，先粘贴地址点「开始安装」' }
          startInstall(url)
          return { toast: '已重新开始安装', refresh: true }
        },
        clear: () => {
          try { rmSync(STATE, { force: true }) } catch {}
          try { rmSync(TARGET, { force: true }) } catch {}
          return { toast: '已清空', refresh: true }
        },
      },
    })
  })
}
