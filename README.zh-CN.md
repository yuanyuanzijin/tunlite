# tunlite

[English](README.md) · **简体中文**

[![CI](https://github.com/yuanyuanzijin/tunlite/actions/workflows/ci.yml/badge.svg)](https://github.com/yuanyuanzijin/tunlite/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/tunlite)](https://www.npmjs.com/package/tunlite)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

轻量、跨平台的 **SSH 隧道管理器** —— 用一个声明式 CLI 取代
*autossh + 每条隧道一个 systemd 单元 + 一堆记不住的 `-L`/`-R`/`-D` 参数*。一次定义
命名隧道，由一个**零依赖**的小守护进程保持连接、开机自启、自动打通目标端免密登录。
每个命令都讲 **`--json`** 且退出码稳定，所以 **AI agent 用起来和你一样顺手** ——
还随包附带一份 agent skill。

- **Agent 原生** —— 每个命令都有 `--json`、退出码稳定，并内置一份 agent skill。
- **零第三方依赖** —— 纯 Node.js 标准库、不装任何 npm 包；机器上只需要 **Node ≥ 18** 和它封装的系统 `ssh`，别无他求。
- **包裹系统 `ssh`** —— 功能完全对齐（密钥、跳板机、ssh config 全支持）。
- **断线重连** —— 指数退避 + 抖动、keepalive、端口健康探测。
- **开机自启** —— launchd（macOS）/ systemd 用户服务（Linux）/ 任务计划（Windows，beta）。
- **免密打通** —— 已免密就直接连，没免密才帮你装公钥。
- **三种转发** —— 本地 `-L`、远程 `-R`、动态 SOCKS `-D`。

## 为什么用 tunlite?

如果你常年挂着几条 SSH 隧道 —— 回连 homelab 的 reverse tunnel、经堡垒机的 SOCKS
代理、转发到 staging 数据库的端口 —— 你多半给每条都配了 `autossh` 加一个
`systemd`/`launchd` 单元，还得记住哪条该用 `-L`/`-R`/`-D`。tunlite 把这些全收进一个
声明式 CLI，建在你已经信任的 `ssh` 之上：命名隧道由守护进程保活、开机由系统拉起 ——
不引入新服务、不需要账号、不另起协议。又因为每个命令都是 `--json` + 稳定退出码，
agent 驱动的就是和你一模一样的那套接口。

| | tunlite | autossh | 裸 `ssh -L/-R/-D` | sshuttle | frp · bore · chisel | ngrok |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| 包裹系统 `ssh`（密钥、跳板机、`ssh_config`）| ✅ | ✅ | ✅ | 部分 | ❌ 自有协议 | ❌ 自有服务 |
| 命名、声明式隧道 | ✅ | ❌ | ❌ | ❌ | ✅ 配置 | ✅ |
| 断线重连（退避、keepalive、健康探测）| ✅ | 基础 | ❌ | ❌ | ✅ | ✅ |
| 开机自启（launchd/systemd/任务计划）| ✅ | 自己搞 | 自己搞 | 自己搞 | 自己搞 | ✅ |
| 本地 **+** 远程 **+** 动态 SOCKS | ✅ | ✅ | ✅ | 透明代理 | 视情况 | 视情况 |
| 零依赖 · 无需自建服务 · 自托管 | ✅ | 需要 autossh | ✅ | 需要 python | 需要服务端 | 托管/付费 |
| 对 agent 友好（`--json`、稳定退出码）| ✅ | ❌ | ❌ | ❌ | ❌ | 部分 |

## 安装

前提：Node ≥ 18 在 PATH 上（用于运行；`tunlite install` 会把它钉进 launcher）。

```bash
# 推荐：一行拉取 + 锚定（不依赖全局 npm）
npx tunlite install

# 或：curl 一行（不依赖 npm，只要 curl/wget + tar + node）
curl -fsSL https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/bootstrap.sh | sh
# 传参：… | sh -s -- --service --skill user

# Windows（PowerShell）—— beta
irm https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/bootstrap.ps1 | iex
```

> **Windows 支持目前为 beta。** macOS 和 Linux 是主力、有 CI 覆盖的平台；Windows（任务计划自启、
> `.cmd` launcher、PATH 设置）能用，但验证较少、暂未纳入 CI——遇到问题欢迎反馈。

`tunlite install` 会把运行时拷到固定目录，并写一个**钉死 node 绝对路径**的 launcher
（切换 nvm/fnm 版本也不影响），交互时还会问你是否注册开机自启、是否装 agent skill。

> **短别名 `tun`**：安装时会顺带写一个 `tun` 命令（和 `tunlite` 等价，日常少敲 4 个字符）——
> `tun status`、`tun up`、`tun logs web -f` 都行。若你机器上 `tun` 已被别的程序占用，安装会
> **跳过并提示**、不会覆盖它（继续用 `tunlite` 即可）；`tunlite uninstall` 也只会删自己写的那个 `tun`。

## 快速开始

```bash
# 一条隧道一个转发。--local = 你机器侧，--remote = 服务器侧；子命令决定谁监听。
tunlite add local   web-8080 --to user@server --remote 80 --local 8080   # 本地够到 server 的 :80（本地 8080）
tunlite add dynamic px-1080  --to user@server                            # SOCKS5 代理（默认本地 1080）
tunlite add remote  rev-9000 --to user@server --local 3000 --remote 9000 # 把本地 3000 暴露到 server:9000

tunlite up                 # 启用并启动全部，顺带拉起 daemon（没免密会顺手打通）
tunlite status             # 对齐表格：NAME STATE HOST TYPE ROUTE PID UP RESTARTS
tunlite status web-8080    # 单隧道纵向详情
tunlite logs web-8080 -f   # 跟随日志
tunlite doctor             # 一键体检：为什么连不上（ssh/密钥/端口/daemon/服务）

tunlite install service    # 可选：让 daemon（和你的隧道）开机自启
```

目标还没免密时，在终端里跑 `tunlite up` 会让你输一次密码后自动装好公钥；也可以显式执行：

```bash
tunlite check user@server      # 退出码 0 = 已免密
tunlite setup-key user@server  # 安装你的公钥（需输一次密码）
```

每条命令的完整选项见下方 [命令](#命令) 一节。

## 升级 (update)

装好之后，一条命令升到最新：

```sh
tunlite update              # 升到最新版（默认会重启 daemon，隧道闪断约 1 秒）
tunlite update v0.1.0       # 装/回退到指定版本（标签）
tunlite update --check      # 只看当前版本 vs 最新版，不动任何东西
tunlite update --no-restart # 只换文件，不重启 daemon（新代码下次启动生效）
tunlite --version           # 看当前版本
```

`update` 会拉取一个 tarball 并重新锚定（不走 npm、不走 git），就地替换运行时再重启 daemon。
从**源码目录**（开发用的 clone，带 `.git`）里运行时它会拒绝自更新，提示你用 git 更新后再跑 `tunlite install`。

> 注："最新"看的是 `master` 上 `package.json` 的版本号。若 `master` 有改动但版本号没变，
> `tunlite update` 会显示"已是最新"；想强制重装同版本的最新代码用 `tunlite update --force`。

> **从 0.4.x 及更早版本升级（一次性）**：这次安装方式变了，`tunlite update` **没法**把老版本带过来
> —— 它跑的是旧代码：旧的 `install.sh` 装的会因脚本已删除而失败，npm 全局装的会留下一个无法再自更新的副本。
> 请用上面的[安装](#安装)命令**手动重装一次**（加 `--service` 顺带重注册自启），例如：
>
> ```sh
> curl -fsSL https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/bootstrap.sh | sh -s -- --service
> # Windows（beta）: irm https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/bootstrap.ps1 | iex
> ```
>
> 它会**就地重新锚定**、卸掉旧的 npm 全局版、并把自启服务改写成钉死 node 的 launcher。你的
> `config.json`、隧道定义、日志都不动（路径没变）。这一跳之后，以后 `tunlite update` 就能正常自更新了。

## 卸载

```bash
tunlite uninstall            # 停 daemon + 摘自启 + 删 skill + 删 launcher/lib
tunlite uninstall --purge    # 顺带删配置和日志
tunlite uninstall service    # 只摘自启；uninstall skill 只删 skill
```

## 实时面板 (monitor)

`tunlite monitor`（别名 `tunlite mon`）打开一个 top 风格的全屏实时面板：顶部是 daemon
状态与隧道计数，下面是隧道表（状态上色）。键位：

- `↑/k` `↓/j` 选择，`s` 启动，`x` 停止（`y/N` 确认），`r` 重启（`y/N` 确认）
- `?` 帮助，`q` 退出
- `--interval <秒>` 调整刷新间隔（默认 1s）

需要交互式终端；脚本里请用 `tunlite status --json`。

## 断线告警 (webhook)

隧道掉线时让 daemon 往你配的 webhook POST 一条告警，并按**渠道**把消息排成目标
聊天端要的格式（目前 `generic` + 企业微信 `wecom`）。渠道从 URL 自动识别，也能用
`--channel` 覆盖。**纯 Node 内置 http/https，无新依赖。**

```bash
tunlite webhook                                  # 看当前 webhook（URL / 渠道 / 开关 / 事件）
tunlite webhook set https://example.com/hook     # 设置并启用（渠道按 URL 自动识别）
tunlite webhook set <url> --channel wecom        # 手动指定渠道
tunlite webhook set <url> --events tunnel,daemon-crash   # 设 URL 同时挑事件
tunlite webhook on | off                         # 开 / 关（关掉不丢 URL）
tunlite webhook events down,recovered            # 单独改订阅的事件
tunlite webhook test                             # 发一条测试事件，并报告渠道的判定结果
```

**渠道**把告警渲染成目标端认的格式：

- `generic`（默认）—— 原样 JSON 事件，给自建端点用。
- `wecom`（企业微信）—— 群机器人 `{msgtype:text}` 文本消息；识别到
  `qyapi.weixin.qq.com` 时自动启用。`webhook test` 会读返回体，所以被拒（errcode）
  会如实报告，而不是误判成"已发送"。

**事件**（按状态边沿触发，重连风暴只报一次）分两类：

- 隧道级：`up`（连上）、`down`（连上后掉线）、`recovered`（掉线后恢复）、
  `needs-auth`（免密失效）、`failed`（转发失败，如端口被占）、`stopped`（手动停/删）。
- daemon 级：`daemon-up`（守护进程启动）、`daemon-down`（正常退出）、
  `daemon-crash`（上次非正常退出，下次启动时检测到）。

`webhook events` 的列表支持**点名**（`down,recovered`）、**组**（`tunnel` / `daemon`）、
`all`、`none`。默认只订阅"出问题+恢复"那组：`down, recovered, needs-auth, failed,
daemon-crash`（不含平时正常的 up/stopped/daemon-up/daemon-down，避免刷屏）。
`generic` 渠道的载荷形如 `{scope, tunnel, host, event, state, lastError, restarts, ts, machine, version}`。

## 配置导入导出 (export / import)

```bash
tunlite export > backup.json          # 导出配置（settings + tunnels），里面没有密钥
tunlite import backup.json            # 合并隧道：同名默认跳过
tunlite import backup.json --force    # 同名覆盖
```

`import` **只合并隧道**，不会动你本地的 settings（不会把别人的 webhook 带进来）。

## Shell 补全 (completion)

```bash
tunlite install completion          # 自动识别 shell（zsh/bash/fish），开启 Tab 补全
tunlite install completion zsh      # 也可显式指定 shell
tunlite uninstall completion        # 关闭
```

`tunlite install`（裸命令）安装时也会问一句要不要开启。开启后补全子命令；对
`up/down/restart/status/logs/rm/rename` 还会补全已定义的隧道名，`tunlite` 和短别名
`tun` 都能补。zsh/bash 会往 `~/.zshrc`/`~/.bashrc` 追加一行（带标记，`uninstall
completion` 能精确删掉）；fish 写到 `~/.config/fish/completions/`。改完重开 shell 或
`exec zsh` 生效。

## 命令

| 命令 | 作用 |
|---|---|
| `add local\|remote\|dynamic <name> --to user@host[:port] [--local [host:]P] [--remote [host:]P] [-i key] [--jump host] [--ssh-opt OPT] [--tag T]... [--disabled] [--no-auto-key]` | 定义一条隧道（先一个转发；可用 `forward` 加更多）|
| `rename <old> <new>` | 重命名隧道（平滑交接活动连接）|
| `set <name> [--to ...] [-i key] [--jump host] [--ssh-opt OPT] [--tag T \| --no-tags] [--auto-key\|--no-auto-key]` | 改已存在隧道的 host / 密钥 / jump / 选项 / 标签 |
| `rm <name>` | 删除隧道（同时停掉）|
| `list [--tag T]` | 列出已定义的隧道（`--tag` 按标签过滤）|
| `forward list\|add\|rm <tunnel> ...` | 列出 / 增加 / 删除某隧道的转发（一条隧道可带多个）|
| `up [name\|--tag T]` / `down [name\|--tag T]` / `restart [name\|--tag T]` | 控制（不带名字/标签 = 全部；`--tag` = 带该标签的所有隧道）|
| `status [name\|--tag T]` | 结构化运行状态（无名 = 对齐表格；有名 = 纵向详情）|
| `monitor [--interval s] [--tag T]` | 全屏实时面板（启动/停止/重启隧道；`--tag` 过滤）|
| `logs <name> [-f] [-n N]` | 查看 / 跟随日志 |
| `doctor [name]` | 一键体检：为什么连不上（ssh/密钥/端口/daemon/服务）|
| `check <user@host[:port]> [-i key] [--jump host]` / `setup-key <user@host[:port]> [-i key] [--jump host]` | 免密探测 / 安装公钥 |
| `webhook` / `webhook set <url> [--channel C] [--events L]` / `webhook on\|off` / `webhook events <list>` / `webhook test` | 告警：查看 / 设置 / 开关 / 挑事件 / 发测试事件（渠道 `generic`·`wecom`）|
| `export` / `import <file> [--force]` | 导出配置（JSON）/ 导入并合并隧道（同名默认跳过）|
| `update [version]` | 升到最新（或指定标签），并重启 daemon |
| `daemon run\|start\|stop\|status` | daemon 生命周期（`run` = 前台，供服务调用）|
| `install [--service] [--skill user\|cwd\|<path>] [--completion] [--yes]` | 锚定运行时（写钉死 node 的 launcher）+ 可选注册自启 / 装 skill / 开补全 |
| `install service` / `install skill [--dir user\|cwd\|<path>]` / `install completion [bash\|zsh\|fish]` | 单独补装自启服务 / agent skill / shell 补全 |
| `uninstall [service\|skill\|completion] [--purge]` | 卸载（不带目标 = 全部：停 daemon + 删服务 + 删 skill + 删补全 + 删 launcher/lib，`--purge` 再删配置/状态）|

**命名规范**：隧道名用 `<用途>-<端口>`、全小写、连字符分隔、不要空格 —— 例如
`tmux-prod-19999`、`progress-board-4705`、`db-staging-5432`。这样在 `status`/`logs`
里一眼就能看出它是干嘛的、哪个端口。

**转发模型**：每个 `add` 定义一个转发；一条隧道可在一条连接上承载多个——用
`tunlite forward list|add|rm <tunnel>` 管理。子命令表意：`local`（在本地够到远端服务）、
`remote`（把本地服务暴露到服务器）、`dynamic`（本地 SOCKS5 代理）。**`--local` 永远指你
机器侧、`--remote` 永远指服务器侧**，子命令决定谁监听。地址写 `[host:]port`：监听那侧的
`host` 是绑定地址（默认 `127.0.0.1`，写 `0.0.0.0` 对外），目标那侧的 `host` 是要连的主机
（默认 `localhost`）。不写时：`local` 的 `--local`、`remote` 的 `--remote` 默认跟对侧同
端口；`dynamic` 默认 `1080`。

**SSH 端口**：指目标主机的 **SSH 服务端口**（不是转发端口），直接写进目标里——
`--to user@host:2222`（`check` / `setup-key` 同理）。不给默认 **22**；给了必须是
**1–65535 的整数**，否则报用法错（`exit 2`），不会"悄悄退回 22 连错端口"。IPv6 字面量带
端口要加方括号：`user@[::1]:2222`。转发端口同样会校验。

**跳板机**：用 `--jump [user@]host[:port][,...]`（ssh `-J` / ProxyJump）经一个或多个堡垒机
到达目标，`add` / `check` / `setup-key` 都支持。它按隧道保存，免密探测也会走它。

**标签**：用 `--tag`（可重复）在 `add` 时给隧道贴标签，用 `set --tag`（整组替换）或
`set --no-tags`（清空）修改。之后可对一整组批量操作：`up` / `down` / `restart` / `status` /
`list` / `monitor` 都支持 `--tag <标签>`，选中带该标签的所有隧道（多个 `--tag` 取并集）。
名字和 `--tag` 不能同时给。标签只是元数据，**不会改变 ssh 命令**。例如:
`tunlite add remote api-9001 --to me@host --remote 9001 --tag prod`,再 `tunlite up --tag prod`。

任意命令加 `--json` 得到机器可读输出。退出码：
`0` 成功 · `2` 用法错 · `3` 找不到 · `4` 需打通 · `5` 连不上 daemon · `1` 其它错误。

## 工作原理

三个角色，各司一职 —— 可以理解成 **遥控器 / 引擎 / 保安**：

| 角色 | 是什么 | 职责 |
|---|---|---|
| **CLI**（`tunlite …`）| 你敲的命令 | 控制隧道（add/up/down/status/logs）；改 `config.json`、和 daemon 通信。敲完即退。 |
| **daemon**（`tunlite daemon run`）| 一个常驻后台进程 | 真正把隧道连着、断了重连、对外提供 status/logs。隧道靠它活着。 |
| **service**（`tunlite install service`）| launchd/systemd/任务计划的一条注册项 | 保活 **daemon** —— 开机拉起、挂了重启。它执行的就是 `tunlite daemon run`。 |

```
 你 ── tunlite <命令>(CLI) ──┬─ 写 config.json (add/rm/up/down)
                         ├─ NDJSON IPC → daemon (status/logs/restart)
                         └─ 一次性 ssh (check/setup-key)

 OS service ── 运行 ──▶ tunlite daemon run (daemon) ──spawn──▶ ssh -N (-L/-R/-D)
   ▲ 由 `install service` 创建                 │ 监管 + 重连（退避）
   └ 保活 daemon                                ▼
                                       config.json ◀── (重)启动时对账 reconcile
```

`config.json` 是唯一事实来源。**OS service 保活 daemon**，**daemon 保活每条隧道**，
并在每次启动时把运行中的隧道与配置对账。

**daemon 什么时候启动？** 只在 `tunlite up`（按需）或 `tunlite install service`（开机自启 +
自动重启）时。其它命令不会启动它 —— 如果它没在跑，会告诉你怎么启动。装了 service 后，
`tunlite daemon stop` 只是暂时的（OS 会把它拉起来），要彻底停用请 `tunlite uninstall service`。

**日常只需要**：`add` → `up` → `status`/`logs` → `down`，外加想开机自启就 `install
service` 一次。基本不用手敲 `tunlite daemon …` —— 那是 `up`/service 在背后驱动的底层管路。

架构与角色分工见上文“工作原理”一节。

## 给 Agent 用

agent 是一等用户。每个命令都接受 `--json` 并返回稳定退出码（`0/2/3/4/5/1`），
agent 拿到结果就能直接判断，不用解析人话。[`skill/ssh-tunnel`](skill/ssh-tunnel/SKILL.md)
这个 skill —— 用 `tunlite install skill` 安装、并随 npm 包一起发布 —— 告诉 agent
该怎么驱动 `tunlite`：`--json`、按退出码分支、以及 `needs-auth` 的处理方式。

## 配置路径

- 配置：`$XDG_CONFIG_HOME/tunlite/config.json` · `%APPDATA%\tunlite\config.json`
- 状态/日志：`$XDG_STATE_HOME/tunlite` · `%LOCALAPPDATA%\tunlite`
- 用 `TUNLITE_HOME` 把所有东西归到一个根目录下（测试时很方便）。

## 开发

```bash
node --test     # 跑测试套件（无外部依赖）
```

测试用一个可控的假 `ssh`（`fixtures/fake-ssh.js`，通过 `TUNLITE_SSH` 注入），所以完整
生命周期 —— 连接、重连、认证失败、IPC —— 都能脱网确定性地跑。

## 版本管理

遵循 SemVer（`vMAJOR.MINOR.PATCH`）。发布说明见 [`CHANGELOG.md`](https://github.com/yuanyuanzijin/tunlite/blob/master/CHANGELOG.md)，
发布流程见 [`docs/VERSIONING.md`](https://github.com/yuanyuanzijin/tunlite/blob/master/docs/VERSIONING.md)。

## 许可证

MIT
