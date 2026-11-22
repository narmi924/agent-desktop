[English](README.md) | [简体中文](README.zh-CN.md)

# Slipwing

让你的 AI agent 在 Windows 电脑上替你操作软件和浏览器，你照常用你的电脑。

Slipwing 是 [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) 和
[vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) 的个人 Windows 版，另外加了一个
`slipwing` 命令，一件事可以跨这两个工具一次做完。0.1.0 基于 agent-desktop v1.3.1 之后 6 个提交、agent-browser
v0.43.0 之后 38 个提交，`slipwing --version` 会打出确切的版本。只支持 Windows，在 Windows 11 上测过。macOS 和
Linux 请用官方版。

<!-- 媒体：10 秒短片，“把订单 D6182 的物流单号填进开着的客户登记窗口，别动我的鼠标”，点开是 MP4 -->

## 为什么做

我会在自己正在用的电脑上，让写代码的 agent 顺手办些事：把网页上一张订单的物流单号抄进桌面上的登记软件，在我已经登录的网站上填一张表，读一下我开着的某个窗口。为此需要三件事：我打字的时候它不能抢鼠标；它打字要一字不差，而我的输入法是微软拼音；中途出了岔子，它不能把发送、提交做两遍。

官方的 agent-desktop 通过 UI 自动化读控件、在后台操作，这是对的起点。但微软拼音在中文模式下，我最初用的那个版本打 `hello` 报成功，输入框里却是空的；`abc中文def` 打出来成了 `abc'de'f中文`。我试过的其他工具大多直接在屏幕上操作。

2026 年 11 月 22 日在本机用四道测试题比了一次：网页上两张表、一个桌面登记窗口、一个自己绘制界面的聊天窗口。前四个工具都由 Claude Sonnet 来驱动，Codex 和 Claude 桌面版用的是它们自己的模型。

<!-- Sidehand 那一行等同题对比跑完再加 -->

| 工具 | 做对 | 用了真键鼠的题数 | 说明 |
|---|---|---|---|
| Slipwing 0.1.0 | 4 道全对 | 0 | 每道 7 到 28 秒 |
| 官方 agent-desktop 1.3.1 和 agent-browser 0.43.0 | 4 道全对 | 0 | 每道 11 到 20 秒 |
| [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) 0.9.0 | 4 道全对 | 4 | 20 到 70 秒 |
| [Hybrid Computer Use](https://github.com/microsoft/Hybrid-Computer-Use) 1.0.1 | 4 道全对 | 3 | 8 到 46 秒 |
| Codex 的 Computer Use（Codex 应用） | 对 2 道 | 3 | 两道网页题都因为确认不了浏览器网址，自己停下了 |
| Claude 桌面版的电脑操控 | 对 2 道 | 至少 1，应用里看不到其余的 | 在浏览器里只能看；改用内置浏览器后没能打开本机网址 |

在这四道题上，官方版和 Slipwing 做得一样好。Slipwing 多出来的东西在这些题之外：

| 多了什么 | 用起来是什么样 |
|---|---|
| 网页和桌面一次做完 | 在浏览器标签页里读订单，在桌面软件里登记，一次调用做完；网页步骤用页面自己的控件，原生下拉框也能选，不抢前台 |
| 浏览器由你挑 | 你已登录的 Chrome 里新开一个标签页、一个干净的浏览器，或者你的 Chrome 摆在屏幕上让你看着 |
| 微软拼音下的真实按键 | 网页非要真实按键、拼音又在中文模式时，英文照样原样输入，打完还会读回输入框核对 |
| 四种做法 | 后台、看着做、录屏、直接操作；看着做和录屏时按真人的节奏移动光标、打字；可以按这一次、按动作、按项目文件夹或者所有地方来定 |
| 每一步报出改了什么 | 哪个窗口开了、哪个控件变了；点了没反应会被看出来 |
| 终点步先停下 | 按名字认得出的发送、提交、付款、删除这类一步，你在对话里同意前不做 |
| 和你共用键鼠 | 你一碰鼠标键盘，它就停下打字等你；锁屏时什么都不发 |
| 动作 | 做成过一次的事存个名字，下次换个值就能重做，不用模型再看屏幕 |
| 盯着 | 等某个窗口、某行字（自己绘制界面的窗口也行）、某条通知或某个下载好的文件出现，再接着跑一个动作 |

## 快速开始

需要 Windows 10 或 11，以及 [Node.js](https://nodejs.org) 22 或更新的版本。在 PowerShell 里运行：

```powershell
irm https://github.com/narmi924/slipwing/releases/latest/download/install.ps1 | iex
```

它会替换官方的 `agent-desktop` 和 `agent-browser` 两个 npm 包，装上 `slipwing` 命令，并给 Claude Code 和 Codex
各加一个很短的 `slipwing` skill。然后对你的 agent 说：

> 用 slipwing 这个 skill。把我 Chrome 里订单 D6182 的物流单号填进开着的客户登记窗口并保存，别动我的鼠标。

要用你自己的 Chrome，先在 `chrome://inspect/#remote-debugging` 打开远程调试，这一步只做一次；之后每次重启 Chrome，第一次连接时 Chrome 会请你点一下允许。换回官方版：`npm install -g agent-desktop agent-browser`。

## 怎么说

| 你说 | 它怎么做 |
|---|---|
| 没说怎么做 | 用干净的浏览器、通过控件，在后台做 |
| “用我的浏览器” | 在你的 Chrome 里新开一个标签页做，照样在后台 |
| “让我看着做” | 在屏幕上按真人的节奏做，琥珀色光标提醒你别碰 |
| “这是要录屏的” | 同上，光标保持你原来的样子 |
| “直接用鼠标就行” | 需要的步骤直接用键鼠，不放慢 |
| “这个项目以后都……” | 记住这个项目文件夹用哪种做法 |
| “存下来” | 存成动作，以后叫名字就能再做 |
| “导出完了就上传” | 等那个窗口或文件出现，再跑上传的动作 |

不能自己跑命令的 agent，可以把 `slipwing mcp` 当作 MCP 服务接进来，工具是同一套。

## 原理

agent 把整件事写成一段 JavaScript，用 `slipwing run` 跑一次。网页步骤通过 Chrome 调试协议交给 agent-browser；桌面步骤通过 UI 自动化交给 agent-desktop，直接填值、按按钮，不移动鼠标。没有控件的窗口用 Windows 自带的文字识别读截图。只有确实要真键鼠的步骤才会用键盘鼠标，而且要你同意过，或者你选了允许用键鼠的做法。

本机实测（Windows 11，7 次里取最快）：读一个网页的文字 0.27 秒，填一张 6 项的网页表并提交 0.71 秒，读一遍桌面窗口 0.3 到 0.56 秒。同样 8 件重复的事，存成动作以后从 360 秒降到 189 秒，主要省在不用再问模型。

它留下的东西都在 `%USERPROFILE%\.agent-desktop`：动作、偏好、任务记录。删掉这个文件夹就回到初始状态。动作只存参数名，不存你传过的值。

## 许可证

Apache-2.0，和两个上游项目一致，保留了上游的许可证文件。
