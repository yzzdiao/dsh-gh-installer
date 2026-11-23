# dsh-gh-installer

[English](README.en.md) | 中文

Install a DSH plugin into the local engine of the [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) phone app just by pasting a GitHub repo URL. It turns the whole "mirror download → verify bundle → pack → install into profile → show progress → one-tap restart" flow into a native UI, so you don't need a terminal.

## Features

| Surface | Content |
|---|---|
| Composer capsule | "Install GH": reads a GitHub URL from the clipboard and starts installing |
| Panel | URL form + 7 live progress steps (parse/version/list/download/pack/install/done) + recent log |
| Status strip | Install status above the input box; tap to open the panel |
| Restart entry | After success, a "Restart engine" button opens 设置 › 本机引擎 |

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
