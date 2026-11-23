# dsh-gh-installer

[English](README.en.md) | 中文

在 [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) 手机 App 里，直接粘贴一个 GitHub 仓库地址就能把 DSH 插件装进本机引擎。它把「镜像下载 → 校验 bundle → 打包 → 装进 profile → 显示进度 → 一键重启」这套流程做成了原生界面，不用再开终端。

## 功能

| 位置 | 内容 |
|---|---|
| 输入框胶囊 | 「装GH插件」：读剪贴板里的 GitHub 地址，一键开始安装 |
| 面板 | 粘贴地址的表单 + 7 步实时进度（解析/版本/清单/下载/打包/安装/完成）+ 最近日志 |
| 状态条 | 输入框上方的安装状态，点开面板 |
| 重启入口 | 装完亮起「重启引擎」按钮，直达「设置 › 本机引擎」页 |

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
