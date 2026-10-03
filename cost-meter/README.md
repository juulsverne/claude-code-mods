# Cost meter band

A Claude Code mod: a band above the prompt. The left side shows what the session costs. The right side shows git and CI for the repo you're in.

```
 Session $4.12 · Last message $0.38        ai-playground ⎇ [main ▾] ●3 ↑2 ↓0  ✅ CI  [Pull] [Push 2]
```

## Left side: cost

- **Session**: the session's total cost. It counts up over about a second after each turn.
- **Last message**: what the most recent turn cost.
- Labels are dim and figures are bold. There's no emoji.

## Right side: git

- **Repo and branch**: the repo's folder name, then the branch as a picker (`⎇ [main ▾]`). Picking a branch runs `git switch`. The list holds your 15 most recently committed local branches. On a surface with no picker element (VS Code, mobile), the branch is plain text.
- **Status**: `●N` uncommitted files, and `↑ahead ↓behind` the upstream.
- **CI**: the newest GitHub Actions run on the branch, ✅ ❌ 🟡, via `gh`. It's hidden when there's none.
- **Pull**: runs `git pull --ff-only`.
- **Push**: takes two clicks within 5 s. It runs `git push`, with `-u origin <branch>` when there's no upstream.
- **Commit & push**: whenever there are uncommitted files, Push commits them before it pushes, so nothing is left behind. The button reads `Commit & push` (or `Commit & push 3` when commits are already waiting). The second click stages everything (`git add -A`), commits with a one-line message Haiku writes from the diff (falling back to `Update N files`), then pushes. If the commit fails (a pre-commit hook, say), it shows git's error and doesn't push.
- **Results**: the outcome of a pull, push or switch shows inline for 8 s.
- **Refreshing**: on session start, after every turn and after each action, plus a quiet `git fetch` every 5 minutes. Outside a git repo the whole right side hides.

It's on by default. `/meter` hides or shows it. There are no toasts or alerts. The CI badges and timings are at the top of `hooks/register.tsx`.

## How it works

The cost is the engine's own `/cost` figure. A `session.measure` hook fires after each turn, reads `cost.usd` and stores `{ total, lastTurn, startedAt }` in `$.state`. Git state is read with `$.process.run` (git and gh, in the session's directory) into a `git` state value. The `AbovePrompt` render hook only reads state and draws. A `$.clock.every` timer runs the count-up while the session figure is moving, and another runs the 5-minute fetch.

## Launch

Install it from the marketplace this repo provides:

```
/plugin marketplace add juulsverne/claude-code-mods
/plugin install cost-meter@playground-mods
```

Or try it in one session from a clone:

```bash
claude --plugin-dir cost-meter
```

## Checks

- `claude plugin validate claude-code-mods/cost-meter`: passes with no warnings.
- `tsc` against Claude Code 2.1.286's plugin types: the hooks module is clean; the test file has fixture typing errors (the `BAND` props), which don't affect running the tests.
- `claude plugin test claude-code-mods/cost-meter`: 10 tests pass on the terminal and desktop surfaces. They cover:
  - a fresh session reading `Session $0.00 · Last message $0.00` with no emoji
  - the session figure counting up after turns, and last message tracking the latest turn
  - the git side's repo, branch picker, changes, ahead/behind and CI
  - Push needing two clicks (and disarming after 5 s), and Pull
  - Commit & push staging, committing and pushing in order, with or without commits already ahead, and a failed commit not pushing
  - picking a branch running `git switch`
  - the git side hiding outside a repo
  - no hover detail line

## Known limitations

- The plugin API is early access and may change between Claude Code releases.
- The cost is the engine's API-equivalent estimate. On a subscription, that isn't what you actually pay.
- The tests use a fake git and gh. Real pushes, pulls and switches haven't been clicked yet.
- `git switch` refuses when uncommitted changes would be overwritten. The band shows git's error and stays put; it never stashes.
- Emoji widths vary by terminal font, so the row may shift by a cell in some terminals.
- The tests check the tree the mod returns, not the pixels a surface paints.
