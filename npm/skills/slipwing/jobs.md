# Jobs: long work in the background, waiting for a fix in place

## When

Work that takes longer than about 20 seconds (a routine of dozens of steps, a page or app that is slow to answer) goes
to the resident host, so you can keep talking with the user:

```bash
slipwing routine run NAME --args-file ARGS.json --allow-final --detach
slipwing run --file task.js --detach
```

The reply is a job `id` at once. The host starts itself when needed, without a window, and leaves after 30 idle minutes.

## Waiting

Run `slipwing job wait ID` in the background right after `--detach` (in Claude Code, Bash with
`run_in_background`). It returns when the job ends or needs you, and you are woken. Keep answering the user meanwhile.
`slipwing job wait ID --timeout-ms MS` returns after MS at the latest, with the job as it is then.

| state | meaning | you |
|---|---|---|
| `done` | finished; `result` is the reply `run` gives: the script's value is `result.result`, its steps `result.steps` | tell the user |
| `waiting`, `reason: "fix"` | a step failed and the job waits in place; finished steps are not redone | see below |
| `waiting`, `reason: "approval"` | no `--allow-final`; stopped before a send, submit or delete step, described in `waiting.final` | ask the user once in the chat (what, to whom, with what content); yes: `job approve ID`, no: `job skip ID` or `job stop ID`. Without an answer in 30 minutes the step is not sent and the job ends |
| `waiting`, `reason: "hands"` | no `--allow-input`; the background steps are done and the next needs the real mouse and keyboard | ask the user whether and for how long; yes: `job grant ID --for SECONDS` (`job grant --all --for SECONDS` for every waiting job) |
| `waiting`, `reason: "user"` | someone touched the mouse or keyboard and the job stepped aside | nothing: it goes on after 3 quiet seconds; it waits while the screen is locked |
| `failed` | failed; `error` has the step and the window or page | handle it as usual |
| `stopped` / `lost` | stopped / the host ended mid-way | read the current state first |

`job show ID` shows it at any time and `job list` lists recent jobs. A job that stops before a final step and has no
`job wait` on it within 15 seconds shows the user a notification that sends them back to the chat; when they return,
check `job list`.

## Fixing in place

`waiting.step` is the failed step, `waiting.error` why, `waiting.scene` the interface at that moment, and
`waiting.sent: true` means the step was sent or may have reached the application. Check the result before another action.
The job waits up to 10 minutes, then counts as failed. Waiting holds no
input. Read `waiting.scene`, then choose:

```bash
slipwing job retry ID --target "the name it has now"     # redo the step with another name
slipwing job retry ID --options '{"timeout": 15000}'     # a slow page: wait longer, then redo
slipwing job do ID --file patch.js                        # run a patch (close a dialog), then redo the step
slipwing job approve ID                                   # reason "approval": the user agreed in the chat
slipwing job skip ID --value '"what the step returns"'    # skip the step
slipwing job stop ID                                      # only when the user gives up: a stopped job cannot be fixed
```

An extra confirmation dialog ("Confirm order?"): `do` with a patch that clicks its Continue or OK.

A `waitText` or `waitFor` step that failed with `TIMEOUT` usually means a slow page: `job retry ID` and wait again. Do not
repeat the clicks before it in a patch; they may have been sent and not answered yet.

- `--options` go to the failed step as its options. `timeout` reaches every wait, also one given as a number such as
  `waitText("Saved", 2000)`; the longer of the retry's time and the script's own applies.
- `patch.js` is written like a `run` script. It sees `args`, `scene` (the same as `waiting.scene`) and the helpers
  (`web`, `desktop`, `visible`, `log`, `sleep`, `waitFor`, `expect`), not the original script's variables: put a value
  it needs into the patch itself. `job` commands take no `--allow-final` or `--allow-input`; a patch has what the job
  started with.
- `do` runs the patch, then tries the failed step again. When the step has `sent: true` it is not tried again (it would
  happen twice; `job retry` is refused with `STEP_ALREADY_SENT`): the patch's return value becomes the step's value.
- A patch that throws leaves the job waiting with `waiting.error.code: "PATCH_FAILED"` and the patch's error; the step
  was not tried again. Send another fix.
- After a fix, `job wait` again. A job that finally succeeds lists its fixes in `result.fixes`; for a routine, update its
  script and save it again with `--replace`. `job approve` and a skipped final step are not fixes: they are listed in
  `result.approvals` and need no new save.

## Looking back

`job report ID` writes a web page with every step; jobs with `--allow-input` or `--allow-final` include pictures before
and after each step.

## Jobs that need the mouse and keyboard

- A detached job runs without `--allow-input`: it does the background steps and stops at the first step that needs real
  input, with `reason: "hands"`.
- Put the background steps (reading, setting values, web) first and real-input steps last, so one question covers them.
- When someone touches the mouse or keyboard during a grant, the job steps aside at once; a step that was typing is
  stopped and becomes `reason: "fix"`, so read the interface before redoing or skipping it.
- Nothing is sent while the screen is locked; steps that need the hands wait until it is unlocked.
