import { expect, mock, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } } as const
const SURFACES = ['terminal', 'desktop'] as const

async function measure($: any, usd: number) {
  await $.session.measure({ context: {}, rateLimits: [], cost: { usd }, changed: ['cost'] })
}

// The texts of every Text drawn, in order, joined: what the row reads as.
async function rowText(ui: any) {
  const texts: string[] = []
  const walk = (node: any) => {
    if (typeof node === 'string') texts.push(node)
    else for (const child of node?.children ?? []) walk(child)
  }
  walk(await ui.drawn())
  return texts.join(' ').replace(/\s+/g, ' ')
}

test('a fresh session reads "Session $0.00 · Last message $0.00", no emoji', async ($, on) => {
  mock.clock(on, { now: 60_000 })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'cost-meter', surface, ...BAND })
    const row = await rowText(ui)
    expect(row).toContain('Session $0.00 · Last message $0.00')
    expect(row).not.toMatch(/🛴|🚕|ᴥ|▲|\/hr|latte/)
    await ui.unmount()
  }
})

test('after turns the session total counts up and last message is the latest turn', async ($, on) => {
  const clock = mock.clock(on, { now: 3_600_000 })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await measure($, 22.5)
  await clock.advance(1200)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'cost-meter', surface, ...BAND })
    expect(await rowText(ui)).toContain('Session $22.50 · Last message $22.50')
    await ui.unmount()
  }

  await measure($, 22.6)
  await clock.advance(400)
  const mid = await $.ui.mount({ plugin: 'cost-meter', surface: 'terminal', ...BAND })
  expect(await rowText(mid)).toContain('Last message $0.10')
  await mid.unmount()

  await clock.advance(1200)
  const ui = await $.ui.mount({ plugin: 'cost-meter', surface: 'terminal', ...BAND })
  expect(await rowText(ui)).toContain('Session $22.60 · Last message $0.10')
  await ui.unmount()
})

// A fake repo beneath the plugin: answers git and gh by argv, records what ran.
function fakeRepo(
  on: any,
  ran: string[],
  opts: { ahead?: number; isRepo?: boolean; isClean?: boolean; commitFails?: boolean } = {},
) {
  on('process.run', (_$: any, e: any) => {
    const cmd = e.argv.join(' ')
    ran.push(cmd)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false } })
    if (opts.isRepo === false) return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false } }
    if (cmd === 'git rev-parse --show-toplevel') return ok('D:/ai-playground\n')
    if (cmd === 'git branch --show-current') return ok('main\n')
    if (cmd === 'git status --porcelain') return ok(opts.isClean ? '' : ' M a.txt\n?? b.txt\n')
    if (cmd.startsWith('git rev-list')) return ok(`1\t${opts.ahead ?? 2}\n`)
    if (cmd.startsWith('git for-each-ref')) return ok('main\nfeature/cats\n')
    if (opts.commitFails && cmd.startsWith('git commit')) {
      return { value: { exitCode: 1, stdout: '', stderr: 'pre-commit hook failed', isStdoutTruncated: false } }
    }
    if (cmd.startsWith('gh run list')) return ok('[{"status":"completed","conclusion":"failure"}]')
    return ok('')
  })
  on('turn.complete', () => ({ text: '' }))
}

const endTurn = ($: any) =>
  $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' })

