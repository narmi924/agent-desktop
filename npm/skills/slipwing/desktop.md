# Desktop apps: single commands and windows without controls

`desktop.*` in a script covers most work. This file is for what scripts do not.

## Opening an app

`launch` takes a Start-menu name (`Calculator`, `计算器`, `Google Chrome`), an app id or a program file name (`chrome`).
Unsure of the name: `slipwing desktop list-apps --installed --app WORD`. A name with several matches is refused with
`AMBIGUOUS_TARGET` and the candidates; use one of their ids. An app that already runs is attached to, not started again.

## Single commands

Quote refs with single quotes, for example `'@s8f3k2p9:e1'`: PowerShell drops an unquoted one, and Bash keeps it either
way, so the lines below work in both.

```bash
slipwing desktop list-windows
slipwing desktop snapshot --window-id w-1234 -i --compact
slipwing desktop click '@s8f3k2p9:e5'
slipwing desktop set-value '@s8f3k2p9:e2' 'text'
slipwing desktop snapshot --window-id w-1234 -i --compact --since s8f3k2p9
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
- A minimized window cannot be operated: `slipwing desktop restore --app NAME` first.
- `disposition.delivery` of a single command: `delivered_verified` took effect, `delivered_unverified` was sent but not
  confirmed, `not_delivered` was not sent. Retry directly only when `disposition.retry` is `safe`.
- An action that should produce a file: add `--expect-file PATH` and read `data.receipt.verified`.

## Windows without controls (self-drawn apps, canvases, remote desktops, images)

Write a `run` script with names as usual: a name no control has is looked for in the window's picture. A window whose
only control is its title bar is read from its picture straight away.

- Reading: `desktop.read(WINDOW)` lists the picture's text as `- text "..." [picture x,y]`; `{picture: true}` adds it for
  ordinary windows too. Reading moves nothing.
- `desktop.click` by picture first posts the click to the window in the background: the window stays where it is and
  the pointer stays with the user. It counts when the window then shows a change (its text, a control, or a window of
  the same app opening, closing or changing title) and returns `{via: "picture", background: true, text, x, y}`.
  `CLICK_UNCONFIRMED` means the click may have arrived. Check the application's result, such as the saved record or
  sent message, before deciding whether another click is needed. Only a confirmed refusal of the background method
  before delivery allows a real click, which requires `--allow-input`.
- `desktop.fill` by picture brings the window forward, clicks the text with the real mouse and types, then checks the
  picture; it needs `--allow-input`, does not clear the field first and returns `false` with a warning when the text
  does not show.
- The same text in several places is refused with `AMBIGUOUS_TARGET` and the places; pick one with
  `{near: "text beside it"}` or `{nth: 2}` (top to bottom). `{picture: false}` keeps a step to controls.

Single commands:

```bash
slipwing view --window w-1234 --output a.png   # without --output it names a file; the reply has the path
slipwing desktop ocr --image a.png --find "Save"
slipwing tap --frame a.png --text "Save"
slipwing tap --frame a.png --at 812,604
slipwing desktop --headed type --window-id w-1234 "Build 1482 received"
```

- `tap` and `type --window-id` use the real mouse and keyboard; ask first.
- `slipwing desktop mouse-click --post --frame a.png --xy X,Y` posts one click to the window in the background, with no
  `--headed`. It reports `delivered_unverified`: compare the window before and after to know whether the app took it.
- Coordinates are picture pixels. A closed, resized or retitled window, or a changed patch around the point, refuses the
  action with `STALE_REF`; take a new `view`. Several matches need `--nth N`.
- `ocr --find` prefers a line that is exactly the text over the text inside a longer line, so "Send" lands on the button,
  not on "Send file".
- `type --window-id` types where the window's focus is and cannot read the result back; it is always
  `delivered_unverified`, so check with `ocr --find`.

## More

```bash
slipwing desktop skills get desktop
slipwing desktop skills get platform
```
