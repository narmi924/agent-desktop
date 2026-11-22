# The user's Chrome and the agent's own browser

Web steps run in a background browser by default: it never disturbs the user and has no sign-ins. Two routes keep a
sign-in.

## The Chrome the user is using (`--chrome`)

Use it only when the user asks you to work in their browser or on a page they have open.

- The first time, run `agent-desktop-workflow connect` and tell the user that Chrome will show a prompt they must allow.
  Remote debugging has to be switched on at `chrome://inspect/#remote-debugging`; only the user can do that.
- The prompt waits 20 seconds. When `connect` reports "waiting for remote-debugging approval", ask the user to bring
  Chrome to the front and run `connect` again.
- After the user restarts Chrome, the first use asks again.

Once connected, run multi-step work with `run --chrome`; it shares the connection and asks nothing more. `web.open(URL)`
opens its own new tab and leaves the tab the user is looking at alone. To work in a tab the user already has open, claim
it by address first:

```js
await web.cmd("tab", "claim", "--url", "example.com/orders");
await web.fill("Note", "tomorrow at three");
await web.click("Save");
return await web.waitText("Saved");
```

Save it as `task.js` and run `agent-desktop-workflow run --file task.js --chrome`.

The address and text of the page in one of the user's Chrome windows: `agent-desktop-workflow current --window ID`.
`route: "web"` means the background connection reaches it; `route: "desktop"` means it does not, and later steps would
need the real mouse and keyboard, so ask the user first.

Single commands, with `page` from `current` (a page that navigated needs the value `follow` returns, or `current` again):

```powershell
$p = (agent-desktop-workflow current --window w-1234 | ConvertFrom-Json).data.page
agent-desktop-workflow edit --page $p --field "Email" --value "a@example.com"
agent-desktop-workflow click --page $p --on "Save" --role button --expect-text "Saved"
agent-desktop-workflow follow --page $p --link "Next"
```

## The agent's own browser (`--space`): sign in once, work in the background later

The user's Chrome asks for approval after every restart. When a site needs a sign-in and the user's Chrome should stay
untouched:

```powershell
agent-desktop-workflow space --login https://example.com/login   # opens a window; the user signs in there
agent-desktop-workflow space --close                              # after they signed in
agent-desktop-workflow run --space --file task.js                 # later runs keep that sign-in, in the background
```

It is separate from the user's Chrome and cannot see their tabs. `--login` opens a window, so tell the user first. A few
sites refuse background browsers; then keep the `--login` window open while `run --space` works.

## agent-browser directly

A new page with the user's sign-ins: `agent-browser --auto-connect --session work open URL`. More: `agent-browser skills get core`.
