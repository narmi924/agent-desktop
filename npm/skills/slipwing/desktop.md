# Desktop apps: single commands and windows without controls

`desktop.*` in a script covers most work. This file is for what scripts do not.

## Opening an app

`launch` takes a Start-menu name (`Calculator`, `计算器`, `Google Chrome`), an app id or a program file name (`chrome`).
Unsure of the name: `agent-desktop list-apps --installed --app WORD`. A name with several matches is refused with
`AMBIGUOUS_TARGET` and the candidates; use one of their ids. An app that already runs is attached to, not started again.

## Single commands

In PowerShell, quote refs with single quotes, for example `'@s8f3k2p9:e1'`, or the argument disappears.

```powershell
agent-desktop list-windows
agent-desktop snapshot --window-id w-1234 -i --compact
agent-desktop click '@s8f3k2p9:e5'
agent-desktop set-value '@s8f3k2p9:e2' 'text'
agent-desktop snapshot --window-id w-1234 -i --compact --since s8f3k2p9
```

- By default nothing comes to the front and the pointer stays put; keep it that way when you can. Prefer `set-value`,
  then `click`.
- `type`, `double-click`, `right-click`, `focus`, `drag` and `mouse-*` need `--headed`: they bring the window forward and
  move the pointer, so ask the user first.
- `type --headed` sends real keys: text with line breaks needs `--entry-mode multiline`; text goes in at the caret, so
  append with `--at end`. To only put text into a field, use `set-value`, line breaks included; no input method interferes.
- A changed interface makes old refs stale: on `STALE_REF` take a new `snapshot`. Two identical controls give
  `AMBIGUOUS_TARGET`.
- Chromium and Electron apps show little right after they open: read again with `--timeout-ms 15000`.
- A minimized window cannot be operated: `agent-desktop restore --app NAME` first.
- `disposition.delivery` of a single command: `delivered_verified` took effect, `delivered_unverified` was sent but not
  confirmed, `not_delivered` was not sent. Retry directly only when `disposition.retry` is `safe`.
- An action that should produce a file: add `--expect-file PATH` and read `data.receipt.verified`.

## Windows without controls (self-drawn apps, canvases, remote desktops, images)

Write a `run` script with names as usual: a name no control has is looked for in the window's picture. A window whose
only control is its title bar is read from its picture straight away.

- Reading: `desktop.read(WINDOW)` lists the picture's text as `- text "..." [picture x,y]`; `{picture: true}` adds it for
  ordinary windows too. Reading moves nothing.
- Clicking and filling by picture bring the window forward and use the real mouse and keyboard, so without
  `--allow-input` the step returns `INPUT_NOT_ALLOWED` with where the picture shows the name. Ask, then run the rest
  with `--allow-input`.
- `desktop.click` by picture returns `{via: "picture", text, x, y}`. `desktop.fill` by picture clicks the text and types,
  then checks the picture; it does not clear the field first and returns `false` with a warning when the text does not show.
- The same text in several places is refused with `AMBIGUOUS_TARGET` and the places; pick one with
  `{near: "text beside it"}` or `{nth: 2}` (top to bottom). `{picture: false}` keeps a step to controls.

Single commands:

```powershell
slipwing view --window w-1234 --output a.png   # without --output it names a file; the reply has the path
agent-desktop ocr --image a.png --find "Save"
slipwing tap --frame a.png --text "Save"
slipwing tap --frame a.png --at 812,604
agent-desktop --headed type --window-id w-1234 "Build 1482 received"
```

- `tap` and `type --window-id` use the real mouse and keyboard; ask first.
- Coordinates are picture pixels. A closed, resized or retitled window, or a changed patch around the point, refuses the
  action with `STALE_REF`; take a new `view`. Several matches need `--nth N`.
- `ocr --find` prefers a line that is exactly the text over the text inside a longer line, so "Send" lands on the button,
  not on "Send file".
- `type --window-id` types where the window's focus is and cannot read the result back; it is always
  `delivered_unverified`, so check with `ocr --find`.

## More

```powershell
agent-desktop skills get desktop
agent-desktop skills get platform
```
