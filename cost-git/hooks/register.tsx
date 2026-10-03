import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ci, Git, Meter, Motion } from '../types'

// ── Tune these ──────────────────────────────────────────────────────────────

const CI_BADGES: Record<Ci, { icon: string; color: string }> = {
  pass: { icon: '✅', color: '#4ADE80' },
  fail: { icon: '❌', color: '#F87171' },
  running: { icon: '🟡', color: '#FDE047' },
}

const COUNT_UP_MS = 900
const FRAME_MS = 40
const FETCH_EVERY_MS = 5 * 60_000
const PUSH_ARM_MS = 5000
const NOTE_MS = 8000

// ── State ───────────────────────────────────────────────────────────────────

const meter = atom({ plugin: 'cost-git', key: 'meter' } as const, {
  total: 0,
  lastTurn: 0,
  startedAt: 0,
})
const motion = atom({ plugin: 'cost-git', key: 'motion' } as const, { shown: 0 })
const isHidden = atom({ plugin: 'cost-git', key: 'isHidden' } as const, false)
const git = atom({ plugin: 'cost-git', key: 'git' } as const, null)

const money = (usd: number) => `$${usd.toFixed(2)}`


const firstLine = (text: string) => text.trim().split(/\r?\n/).find(Boolean) ?? ''

// ── Git ─────────────────────────────────────────────────────────────────────

// Runs one command in the session's directory; never throws.
async function sh($: EngineInterface, argv: string[], timeoutMs = 15_000) {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: String(error) }
  }
}

// The newest GitHub Actions run on the branch, or null if gh can't say.
async function ciFor($: EngineInterface, branch: string): Promise<Ci | null> {
  const run = await sh($, ['gh', 'run', 'list', '--branch', branch, '--limit', '1', '--json', 'status,conclusion'], 10_000)
  if (run.exitCode !== 0) return null
  try {
    const [latest] = JSON.parse(run.stdout) as { status: string; conclusion: string }[]
    if (!latest) return null
    if (latest.status !== 'completed') return 'running'
    return latest.conclusion === 'success' ? 'pass' : 'fail'
  } catch {
    return null
  }
}

