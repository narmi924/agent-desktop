# Moving like a person

Only when the user asks for it: a recording, a demonstration, "let me watch". It is slower and takes the mouse and
keyboard. It is not a way past bot detection or captchas.

The simplest form is a way of working: `run --mode watch` (amber pointer) or `run --mode record` (the user's own
pointer). The script stays the same; desktop and web steps then happen on screen at a human pace. Say what you will do
and for about how long before you start.

For finer control write `human("natural")` at the top of a script that runs with `--allow-input`, and use `visible.*`
for the Chrome page on screen:

```js
human("natural");
await visible.use();                          // take over the Chrome tab on screen
await readTime("the paragraph that explains the question");
await visible.choose("Option B");             // pick it and confirm the page shows it picked
await visible.type("Note", "tomorrow at three");
await visible.scrollTo("Submit");             // scroll until Submit shows
await visible.click("Submit");
return await visible.read();
```

Save it as `task.js` and run `agent-desktop-workflow run --file task.js --allow-input --allow-final` (it clicks Submit,
a final step).

```
visible:  use(window?)  read()  open(url)  click(name)  hover(name)  choose(name)  select(field, option)
          type(field, text, {at, multiline, replace})  press(keys)  scrollTo(text)  scroll(lines)
          waitText(text)  waitFor(name)  waitIdle()  has(name)
```

`visible.*` works on the Chrome window on screen with the real mouse and keyboard. It reads that window directly, needs
no `connect` and no `--chrome`. With `human("natural")` on, `visible.*`, `desktop.click` and `desktop.type` all move and
type like a person.

- One helper is one thing a person does: pick an option, fill a field, scroll to a paragraph.
- Several actions in one desktop window: `desktop.sequence(WINDOW, [{click: "Name"}, {type: ["Field", "text"]}, {press: "enter"}])`
  sends them together with about 0.45 s between them, like one person; separate calls wait about 1 s each.
- Waits follow the content: `readTime(text)` for reading, `waitText` for results, never a fixed `sleep(8000)`.
- The pointer moves only to click, scroll or select. Not moving while reading is normal.
- `natural` is the default. `careful` is only slower near small targets; it is not "more human".
- Never pick wrong answers or make typos to look human. Typing is exact; add `--typos` only when a recording wants it.
- Text that only has to be in a field: `web.fill` or `desktop.fill`. No keys are sent and no input method interferes.
- Typing goes in at the caret; a field nobody clicked has its caret at the start. Append with `{at: "end"}`; text with
  line breaks needs `{multiline: true}`, or the step is refused before anything is sent.
- Radio buttons and checkboxes: `visible.choose(name)`, which checks the page shows the choice. Never aim at the circle.
- Controls off screen are scrolled to by `visible.click` and `visible.choose`. To scroll, use `visible.scrollTo(text)`.
- "The pointer is not where it was" with `details.off_by`: a few pixels means a bump, read again and go on; many pixels
  means a person took over, so stop and ask. Do not retry on your own.

Single commands take `--headed --human natural`: `click`, `double-click`, `triple-click`, `right-click`, `type` (with
`--window-id` too), `drag`, `mouse-move`, `mouse-click`, `mouse-wheel`, and the page commands `tap` and `move`.
`--seed N` repeats the same motion. A human scroll moves at most 15 lines at a time.

## The pointer

While the agent uses the real mouse and keyboard the pointer turns into an arrow with an amber glow, telling the user not
to touch. It changes back within a second after the last command; a script keeps it from its first real input to its end.

- Errors, timeouts and killed commands all change it back. If it ever stays, run `agent-desktop restore-cursor`.
- Turn it off for good when the user asks: `agent-desktop-workflow prefs set pointer=off --always`; for one run set
  `AGENT_DESKTOP_POINTER=off`. Other looks: `red`, `green`, or the path of a square PNG with the arrow tip at 32%.
