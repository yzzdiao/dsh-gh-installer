# dsh-gh-installer

[English](README.en.md) | 中文

在 [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) 手机 App 里，直接粘贴一个 GitHub 仓库地址就能装 DSH 插件或技能。不要求仓库是标准 DSH 插件——它会自动识别仓库类型，并按 README 里写的安装方式来装；失败时详细日志直接展开，能看清每一步发生了什么。

## 功能

| 位置 | 内容 |
|---|---|
| 输入框胶囊 | 「装GH插件」：读剪贴板里的 GitHub 地址，一键开始安装 |
| 面板 | 粘贴地址的表单 + 8 步实时进度 + 摘要日志 + **可展开的详细日志**（含每步 HTTP 请求与命令输出） |
| 状态条 | 输入框上方的安装状态，点开面板 |
| 重启入口 | 装完亮起「重启引擎」按钮，直达「设置 › 本机引擎」页 |

## 支持哪些仓库

按以下顺序自动识别（面板会显示「识别为：…」）：

| 策略 | 识别依据 | 装到哪 |
|---|---|---|
| A. DSH 插件包 | `package.json` 里有 `dsh.bundle.patch` | 装进 profile（`dsh plugin add`） |
| B. 技能集合仓库 | 仓库里有多个 `SKILL.md`（如 `skills/*/SKILL.md`） | 每个技能一个目录，装到 `$DSH_HOME/skills/` |
| C. 单一技能仓库 | 根目录或单层子目录有 `SKILL.md` | 装到 `$DSH_HOME/skills/<名字>/` |
| D. README 指令 | 从 README 解析 `npx <pkg>`、`npm i <pkg>`、`dsh plugin add <spec>`，或「放到 skills 目录」的说明 | 按 README 指示执行 |

策略 D 覆盖大多数在 README 里写了安装方法的仓库。识别不到时给出明确原因，并把 README 关键片段写进详细日志。

## 报错排查

安装失败时：
- 面板顶部直接显示**失败原因**；
- 「摘要日志」是人类可读的步骤记录；
- 「详细日志」**自动展开**，含每个文件的 HTTP 状态码、`dsh plugin add` 完整输出、异常堆栈。

复制详细日志即可定位问题或提 issue。

## 安装

```sh
npx dsh-gh-installer install
```

或者直接装进 profile（远程主机需先有 dsh-go 桥接）：

```sh
dsh plugin --profile web add dsh-gh-installer
```

装完在 App 的「设置 › 插件」里确认已启用，并**重启一次引擎**让代码生效。

也可用 `npx dsh-gh-installer status` 查看安装位置；`--profile <名>` 指定主机 profile，`--force` 强制覆盖。

## 用法

1. 复制一个 GitHub 仓库地址，例如 `https://github.com/alchaincyf/nuwa-skill.git`。
2. 在 App 里点输入框上方的「装GH插件」胶囊（读剪贴板），或打开插件面板在输入框里粘贴地址后点「开始安装」。
3. 面板里看 7 步进度；完成后点「重启引擎」，在引擎页点「重启」。

## 工作原理

- 通过 jsDelivr 的 GitHub API 查询版本与文件清单，只下载插件运行必需的文件（`package.json`、`SKILL.md`、`cordis.patch.yml`、`references/`、`scripts/`、`examples/`），跳过图片/视频等大素材。
- 校验包里确实有 `dsh.bundle.patch`（是合法的 DSH bundle），打包成 tarball 后执行 `dsh plugin --profile <名> add <tarball>`。
- 下载与安装放在脱离引擎的后台进程里，不受插件处理器 60 秒超时限制；面板每 1.5 秒轮询状态文件显示进度。
- tarball 缓存在 `$DSH_HOME/dsh-go/plugins/dsh-gh-installer/cache/`，profile 用 `file:` 引用它——**不要删除 cache 目录**，否则依赖会断。

## 限制

- 只支持带 tag/发布的公开 GitHub 仓库（走 jsDelivr）；私有仓库、无 tag 的纯分支仓库不支持。
- 只装合法的 DSH bundle 插件；普通 Node 库或需要本地编译的包装了也不会生效。
- 经 DSH Remote 连接时不显示原生界面。
- 重启会中断当前对话，所以"重启引擎"是跳到引擎页由你确认，而不是插件擅自杀进程。

## 隐私

只在用户点按后读取剪贴板里的仓库地址；下载与安装过程只访问 jsDelivr / npm 与本机 `dsh` 命令，不读取账号、密钥或对话内容。状态文件与 tarball 缓存在本机 `$DSH_HOME` 下。

## 许可

MIT