// Reads the repo, branch, dirty count, ahead/behind and CI into state.
async function refreshGit($: EngineInterface) {
  const top = await sh($, ['git', 'rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) {
    await update($, git, () => null)
    return
  }
  const repo = top.stdout.trim().split(/[\\/]/).pop() ?? 'repo'

  let branch = (await sh($, ['git', 'branch', '--show-current'])).stdout.trim()
  if (!branch) {
    branch = `@${(await sh($, ['git', 'rev-parse', '--short', 'HEAD'])).stdout.trim()}`
  }
  const status = await sh($, ['git', 'status', '--porcelain'])
  const dirty = status.stdout.split(/\r?\n/).filter(Boolean).length

  const counts = await sh($, ['git', 'rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
  const hasUpstream = counts.exitCode === 0
  const [behind = 0, ahead = 0] = hasUpstream ? counts.stdout.trim().split(/\s+/).map(Number) : []

  const refs = await sh($, ['git', 'for-each-ref', '--sort=-committerdate', '--count=15', '--format=%(refname:short)', 'refs/heads'])
  const branches = refs.stdout.split(/\r?\n/).map(b => b.trim()).filter(Boolean)
  if (!branches.includes(branch)) branches.unshift(branch)

  const ci = branch.startsWith('@') ? null : await ciFor($, branch)

  await update($, git, was => ({
    repo,
    branch,
    branches,
    dirty,
    ahead,
    behind,
    hasUpstream,
    ci,
    busy: was?.busy ?? null,
    isPushArmed: was?.isPushArmed ?? false,
    note: was?.note ?? null,
  }))
}

async function fetchQuietly($: EngineInterface) {
  await sh($, ['git', 'fetch', '--quiet'], 30_000)
  await refreshGit($)
}

function showNote($: EngineInterface, text: string, isError: boolean) {
  void update($, git, g => (g ? { ...g, note: { text, isError } } : g))
  $.clock.after(NOTE_MS, () => {
    void update($, git, g => (g?.note?.text === text ? { ...g, note: null } : g))
  })
}

async function pull($: EngineInterface) {
  const g = await read($, git)
  if (!g || g.busy) return
  await update($, git, s => (s ? { ...s, busy: 'pull' as const, note: null } : s))
  const run = await sh($, ['git', 'pull', '--ff-only'], 120_000)
  await update($, git, s => (s ? { ...s, busy: null } : s))
  showNote($, run.exitCode === 0 ? 'pulled ✓' : firstLine(run.stderr || run.stdout), run.exitCode !== 0)
  await refreshGit($)
}

// Uncommitted files: Push commits them first, so nothing is left behind.
const commitsFirst = (g: Git) => g.dirty > 0

// A one-line commit message from the staged diff, or a plain fallback.
async function commitMessage($: EngineInterface, files: number) {
  const fallback = `Update ${files} file${files === 1 ? '' : 's'}`
  const stat = (await sh($, ['git', 'diff', '--cached', '--stat'])).stdout
  const diff = (await sh($, ['git', 'diff', '--cached'])).stdout.slice(0, 12_000)
  const r = await $.model.complete({
    model: 'haiku',
    timeoutMs: 15_000,
    prompt:
      'Write a git commit subject line (imperative, under 65 characters, no quotes, no trailing period) for this change. Reply with the line only.\n\n' +
      `${stat}\n${diff}`,
  })
  const line = r.isAnswered ? firstLine(r.text).replace(/^["'`]|["'`]$/g, '') : ''
  return line || fallback
}

// Stages everything and commits; returns the error line, or null on success.
async function commitAll($: EngineInterface, files: number) {
  const add = await sh($, ['git', 'add', '-A'], 60_000)
  if (add.exitCode !== 0) return firstLine(add.stderr || add.stdout)
  const message = await commitMessage($, files)
  const commit = await sh($, ['git', 'commit', '-m', message], 60_000)
  return commit.exitCode === 0 ? null : firstLine(commit.stderr || commit.stdout)
}

// First press arms it; a second press within PUSH_ARM_MS pushes.
async function push($: EngineInterface) {
  const g = await read($, git)
  if (!g || g.busy) return
  if (!g.isPushArmed) {
    await update($, git, s => (s ? { ...s, isPushArmed: true, note: null } : s))
    $.clock.after(PUSH_ARM_MS, () => {
      void update($, git, s => (s && s.isPushArmed && !s.busy ? { ...s, isPushArmed: false } : s))
    })
    return
  }
  if (commitsFirst(g)) {
    await update($, git, s => (s ? { ...s, busy: 'commit' as const, isPushArmed: false } : s))
    const error = await commitAll($, g.dirty)
    if (error) {
      await update($, git, s => (s ? { ...s, busy: null } : s))
      showNote($, error, true)
      await refreshGit($)
      return
    }
  }
  await update($, git, s => (s ? { ...s, busy: 'push' as const, isPushArmed: false } : s))
  const argv = g.hasUpstream ? ['git', 'push'] : ['git', 'push', '-u', 'origin', g.branch]
  const run = await sh($, argv, 120_000)
  await update($, git, s => (s ? { ...s, busy: null } : s))
  showNote($, run.exitCode === 0 ? 'pushed ✓' : firstLine(run.stderr || run.stdout), run.exitCode !== 0)
  await refreshGit($)
}

async function switchTo($: EngineInterface, target: string) {
  const g = await read($, git)
  if (!g || g.busy || target === g.branch) return
  await update($, git, s => (s ? { ...s, busy: 'switch' as const, isPushArmed: false, note: null } : s))
  const run = await sh($, ['git', 'switch', target], 60_000)
  await update($, git, s => (s ? { ...s, busy: null } : s))
  showNote($, run.exitCode === 0 ? `on ${target} ✓` : firstLine(run.stderr || run.stdout), run.exitCode !== 0)
  await refreshGit($)
}

// ── The fare's count-up ─────────────────────────────────────────────────────

let countUp: { cancel: () => void } | null = null

// Counts the session figure from where it is up to `to`.
async function animateTo($: EngineInterface, to: number) {
  countUp?.cancel()
  const from = (await read($, motion)).shown
  const startedAt = await $.clock.now()

  countUp = $.clock.every(FRAME_MS, () => {
    void $.clock.now().then(now => {
      const t = Math.min(1, (now - startedAt) / COUNT_UP_MS)
      const eased = 1 - (1 - t) ** 3
      const isDone = t >= 1
      if (isDone) {
        countUp?.cancel()
        countUp = null
      }
      void update($, motion, () => ({ shown: isDone ? to : from + (to - from) * eased }))
    })
  })
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'meter',
      description: 'Show or hide the cost-git band',
    })

    // A reload keeps $.state, so only seed what the host can tell us now.
    const usage = await $.session.usage()
    const total = usage.cost?.usd ?? 0
    await update($, meter, m => ({ ...m, total, startedAt: usage.startedAt }))
    await update($, motion, () => ({ shown: total }))

    void refreshGit($)
    $.clock.every(FETCH_EVERY_MS, () => void fetchQuietly($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.cost && e.changed.includes('cost')) {
      const before = await read($, meter)
      const total = e.cost.usd
      const lastTurn = Math.max(0, total - before.total)
      await update($, meter, m => ({ ...m, total, lastTurn }))
      void animateTo($, total)
    }

    return next(e)
  })

  // A turn may have committed, switched branch or edited files.
  on('turn.complete', ($, e, next) => {
    void refreshGit($)
    return next(e)
  })

  on('command.run', { command: 'meter' }, async $ => {
    const hidden = await update($, isHidden, was => !was)

    return { text: hidden ? 'cost-git band hidden. /meter brings it back.' : 'cost-git band on.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) {
      return next(e)
    }

    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // Select is on the terminal and desktop; elsewhere the branch is plain text.
    const Select = 'Select' in els ? els.Select : null
    const m: Meter = await read($, meter)
    const v: Motion = await read($, motion)
    const g: Git | null = await read($, git)

    const gitSide = g && (
      <Box flexDirection="row" gap={1}>
        <Text color="#A78BFA" bold>
          {g.repo}
        </Text>
        {g.busy === 'switch' || !Select ? (
          <Text color="#60A5FA">{g.busy === 'switch' ? '⎇ switching…' : `⎇ ${g.branch}`}</Text>
        ) : (
          <Select
            key="git-branch"
            label="⎇"
            options={g.branches.map(b => ({ value: b }))}
            value={g.branch}
            onSelect={(target: string) => void switchTo($, target)}
          />
        )}
        {g.dirty > 0 && <Text color="#FB923C">{`●${g.dirty}`}</Text>}
        {g.hasUpstream ? (
          <Text dimColor={g.ahead === 0 && g.behind === 0}>{`↑${g.ahead} ↓${g.behind}`}</Text>
        ) : (
          <Text dimColor>no upstream</Text>
        )}
        {g.ci && <Text color={CI_BADGES[g.ci].color}>{`${CI_BADGES[g.ci].icon} CI`}</Text>}
        {g.note && <Text color={g.note.isError ? '#F87171' : '#4ADE80'}>{g.note.text}</Text>}
        <Button
          key="git-pull"
          label={g.busy === 'pull' ? 'Pulling…' : g.behind > 0 ? `Pull ${g.behind}` : 'Pull'}
          dimColor={g.behind === 0}
          onPress={() => pull($)}
        />
        <Button
          key="git-push"
          label={
            g.busy === 'commit'
              ? 'Committing…'
              : g.busy === 'push'
                ? 'Pushing…'
                : commitsFirst(g)
                  ? g.isPushArmed
                    ? `Commit ${g.dirty} file${g.dirty === 1 ? '' : 's'} & push${g.ahead > 0 ? ` ${g.ahead + 1} commits` : ''}? ✓`
                    : g.ahead > 0
                      ? `Commit & push ${g.ahead + 1}`
                      : 'Commit & push'
                  : g.isPushArmed
                    ? `Push ${g.ahead} commit${g.ahead === 1 ? '' : 's'}? ✓`
                    : g.ahead > 0
                      ? `Push ${g.ahead}`
                      : 'Push'
          }
          variant={g.isPushArmed ? 'primary' : undefined}
          dimColor={!g.isPushArmed && g.ahead === 0 && g.dirty === 0 && g.hasUpstream}
          onPress={() => push($)}
        />
      </Box>
    )

    return (
      <Box key="cost-git" flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={3}>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>Session</Text>
            <Text bold>{money(v.shown)}</Text>
            <Text dimColor>·</Text>
            <Text dimColor>Last message</Text>
            <Text bold>{money(m.lastTurn)}</Text>
          </Box>
          {gitSide}
        </Box>
      </Box>
    )
  })
}
