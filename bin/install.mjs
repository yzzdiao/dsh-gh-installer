#!/usr/bin/env node
// Installer for dsh-gh-installer.
//   npx dsh-gh-installer install   # install the plugin into a dsh-go profile
//   npx dsh-gh-installer status    # show where it would be installed
//
// Copies this package into $DSH_HOME/dsh-go/plugins/dsh-gh-installer (so engine
// updates don't wipe it and the profile keeps a stable link), then registers it
// with `dsh plugin --profile <name> add <dir>`.
import { existsSync, readFileSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OWN = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NAME = OWN.name
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DEST = join(DSH_HOME, 'dsh-go', 'plugins', NAME)
const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'install'
const profile = argValue('--profile') || 'web'
const force = argv.includes('--force')

function argValue(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
function log(...a) { console.log('[dsh-gh-installer]', ...a) }

function status() {
  log('package  :', NAME + '@' + OWN.version)
  log('DSH_HOME :', DSH_HOME)
  log('target   :', DEST, existsSync(DEST) ? '(exists)' : '(not installed)')
  log('profile  :', profile)
}

function install() {
  if (existsSync(DEST) && !force) {
    log('already present at', DEST, '- re-run with --force to overwrite')
  } else {
    if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true })
    mkdirSync(dirname(DEST), { recursive: true })
    // Copy everything except dev-only files.
    cpSync(ROOT, DEST, {
      recursive: true,
      filter: (src) => !/[\\/](?:\.git|node_modules|cache)(?:[\\/]|$)/.test(src),
    })
    log('copied to', DEST)
  }
  try {
    const out = execFileSync('dsh', ['plugin', '--profile', profile, 'add', DEST], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    log(out.trim().split('\n').filter(l => /^\+ |Done|Already/i.test(l)).slice(-3).join(' | '))
  } catch (e) {
    log('register failed:', String(e.stderr || e.message).trim().slice(0, 400))
    process.exitCode = 1
    return
  }
  log('installed. Open the app, go to 设置 › 插件 to enable, then restart the engine once.')
}

if (cmd === 'status') status()
else if (cmd === 'install' || cmd === 'plugin') install()
else {
  log('usage: npx dsh-gh-installer [install|status] [--profile <name>] [--force]')
  process.exitCode = 1
}