test('the right side shows repo, branch, changes, ahead/behind and CI', async ($, on) => {
  mock.clock(on, { now: 60_000 })
  const ran: string[] = []
  fakeRepo(on, ran)
  await endTurn($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'cost-meter', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /ai-playground/ })).toBeDefined()
    expect(await ui.find({ key: 'git-branch' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /●2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↑2 ↓1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /❌ CI/ })).toBeDefined()
    expect(await ui.find({ key: 'git-pull' })).toBeDefined()
    expect(await ui.find({ key: 'git-push' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /🐈/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('push takes two presses; pull takes one', async ($, on) => {
  const clock = mock.clock(on, { now: 60_000 })
  const ran: string[] = []
  fakeRepo(on, ran, { isClean: true })
  await endTurn($)

  const ui = await $.ui.mount({ plugin: 'cost-meter', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'git-push', text: /^Push 2$/ } as never)).toBeDefined()
  await ui.press({ key: 'git-push' })
  expect(ran).not.toContain('git push')
  expect(await ui.find({ key: 'git-push', text: /Push 2 commits\? ✓/ } as never)).toBeDefined()

  // Left armed too long, it disarms.
  await clock.advance(6000)
  await ui.press({ key: 'git-push' })
  expect(ran).not.toContain('git push')
  await ui.press({ key: 'git-push' })
  expect(ran).toContain('git push')
  expect(ran).not.toContain('git add -A')
  expect(await ui.find({ type: 'Text', text: /pushed ✓/ })).toBeDefined()

  await ui.press({ key: 'git-pull' })
  expect(ran).toContain('git pull --ff-only')
  await ui.unmount()
})

test('with nothing to push but uncommitted files, push commits them first', async ($, on) => {
  mock.clock(on, { now: 60_000 })
  const ran: string[] = []
  fakeRepo(on, ran, { ahead: 0 })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Add b.txt and tweak a.txt\n', usage: {} } }))
  await endTurn($)

  const ui = await $.ui.mount({ plugin: 'cost-meter', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'git-push', text: /Commit & push/ } as never)).toBeDefined()
  await ui.press({ key: 'git-push' })
  expect(await ui.find({ key: 'git-push', text: /Commit 2 files & push\? ✓/ } as never)).toBeDefined()
  expect(ran).not.toContain('git add -A')

  await ui.press({ key: 'git-push' })
  const add = ran.indexOf('git add -A')
  const commit = ran.indexOf('git commit -m Add b.txt and tweak a.txt')
  const push = ran.indexOf('git push')
  expect(add).toBeGreaterThan(-1)
  expect(commit).toBeGreaterThan(add)
  expect(push).toBeGreaterThan(commit)
  await ui.unmount()
})

test('with commits ahead and uncommitted files, push commits them too', async ($, on) => {
  mock.clock(on, { now: 60_000 })
  const ran: string[] = []
  fakeRepo(on, ran, { ahead: 2 })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Tweak a.txt', usage: {} } }))
  await endTurn($)

  const ui = await $.ui.mount({ plugin: 'cost-meter', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'git-push', text: /Commit & push 3/ } as never)).toBeDefined()
  await ui.press({ key: 'git-push' })
  expect(await ui.find({ key: 'git-push', text: /Commit 2 files & push 3 commits\? ✓/ } as never)).toBeDefined()
  await ui.press({ key: 'git-push' })
  const commit = ran.indexOf('git commit -m Tweak a.txt')
  expect(ran.indexOf('git add -A')).toBeGreaterThan(-1)
  expect(commit).toBeGreaterThan(ran.indexOf('git add -A'))
  expect(ran.indexOf('git push')).toBeGreaterThan(commit)
  await ui.unmount()
})

test('a failed commit does not push', async ($, on) => {
  mock.clock(on, { now: 60_000 })
  const ran: string[] = []
  fakeRepo(on, ran, { ahead: 0, commitFails: true })
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } }))
  await endTurn($)

  const ui = await $.ui.mount({ plugin: 'cost-meter', surface: 'terminal', ...BAND })
  await ui.press({ key: 'git-push' })
  await ui.press({ key: 'git-push' })
  // With no model reply, the message falls back to a plain one.
  expect(ran).toContain('git commit -m Update 2 files')
  expect(ran).not.toContain('git push')
  expect(await ui.find({ type: 'Text', text: /pre-commit hook failed/ })).toBeDefined()
  await ui.unmount()
})

test('outside a git repo the right side hides', async ($, on) => {
  mock.clock(on, { now: 60_000 })
  fakeRepo(on, [], { isRepo: false })
  await endTurn($)
  const ui = await $.ui.mount({ plugin: 'cost-meter', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'git-push' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /\$0\.00/ })).toBeDefined()
  await ui.unmount()
})

test('picking a branch in the picker switches to it', async ($, on) => {
  mock.clock(on, { now: 60_000 })
  const ran: string[] = []
  fakeRepo(on, ran)
  await endTurn($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'cost-meter', surface, ...BAND })
    await ui.select({ key: 'git-branch', value: 'feature/cats' })
    expect(ran).toContain('git switch feature/cats')
    expect(await ui.find({ type: 'Text', text: /on feature\/cats ✓/ })).toBeDefined()
    await ui.unmount()
  }
})

test('there is no hover detail line', async ($, on) => {
  mock.clock(on, { now: 60_000 })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'cost-meter', surface, ...BAND })
    expect(await ui.find({ key: 'cost-meter-detail' } as never)).toBeUndefined()
    expect(await rowText(ui)).not.toMatch(/\$\d+\.\d{4}|started/)
    await ui.unmount()
  }
})
