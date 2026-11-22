# Routines: done once, called by name afterwards

A task that a `run` script finished once is saved as a named routine. Next time call it: no reading the interface, no
new script. A routine runs without the model in the loop, so it is fast and works the same for weaker agents.

## Look for one first

```bash
agent-desktop-workflow routine list                # one line each: name (params): about [input] [final] [runs]
agent-desktop-workflow routine list --for orders   # filtered by name, description, app or site
agent-desktop-workflow routine show weekly-orders  # parameters, steps and the script
```

A `run` reply with `known_routines` means saved routines already work on this app or site; use them next time.

## Run

```bash
agent-desktop-workflow routine run weekly-orders --args-file args.json --allow-final
```

- Arguments go in `--args '{"who":"Gulnar"}'` or `--args-file ARGS.json` (a file for non-ASCII text). A missing one
  gives `MISSING_ARGS` with what is needed.
- A routine with a send, submit, pay or delete step needs `--allow-final`, after the user agreed. Real input still needs
  `--allow-input` or a way of working that allows it.
- Every step is compared with the saved runs: a window that should open and does not, or an unknown window or dialog,
  stops it at that step with `code: "EFFECT_MISMATCH"`, `details.expected`, `details.found`, `scene` and the `steps`
  already done. Do not rerun the routine: read `scene` and finish the rest with `run`.

## Save

Only a script that finished is saved. Values go in as `args.NAME`, never into the script:

```bash
agent-desktop-workflow run --file order.js --args-file args.json --allow-final \
  --save weekly-orders --about "export this week's orders and register them" --param who="recipient" --param shop="shop name"
```

- Argument values are not stored; the names and descriptions are.
- End the script with a check of the last action's result (`waitText`, `waitFor`, `value`, `has`, `expect`), or a
  warning says a later run cannot tell whether it worked.
- The same name needs `--replace`; the old one is kept as a version. After a mismatch you finished by hand, save the
  fixed script under the same name with `--replace`.
- `--mode watch` (or another way) on the saving run is remembered for the routine.

## Run at set times

When the user says "export the orders every morning at nine" or "每天九点导出订单":

```bash
agent-desktop-workflow routine schedule weekly-orders --at 09:00 --every weekdays --args-file args.json
agent-desktop-workflow routine unschedule weekly-orders
```

- `--every` is `day` (default), `weekdays`, `hour`, or days such as `mon,wed,fri`.
- It runs through the Windows Task Scheduler, only while the user is signed in, without a window. `routine list` ends
  with the `schedules`.
- Nobody is in a chat when it fires, so the arguments are kept in the state folder for it (saved routines otherwise keep
  none). Each run shows the user a notification with the job id when it finishes, fails, stops before a final step,
  needs the mouse and keyboard, or waits for a fix. When the user comes back, `job show ID` first.
- A routine with a final step: ask when you set the schedule. With the user's yes add `--allow-final`; without it the
  run stops before that step and waits for approval.
- Schedule only on the user's words. `routine remove` drops the routine's schedule too.

## Final steps

A click on a control whose name holds send, submit, pay, delete, post, order and similar words (in English and Chinese),
or a step marked `{final: "why"}`, is a final step. Without `--allow-final` a script whose final steps can be seen is not
run at all, and one found while running stops before it with `FINAL_NOT_ALLOWED`; `details.picture` marks the target.
A name that only looks final (a "Send file" button that opens a picker) takes `{final: false}`.

It guards against slips only: Enter to submit, or a `css:` selector, cannot be seen.

## Routines the user trusts, and protected apps and sites

- When the user says in the chat "this routine may always send", run `routine allow NAME`: its final steps no longer
  ask, in the foreground, in jobs and when started by a watch or schedule. Never run it without those words. Saving the
  routine again with `--replace` cancels it.
- `routine permissions` lists trusted routines and protected apps and sites; `routine revoke NAME` takes trust back.
- The user can write `{"apps": ["app.exe"], "hosts": ["example.com"]}` into `protected.json` in the state folder. Only
  routines the user trusts may act there; other scripts are refused with `SURFACE_PROTECTED` before anything is sent.
  Only the user edits that file.
- For agents that can run a shell these are guards against slips, since such an agent can edit files.
