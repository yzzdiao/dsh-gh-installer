# dsh-gh-installer

[English](README.en.md) | 中文

Install a DSH plugin or skill into the [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) phone app just by pasting a GitHub repo URL. The repo does not have to be a standard DSH plugin — the installer detects the repo type and follows whatever install method the README describes. When something fails, the full log opens automatically so you can see exactly what happened at every step.

## Features

| Surface | Content |
|---|---|
| Composer capsule | "Install GH": reads a GitHub URL from the clipboard and starts installing |
| Panel | URL form + 8 live progress steps + summary log + **expandable detailed log** (every HTTP request and command output) |
| Status strip | Install status above the input box; tap to open the panel |
| Restart entry | After success, a "Restart engine" button opens 设置 › 本机引擎 |

## Which repos are supported

Detected in this order (the panel shows "识别为: …"):

| Strategy | Detected by | Installed to |
|---|---|---|
| A0. Author-declared | `dsh.install.preferred` (tarball/git/npm) in `package.json` — uses the author's own release | the profile |
| A. DSH plugin bundle | `package.json` has `dsh.bundle.patch` | the profile (`dsh plugin add`) |
| B. Skill collection | multiple `SKILL.md` files (e.g. `skills/*/SKILL.md`) | one directory per skill under `$DSH_HOME/skills/` |
| C. Single skill | a `SKILL.md` at the root or one level deep | `$DSH_HOME/skills/<name>/` |
| D. README instructions | parses `npx <pkg>`, `npm i <pkg>`, `dsh plugin add <spec>`, or "put it under skills/" from the README | follows what the README says |

Strategy A0 uses the author's published package (more reliable) and **falls back to a mirror proxy when GitHub Releases are unreachable** (verified working); only then does it pack the files itself.

Strategy D covers most repos that document their install steps. If nothing is recognized you get an explicit reason and the relevant README excerpt in the detailed log.

## Troubleshooting

On failure:
- the reason appears at the top of the panel;
- the summary log lists readable steps;
- the detailed log **opens automatically** with per-file HTTP status codes, full `dsh plugin add` output and stack traces.

Copy the detailed log to diagnose the issue or file a report.

## Install

```sh
npx dsh-gh-installer install
```

Or add it to a profile directly (remote hosts need the dsh-go bridge first):

```sh
dsh plugin --profile web add dsh-gh-installer
```

Then confirm it is enabled under 设置 › 插件 in the app and **restart the engine once** for code changes to take effect.

`npx dsh-gh-installer status` shows the install location; `--profile <name>` picks a host profile; `--force` overwrites.

## Usage

1. Copy a GitHub repo URL, e.g. `https://github.com/alchaincyf/nuwa-skill.git`.
2. Tap the "Install GH" capsule (clipboard), or open the panel, paste the URL and tap "Start install".
3. Watch the 7 steps; when done, tap "Restart engine" and confirm on the engine page.

## How it works

- Uses jsDelivr's GitHub API to resolve the version and file list, downloads only files needed at runtime (`package.json`, `SKILL.md`, `cordis.patch.yml`, `references/`, `scripts/`, `examples/`), skipping large media.
- Verifies the package has `dsh.bundle.patch`, packs it into a tarball, then runs `dsh plugin --profile <name> add <tarball>`.
- Download/install run in a detached background process (not bound by the 60s handler timeout); the panel polls a state file every 1.5s.
- The tarball is cached at `$DSH_HOME/dsh-go/plugins/dsh-gh-installer/cache/` and referenced by the profile via `file:` — **do not delete the cache dir**, or the dependency breaks.

## Limits

- Only public GitHub repos with tags/releases (via jsDelivr); private repos and branch-only repos are not supported.
- Only valid DSH bundles; plain Node libraries or anything needing native compilation won't work.
- Native UI is hidden when connected via DSH Remote.
- Restarting interrupts the current chat, so "Restart engine" jumps to the engine page for your confirmation instead of killing the process itself.

## Privacy

Reads the clipboard only after you tap. Download/install only contact jsDelivr/npm and the local `dsh` command; no accounts, keys or chat content are read. State files and the tarball cache stay under `$DSH_HOME`.

## License

MIT
