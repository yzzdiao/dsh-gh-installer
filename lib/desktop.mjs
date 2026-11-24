// Desktop / web / CLI half of dsh-gh-installer.
//
// The dsh-go phone app draws the native capsule + panel from package.json's
// `dshGo` block. A desktop (Harness Web UI / TUI / CLI) host has no dsh-go
// bridge, so that block renders nothing. This module adds the same capability
// through ordinary engine surfaces that every host has:
//
//   • a tool  `install_github_plugin` — the model can call it (and so can the
//     user by asking "装一下这个仓库")
//   • a slash command `/gh-install <url>` — a human can type it directly
//
// Both run the same install.mjs that the phone UI runs, so the strategy chain
// (A0 author-declared → mirror → A bundle → B/C skills → D README) is shared.
import { spawn, execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALLER = join(HERE, 'install.mjs')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PKG_NAME = readPkgName()
const BASE = process.env.DSH_GH_INSTALLER_STATE_DIR
  || join(DSH_HOME, 'dsh-go', 'plugins', PKG_NAME)
const STATE = join(BASE, 'state.json')
const TARGET = join(BASE, 'target.txt')

/** This package's own name, so state lives under the same directory it was installed as. */
function readPkgName() {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(HERE), 'package.json'), 'utf8'))
    if (typeof pkg.name === 'string' && pkg.name) return pkg.name
  } catch {}
  return 'dsh-gh-installer'
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function readState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return null }
}
function normalizeUrl(raw) {
  let url = String(raw ?? '').trim()
  if (!/github\.com\//i.test(url)) return ''
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '')
  return url
}

/**
 * Run the installer and wait for it, streaming nothing (the caller reports).
 * The phone path detaches because its handler has a 60s budget; a tool call can
 * simply wait, which gives the model the real error instead of a poll loop.
 */
export async function installAndWait(url, { profile = 'web', timeoutMs = 900000 } = {}) {
  if (!normalizeUrl(url)) throw new Error('不是有效的 GitHub 仓库地址（需要 https://github.com/用户/仓库）')
  mkdirSync(BASE, { recursive: true })
  writeFileSync(TARGET, normalizeUrl(url))
  try { rmSync(STATE, { force: true }) } catch {}

  const child = spawn(process.execPath, [INSTALLER, normalizeUrl(url), STATE, profile], {
    stdio: 'ignore', env: process.env, detached: false,
  })
  const started = Date.now()
  // Poll the state file the installer writes; it is the same record the phone UI reads.
  for (;;) {
    if (child.exitCode !== null && child.exitCode !== 0) break
    const st = readState()
    if (st?.done) return st
    if (Date.now() - started > timeoutMs) {
      try { child.kill() } catch {}
      return { done: true, ok: false, phase: 'failed', message: '安装超时', detail: `超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成`, log: [], trace: [] }
    }
    if (child.exitCode !== null) {
      const st2 = readState()
      if (st2?.done) return st2
      break
    }
    await sleep(700)
  }
  const st = readState()
  if (st?.done) return st
  return {
    done: true, ok: false, phase: 'failed',
    message: st?.message || '安装进程异常退出',
    detail: st?.detail || '', log: st?.log ?? [], trace: st?.trace ?? [],
  }
}

/**
 * Which profile this engine is running. Installing into the wrong one means the
 * user sees nothing after a restart, so prefer what the process actually says and
 * only then fall back to 'web'.
 */
function detectProfile() {
  const env = process.env.DSH_PROFILE || process.env.DSH_PROFILE_NAME
  if (env) return String(env)
  try {
    // The profile dir is .../profiles/<name>; the loader passes it in argv or cwd on some hosts.
    const hints = [process.argv.join(' '), process.cwd()]
    for (const h of hints) {
      const m = /profiles[\\/]([\w.-]+)/.exec(h)
      if (m) return m[1]
    }
  } catch {}
  return 'web'
}

/** A short human summary of a finished state, for a command reply or tool text. */
export function summarize(st) {
  if (!st) return '安装器没有留下状态记录。'
  const lines = []
  lines.push(st.ok ? `✅ ${st.message}` : `❌ ${st.message}`)
  if (st.strategy) lines.push(`策略：${st.strategy}`)
  if (st.detail && !st.ok) lines.push(`详情：${st.detail}`)
  const log = (st.log ?? []).slice(-6)
  if (log.length) lines.push('', '最近日志：', ...log.map(l => `  ${l}`))
  if (!st.ok) {
    const trace = (st.trace ?? []).slice(-12)
    if (trace.length) lines.push('', '详细日志：', ...trace.map(l => `  ${l}`))
    lines.push('', `完整记录：${STATE}`)
  }
  return lines.join('\n')
}

