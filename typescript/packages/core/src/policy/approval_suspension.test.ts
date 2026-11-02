import { expect, it } from 'vitest'

import { Decisions } from './decisions.ts'
import {
  Outcome,
  Scope,
  type Ask,
  type Claimant,
  type CommandContext,
  type Decision,
  type Occurrence,
  type SessionDecisionsQuery,
} from './types.ts'

function deferred<T>() {
  let settle: (value: T) => void = () => {
    throw new Error('promise executor has not run')
  }
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return {
    promise,
    resolve: (value: T) => {
      settle(value)
    },
  }
}

class PausedSessions implements SessionDecisionsQuery {
  records: readonly Decision[] = []
  saving = [deferred<undefined>(), deferred<undefined>()] satisfies [unknown, unknown]
  resume = [deferred<undefined>(), deferred<undefined>()] satisfies [unknown, unknown]
  flushes = 0

  decisionSessions(): readonly string[] {
    return ['s']
  }

  decisionsOf(sessionId: string): readonly Decision[] {
    expect(sessionId).toBe('s')
    return this.records
  }

  setDecisions(sessionId: string, records: readonly Decision[]): void {
    expect(sessionId).toBe('s')
    this.records = records
  }

  flush(): Promise<void> {
    const index = this.flushes
    this.flushes += 1
    const saving = this.saving[index]
    const resume = this.resume[index]
    if (saving === undefined || resume === undefined) return Promise.resolve()
    saving.resolve(undefined)
    return resume.promise
  }
}

it('makes approval state visible at each suspension', async () => {
  const sessions = new PausedSessions()
  const prompting = deferred<undefined>()
  const answer = deferred<Decision>()
  const ledger = new Decisions(sessions, () => {
    prompting.resolve(undefined)
    return answer.promise
  })
  const ctx: CommandContext = {
    command: 'git',
    argv: ['push'],
    paths: [],
    cwd: '/repo',
    sessionId: 's',
  }
  const ask: Ask = {
    kind: 'ask',
    reason: 'first',
    rule: { reason: 'first', commands: ['git push'], paths: [], mount: '' },
  }
  const occurrence: Occurrence = { parent: null, source: 'git push', start: 0, end: 8 }
  const first: Claimant = { line: { claimed: [], parent: null, origin: null }, occurrence }
  const other: Claimant = { line: { claimed: [], parent: null, origin: null }, occurrence }
  const running = ledger.resolve(ctx, ask, undefined, first)
  const pendingSave = sessions.saving[0]
  const answerSave = sessions.saving[1]
  const continuePrompt = sessions.resume[0]
  const continueAnswer = sessions.resume[1]
  try {
    await pendingSave.promise
    expect(ledger.pending('s')).toHaveLength(1)
    const record = ledger.pending('s')[0]
    if (record === undefined) throw new Error('pending record was not published locally')
    const pending = await ledger.held(ctx, ask, other)
    expect(pending).toEqual({ kind: 'pending', id: record.id, reason: 'first' })
    expect(sessions.flushes).toBe(1)

    continuePrompt.resolve(undefined)
    await prompting.promise
    expect((await ledger.held(ctx, ask, other))?.kind).toBe('pending')
    expect(sessions.flushes).toBe(1)

    answer.resolve({ ...record, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    await answerSave.promise
    expect(await ledger.held(ctx, ask, first)).toBeNull()
    expect((await ledger.held(ctx, ask, other))?.kind).toBe('pending')
    expect(ledger.pending('s')).toEqual([])

    continueAnswer.resolve(undefined)
    expect(await running).toBeNull()
    await ledger.revoke('s', first.line)
    expect(ledger.list('s')).toEqual([])
    expect(sessions.flushes).toBe(3)
  } finally {
    for (const resume of sessions.resume) resume.resolve(undefined)
    const record = ledger.pending('s')[0]
    if (record !== undefined) answer.resolve({ ...record, outcome: Outcome.ALLOW })
    await running
  }
})
