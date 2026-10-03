export type Meter = {
  // Session total in USD, as /cost has it.
  total: number
  // What the most recent turn added.
  lastTurn: number
  // When the session began, in $.clock.now() milliseconds.
  startedAt: number
}

export type Motion = {
  // The session figure as drawn right now (counts up toward Meter.total).
  shown: number
}

export type Ci = 'pass' | 'fail' | 'running'

export type Git = {
  // The repo's folder name.
  repo: string
  branch: string
  // Local branches, most recently committed first (the picker's options).
  branches: string[]
  // Uncommitted files.
  dirty: number
  ahead: number
  behind: number
  hasUpstream: boolean
  // The newest GitHub Actions run on this branch; null when there is none.
  ci: Ci | null
  // A commit, push, pull or branch switch in flight.
  busy: 'commit' | 'push' | 'pull' | 'switch' | null
  // The first click on Push arms it; a second within a few seconds pushes.
  isPushArmed: boolean
  // The last push or pull's outcome, shown for a few seconds.
  note: { text: string; isError: boolean } | null
}

declare module 'claude-code' {
  interface PluginState {
    // `git` is null outside a git repository.
    'cost-meter': { meter: Meter; motion: Motion; isHidden: boolean; git: Git | null }
  }
}