/**
 * Engine half: register the tool and the slash command.
 *
 * Cordis only hands you a service inside `ctx.inject([...])` once it is ready.
 * Touching `ctx.tools` / `ctx.commands` directly during startup yields undefined,
 * which silently skipped registration — that is why `/gh-install` never showed up
 * on desktop. Each surface now waits for its own service, so a host without one
 * still gets the other (and the dsh-go capsule is unaffected either way).
 */
export function applyDesktop(ctx) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (c) => registerTool(c))
    ctx.inject(['commands'], (c) => registerCommand(c))
    return
  }
  // Hosts whose context has no inject(): fall back to whatever is already present.
  registerTool(ctx)
  registerCommand(ctx)
}

function registerTool(ctx) {
  // ── 工具：模型可调用 ──
  if (typeof ctx.tools?.register !== 'function') return
  {
    const defineTool = loadDefineTool()
    const spec = {
      name: 'install_github_plugin',
      description:
        '把 GitHub 上的 DSH 插件或技能安装到当前主机。支持标准 DSH 插件包、带 SKILL.md 的技能仓库、'
        + '以及 README 里写明 npx / npm i / dsh plugin add 安装方式的仓库。'
        + '会依次尝试：作者声明的安装方式（tarball/git/npm，GitHub Release 不通时自动走镜像）'
        + '→ 自拼 bundle → 技能目录 → README 指令。返回识别到的策略、安装结果和失败时的详细日志。',
      parameters: {
        url: { type: 'string', description: 'GitHub 仓库地址，例如 https://github.com/用户/仓库', required: true },
        profile: { type: 'string', description: '安装到哪个 profile，默认 web' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            strategy: { type: 'string' },
            message: { type: 'string' },
            detail: { type: 'string' },
            log: { type: 'array', items: { type: 'string' } },
            trace: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        render: (_args, value) => summarize(value),
      },
      async execute(args) {
        const st = await installAndWait(args.url, { profile: args.profile || detectProfile() })
        return {
          ok: Boolean(st.ok),
          strategy: st.strategy,
          message: st.message ?? '',
          detail: st.detail,
          log: (st.log ?? []).slice(-20),
          trace: (st.trace ?? []).slice(-40),
        }
      },
    }
    // defineTool 把 author-facing 简写编译成引擎要求的 JSON Schema。
    // 没有该包（极老的宿主）时退回原对象，注册会失败但只影响这个工具。
    ctx.tools.register(defineTool ? defineTool(spec) : spec)
  }

}

function registerCommand(ctx) {
  // ── 斜杠命令：/gh-install <url> ──
  if (typeof ctx.commands?.register !== 'function') return
  {
    ctx.commands.register({
      name: 'gh-install',
      description: '从 GitHub 安装 DSH 插件或技能：/gh-install <仓库地址>',
      async handler(invocation) {
        const raw = String(invocation?.rawInput ?? '').trim()
        const url = normalizeUrl(raw) || normalizeUrl(raw.split(/\s+/)[0])
        if (!url) {
          return { kind: 'error', text: '用法：/gh-install https://github.com/用户/仓库' }
        }
        const st = await installAndWait(url, { profile: detectProfile() })
        return { kind: st.ok ? 'success' : 'error', text: summarize(st) }
      },
    })
  }
}

/** Load @deepseek-ai/dsh-tools' defineTool, or null when this host does not ship it. */
function loadDefineTool() {
  for (const base of [import.meta.url, 'file:///opt/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js']) {
    try {
      const req = createRequire(base)
      const mod = req('@deepseek-ai/dsh-tools')
      if (typeof mod.defineTool === 'function') return mod.defineTool
    } catch {}
  }
  return null
}

/** True when this host has no dsh-go bridge, i.e. the desktop half is what the user can reach. */
export function hasBridge(ctx) {
  try { return typeof ctx.get === 'function' && ctx.get('dshGo') !== undefined } catch { return false }
}
