[English](README.md) | [简体中文](README.zh-CN.md)

# Slipwing

Use Slipwing to let your AI agent work in your Windows apps and browser while you keep using the PC.

Slipwing is a personal Windows build of [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) and
[vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser), plus a `slipwing` command that runs one task
across both. Version 0.1.0 is built on agent-desktop v1.3.1 (+6 commits) and agent-browser v0.43.0 (+38 commits);
`slipwing --version` prints the exact bases. It runs on Windows and has been tested on Windows 11. On macOS and Linux,
use the official packages.

<!-- MEDIA: 10 s clip, "fill the tracking number from order D6182 into the open register window, don't touch my mouse"; links to the MP4 -->

## Why

I give my coding agent errands on the same computer I am working on: copy an order's tracking number from a web page
into a desktop register, fill a form in a site I am signed in to, read a window I have open. I need three things for that.
The agent must not take my mouse while I type. It must type exactly, and my input method is Microsoft Pinyin. And it must
not do a send or submit twice when something goes wrong halfway.

The official agent-desktop reads controls through UI Automation and works in the background, which is the right base.
Under Microsoft Pinyin in Chinese mode, the build I started from reported `hello` as typed while the field stayed
empty, and `abc中文def` arrived as `abc'de'f中文`. Most other tools I tried work on the screen itself.

On four local test tasks (two forms on a web page, a desktop register window, a self-drawn chat window), measured on
2026-11-22. Claude Sonnet drove the first four tools; the Codex and Claude apps used their own models.

<!-- Sidehand row goes in after the head-to-head run -->

| Tool | Done right | Tasks that took the mouse and keyboard | Notes |
|---|---|---|---|
| Slipwing 0.1.0 | 4 of 4 | 0 | 7 to 28 s per task |
| official agent-desktop 1.3.1 and agent-browser 0.43.0 | 4 of 4 | 0 | 11 to 20 s per task |
| [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) 0.9.0 | 4 of 4 | 4 | 20 to 70 s |
| [Hybrid Computer Use](https://github.com/microsoft/Hybrid-Computer-Use) 1.0.1 | 4 of 4 | 3 | 8 to 46 s |
| Codex Computer Use (Codex app) | 2 of 4 | 3 | both web tasks stopped because it could not confirm the browser address |
| Claude desktop computer use | 2 of 4 | at least 1; the app does not show the rest | read-only in browsers; its built-in browser did not open the local address |

On these tasks the official build does as well as Slipwing. What Slipwing adds is around them:

| Added | What you get |
|---|---|
| web and desktop in one task | read an order in a browser tab and register it in a desktop app in one call; web steps use the page's own controls, native drop-downs included, without the foreground |
| a browser you pick | your signed-in Chrome in its own tab, a clean browser, or your Chrome on screen so you can watch |
| real keys under Microsoft Pinyin | when a page needs real keystrokes and Pinyin is in Chinese mode, English text still lands as typed, and the step reads the field back |
| four ways of working | background, watch, record, direct; watch and record move the pointer and type at a human pace; set per request, per routine, per project folder or everywhere |
| step reports | each step says which windows opened and which controls changed, so a click that did nothing shows |
| a stop before final steps | send, submit, pay and delete steps it recognizes by name wait until you agree in the chat |
| sharing the mouse | when you touch the mouse or keyboard the agent stops typing and waits; nothing is sent on a locked screen |
| routines | a task done once is saved by name and runs again with new values, without the model reading the screen |
| watches | wait for a window, a line of text (self-drawn windows included), a notification or a downloaded file, then run a routine |

## Quick start

You need Windows 10 or 11 and [Node.js](https://nodejs.org) 22 or later. In PowerShell:

```powershell
irm https://github.com/narmi924/slipwing/releases/latest/download/install.ps1 | iex
```

It replaces the official `agent-desktop` and `agent-browser` npm packages, adds the `slipwing` command, and adds a
short `slipwing` skill for Claude Code and Codex. Then tell your agent:

> Use the slipwing skill. Copy the tracking number of order D6182 from my Chrome into the open Customer register
> window and save it. Don't touch my mouse.

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
| "save this" | keeps the task as a routine to run again by name |
| "when the export finishes, upload it" | waits for that window or file, then runs the upload routine |

Agents that cannot run commands can use `slipwing mcp` as an MCP server with the same tools.

## How it works

The agent writes one JavaScript task and runs it once with `slipwing run`. Web steps go to agent-browser over the
Chrome DevTools Protocol; desktop steps go to agent-desktop over UI Automation, setting values and invoking buttons
without moving the pointer. A window with no controls is read from its picture with the Windows OCR engine. Only steps
that need real input take the mouse and keyboard, and only after you agreed or chose a way that does.

Measured on this machine (Windows 11, min of 7 runs): reading a page's text 0.27 s, a six-field web form with submit
0.71 s, reading a desktop window 0.3 to 0.56 s. A saved routine cut eight repeated tasks from 360 s to 189 s, mostly by
not asking the model again.

Everything it keeps is in `%USERPROFILE%\.agent-desktop`: routines, preferences, job records. Delete the folder to
start over. Routines store parameter names, not the values you passed.

The agent-desktop changes and the `slipwing` command are in this repository. The agent-browser changes are in
[narmi924/agent-browser](https://github.com/narmi924/agent-browser) on its `personal` branch.

## License

Apache-2.0, as the two upstream projects. The upstream license files are kept.
