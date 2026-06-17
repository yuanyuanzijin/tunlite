# tunlite

[English](README.md) · **简体中文**

[![CI](https://github.com/yuanyuanzijin/tunlite/actions/workflows/ci.yml/badge.svg)](https://github.com/yuanyuanzijin/tunlite/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/tunlite)](https://www.npmjs.com/package/tunlite)
[![downloads](https://img.shields.io/npm/dm/tunlite)](https://www.npmjs.com/package/tunlite)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

轻量、跨平台的 **SSH 隧道管理器** —— 用一个 CLI 取代
*autossh + 每条隧道一个 systemd 单元 + 一堆记不住的 `-L`/`-R`/`-D`*。一次定义命名隧道,
一个**零依赖**的小守护进程保持它们连接、开机自启、并帮你打通免密。每个命令都讲
**`--json`** 和稳定退出码,所以 **AI agent 用起来和你一样顺手**。

<p align="center"><img src="https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/docs/demo.gif" alt="定义隧道、守护进程自动拉起、查看状态、跟踪日志" width="760"></p>

> 📖 **完整文档 → [yuanyuanzijin.github.io/tunlite](https://yuanyuanzijin.github.io/tunlite/)**

- **面向 agent** —— 每个命令都支持 `--json`、退出码稳定,并自带一个 agent skill。
- **零第三方依赖** —— 纯 Node.js 标准库;机器上只需 **Node ≥ 18** 和它封装的系统 `ssh`。
- **自动重连** —— 指数退避 + 抖动、keepalive、端口健康探测。
- **开机自启** —— launchd(macOS)/ systemd 用户服务(Linux)/ 计划任务(Windows,beta)。
- **免密打通** —— 已能免密则直连;只在需要时帮你装公钥。
- **三种转发** —— 本地 `-L`、远程 `-R`、动态 SOCKS `-D`。

`tunlite monitor` 提供一个实时的 top 式面板 —— 一眼看清每条隧道的状态,守护进程会在你
眼前把掉线的那条自动重连回来:

<p align="center"><img src="https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/docs/monitor.gif" alt="tunlite monitor —— 实时面板,自动重连与单隧道详情" width="760"></p>

## 为什么用 tunlite?

如果你常年挂着几条 SSH 隧道 —— 一条回连到家里机器的反向隧道、一条经堡垒机的 SOCKS 代理、
一条到预发数据库的端口转发 —— 你大概给每条都配了 `autossh` 加一个 `systemd`/`launchd`
单元,还得记住哪个 `-L`/`-R`/`-D` 对应哪条。tunlite 把这些折进一个声明式 CLI,跑在你本就
信任的 `ssh` 之上:命名隧道由守护进程保活、由系统开机拉起 —— 不引入新服务、不开账号、
不造新协议。而且每个命令都是 `--json` + 稳定退出码,agent 操作的就是你操作的同一套接口。

| | tunlite | autossh | 裸 `ssh -L/-R/-D` | sshuttle | frp · bore · chisel | ngrok |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| 封装系统 `ssh`(密钥 / 跳板 / `ssh_config`) | ✅ | ✅ | ✅ | 部分 | ❌ 自有协议 | ❌ 自有服务 |
| 命名、声明式隧道 | ✅ | ❌ | ❌ | ❌ | ✅ 配置 | ✅ |
| 自动重连(退避 / keepalive / 健康) | ✅ | 基础 | ❌ | ❌ | ✅ | ✅ |
| 开机自启(launchd/systemd/计划任务) | ✅ | 自己搞 | 自己搞 | 自己搞 | 自己搞 | ✅ |
| 本地 **+** 远程 **+** 动态 SOCKS | ✅ | ✅ | ✅ | 透明代理 | 不一 | 不一 |
| 零依赖 · 无需自建服务端 · 自托管 | ✅ | 需 autossh | ✅ | 需 python | 需服务端 | 托管/收费 |
| 对 agent 友好(`--json` / 稳定退出码) | ✅ | ❌ | ❌ | ❌ | ❌ | 部分 |

## 安装

前提:**Node ≥ 18** 和系统 `ssh`,都在 PATH 上。

```bash
# 推荐 —— 拉取 + 锚定(无需全局 npm)
npx tunlite install

# 或 curl 一行式(只要 curl/wget + tar + node)
curl -fsSL https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/bootstrap.sh | sh

# Windows(PowerShell)—— beta
irm https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/bootstrap.ps1 | iex
```

`tunlite install` 会把运行时复制到固定目录,并写一个**钉死 node 绝对路径**的启动器
(这样 nvm/fnm 切版本也不会让它失效),然后逐项询问是否注册开机自启、安装 agent skill、
启用 shell 补全。`tun` 这个短名空闲时也会顺带写一个。**Windows(自启 / 启动器 / PATH)
为 beta** —— macOS/Linux 是经 CI 测试的主力平台。

## 快速开始

```bash
# --local = 你这台机器的一侧,--remote = 服务器一侧;由子命令决定谁监听。
tunlite add local   web-8080 --to user@server --remote 80 --local 8080   # 在 localhost:8080 访问服务器的 :80
tunlite add dynamic px-1080  --to user@server                            # SOCKS5 代理(本地 1080)
tunlite add remote  rev-9000 --to user@server --local 3000 --remote 9000 # 把本地 3000 暴露为服务器:9000

tunlite up                 # 立刻全部启动(拉起守护进程,需要时配密钥)
tunlite status             # 对齐表格:NAME STATE HOST TYPE ROUTE PID UP RESTARTS
tunlite logs web-8080 -f   # 跟随日志
tunlite doctor             # 体检:为什么连不上
```

目标还没免密时,在终端跑 `tunlite up` 会让你输一次密码并自动装公钥。也可显式来:
`tunlite check user@server`(退出 0 = 已免密)/ `tunlite setup-key user@server`。

**开机自启(可选):**`tunlite install service` 把守护进程注册成登录自启(崩溃也会拉起)。
它**当场也会把一切启动起来**,所以想让隧道持久常驻时,它**替代** `up` —— 两者不用都做。

## 升级

```sh
tunlite update              # 升到最新(默认重启守护进程,隧道闪断约 1 秒)
tunlite update v0.9.0       # 装/回退到指定标签
tunlite update --check      # 只比对当前与最新,不做改动
```

`update` 升级到**最新的 release tag**:从 GitHub 拉那个 tag 的 tar 包就地重新锚定
(**不走 npm、不走 git**)—— `npx` 装第一份,`update` 把它保持在一个真实已发布的版本。
它只自更新锚定安装:在 git 检出里提示你用 `git pull`,在 `npm i -g` 安装里提示你用
`npm i -g tunlite@latest`(让那条渠道的版本元数据保持权威)。

## 命令一览

```
add local|remote|dynamic   定义隧道              set / rm / rename     改 / 删 / 重命名
forward list|add|rm        管理一条隧道的多个转发  list [--tag T]        列出隧道
up / down / restart        控制(名字|--tag|全部)
status / logs / monitor    查看(表格 · 跟随 · 实时面板)
doctor                     为什么隧道连不上
check / setup-key          探测 / 安装免密访问
webhook …                  掉线告警到 webhook(generic · 企业微信)
export / import            备份 / 合并隧道
install [service|skill|completion] / uninstall    锚定运行时 · 自启 · agent skill · Tab 补全
update                     从 GitHub 自更新
```

完整参数跑 `tunlite help` 或给任意命令加 `--help`;跳板机(`--jump`)、标签(`--tag`)、
webhook 的 channel/事件、shell 补全等细节见
[文档站](https://yuanyuanzijin.github.io/tunlite/)。

**转发模型:**每个 `add` 定义一个转发(一条隧道可用 `forward add` 携带多个)。`--local`
永远指**你这侧**、`--remote` 永远指**服务器侧**,由子命令决定谁监听 —— `local`(在本地访问
远端服务)、`remote`(把本地服务暴露到服务器)、`dynamic`(本地 SOCKS5 代理)。SSH 端口写在
目标上(`--to user@host:2222`,默认 22)。

**退出码**(任意命令可加 `--json`):`0` 成功 · `2` 用法 · `3` 没找到 · `4` 缺密钥 ·
`5` 连不上守护进程 · `1` 其它。

## 工作原理

三个角色,各司一职:

| 角色 | 是什么 | 干什么 |
|---|---|---|
| **CLI**(`tunlite …`) | 你敲的命令 | 改 `config.json`、跟守护进程通信、跑一次性 ssh,做完即退。 |
| **守护进程**(`tunlite daemon run`) | 常驻后台进程 | 真正保持隧道连接、掉线重连、提供 status/logs。 |
| **服务**(`install service`) | 一条 launchd/systemd/计划任务条目 | 保活**守护进程** —— 开机拉起、崩溃重启。 |

`config.json` 是唯一事实来源。系统服务保活守护进程,守护进程保活每条隧道。日常你只需
`add` → `up` → `status`/`logs`,想要开机自启再 `install service` 一次。

## 给 Agent 用

agent 是一等用户:每个命令都支持 `--json` 并返回稳定退出码,无需解析自然语言即可据结果行动。
随包附带的 [`skill/ssh-tunnel`](skill/ssh-tunnel/SKILL.md)(由 `tunlite install skill` 安装)
告诉 agent 怎么驱动 `tunlite` —— `--json`、按退出码分支、处理 `needs-auth`。

## 版本与许可

语义化版本(`vMAJOR.MINOR.PATCH`);更新记录见 [`CHANGELOG.md`](https://github.com/yuanyuanzijin/tunlite/blob/master/CHANGELOG.md)。
MIT。
