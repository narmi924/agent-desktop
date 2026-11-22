[English](README.md) | [简体中文](README.zh-CN.md)

# agent-desktop for Windows

Let Claude Code or Codex finish a task in the Windows apps and browser you are using, while you keep working in front.

This is a personal Windows build of [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) and
[vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser). Bundle 0.1.0 is built on agent-desktop
v1.3.1 (+6 commits) and agent-browser v0.43.0 (+38 commits); `agent-desktop-workflow --version` prints the exact bases.
It is for Windows and has been tested on Windows 11. On macOS and Linux, use the official packages.

<!-- MEDIA: 10 s clip, "fill the tracking number from order D6182 into the open register window, don't touch my mouse"; links to the MP4 -->

## Why

I give my coding agent errands on the same computer I am working on: copy an order's tracking number from a web page
into a desktop register, fill a form in a site I am signed in to, read a window I have open. I need three things for that.
The agent must not take my mouse while I type. It must type exactly, and my input method is Microsoft Pinyin. And it must
not do a send or submit twice when something goes wrong halfway.

The official agent-desktop reads controls through UI Automation and works in the background, which is the right base.
Under Microsoft Pinyin in Chinese mode, the build I started from reported `hello` as typed while the field stayed
empty, and `abc中文def` arrived as `abc'de'f中文`. The other tools I tried work on the screen itself.

On four local test tasks (two forms on a web page, a desktop register window, a self-drawn chat window), measured on
2026-11-22. Claude Sonnet drove the first four tools; the Codex and Claude apps used their own models.

| Tool | Done right | Tasks that took the mouse and keyboard | Notes |
|---|---|---|---|
| this build | 4 of 4 | 0 | 7 to 28 s per task |
| official agent-desktop 1.3.1 and agent-browser 0.43.0 | 4 of 4 | 0 | 11 to 20 s per task |
| [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) 0.9.0 | 4 of 4 | 4 | 20 to 70 s |
| [Hybrid Computer Use](https://github.com/microsoft/Hybrid-Computer-Use) 1.0.1 | 4 of 4 | 3 | 8 to 46 s |
| Codex Computer Use (Codex app) | 2 of 4 | 3 | both web tasks stopped because it could not confirm the browser address |
| Claude desktop computer use | 2 of 4 | at least 1; the app does not show the rest | read-only in browsers; its built-in browser did not open the local address |

On these tasks the official build does as well as this one. What this build adds is around them:

| Added | What you get |
|---|---|
| exact typing under input methods | text goes in as typed under Microsoft Pinyin, in Chinese or English mode, in every typing path |
| one script across web and desktop | read an order in the browser and register it in a desktop app in one call |
| your own Chrome without the foreground | work in your signed-in Chrome in its own tab while you use another window |
| four ways of working | background, watch, record, direct; per request, per routine, per project folder or everywhere |
| step reports | each step says which windows opened and which controls changed, so a click that did nothing shows |
| final-step guard | send, submit, pay and delete steps are refused until you agree in the chat |
| sharing the mouse | when you touch the mouse or keyboard the agent stops typing and waits; nothing is sent on a locked screen |
| routines | a task done once is saved by name and runs again without the model reading the screen |
| jobs, watches, schedules | long work in the background, "tell me when the export finishes", "every weekday at nine" |

## Quick start

You need Windows 10 or 11 and [Node.js](https://nodejs.org) 22 or later. In PowerShell:

```powershell
irm https://github.com/narmi924/agent-desktop/releases/latest/download/install.ps1 | iex
```

It replaces the official `agent-desktop` and `agent-browser` npm packages and adds a short `desktop-browser-control`
skill for Claude Code and Codex. Then tell your agent:

> Use the desktop-browser-control skill. Copy the tracking number of order D6182 from my Chrome into the open Customer
> register window and save it. Don't touch my mouse.

To use your own Chrome, turn on remote debugging once at `chrome://inspect/#remote-debugging`; Chrome asks you to allow
the connection after each restart. Back to the official packages: `npm install -g agent-desktop agent-browser`.

## What to say

| You say | It does |
|---|---|
| nothing about how | works in a clean browser and through controls, in the background |
| "use my browser" | works in your Chrome in its own tab, still in the background |
| "let me watch" | works on screen at a human pace with an amber pointer that says "don't touch" |
| "this is for a recording" | the same, with your own pointer |
| "just use the mouse" | uses real input where a step needs it, at full speed |
| "from now on in this project …" | remembers that way for the project folder |
| "save this" / "every weekday at nine" | keeps the task as a routine, or runs it on a schedule |

Agents that cannot run commands can use `agent-desktop-workflow mcp` as an MCP server with the same tools.

## How it works

The agent writes one JavaScript task and runs it once with `agent-desktop-workflow run`. Web steps go to agent-browser
over the Chrome DevTools Protocol; desktop steps go to agent-desktop over UI Automation, setting values and invoking
buttons without moving the pointer. A window with no controls is read from its picture with the Windows OCR engine.
Only steps that need real input take the mouse and keyboard, and only after you agreed or chose a way that does.

Measured on this machine (Windows 11, min of 7 runs): reading a page's text 0.27 s, a six-field web form with submit
0.71 s, reading a desktop window 0.3 to 0.56 s. A saved routine cut eight repeated tasks from 360 s to 189 s, mostly by
not asking the model again.

Everything it keeps is in `%USERPROFILE%\.agent-desktop`: routines, preferences, job records. Delete the folder to
start over. Routines store parameter names, not the values you passed; a schedule keeps its arguments so it can run
alone.

## License

Apache-2.0, as the two upstream projects. The upstream license files are kept.
