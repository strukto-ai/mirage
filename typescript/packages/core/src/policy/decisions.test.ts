// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { describe, expect, it } from 'vitest'

import { Decisions, askRule, covers, decisionId } from './decisions.ts'
import { Outcome, Scope } from './types.ts'
import type { Ask, CommandContext, CommandRule, Decision } from './types.ts'

const RULE: CommandRule = { reason: 'sign-off', commands: ['git push'], paths: [], mount: '' }
const ASK: Ask = { kind: 'ask', reason: 'sign-off', rule: RULE }

function ctx(sessionId = 's', argv: readonly string[] = ['push']): CommandContext {
  return {
    command: 'git',
    argv,
    paths: [],
    operands: [],
    cwd: '/repo',
    sessionId,
    registry: { isMountRoot: () => false },
    tokens: ['git', ...argv],
  } as unknown as CommandContext
}

function record(over: Partial<Decision> = {}): Decision {
  return {
    id: 'd1',
    sessionId: 's',
    agentId: '',
    command: 'git',
    argv: ['push'],
    cwd: '/repo',
    paths: [],
    reason: 'sign-off',
    rule: RULE,
    outcome: null,
    scope: Scope.ONCE,
    note: '',
    ...over,
  }
}

describe('decisions', () => {
  it('names a record stably for the same line and session', async () => {
    const same = await decisionId('s', '/repo', ['git', 'push'])
    expect(same).toBe(await decisionId('s', '/repo', ['git', 'push']))
    expect(same).not.toBe(await decisionId('other', '/repo', ['git', 'push']))
    expect(same).not.toBe(await decisionId('s', '/elsewhere', ['git', 'push']))
    expect(same).toHaveLength(12)
  })

  it('synthesizes a rule over the program for a coded ask', () => {
    expect(askRule(ctx(), ASK)).toBe(RULE)
    const coded = askRule(ctx(), { kind: 'ask', reason: 'sign-off' })
    expect(coded.commands).toEqual(['git'])
    expect(coded.reason).toBe('sign-off')
  })

  it('reads scope in covers and never answers a waiting record', () => {
    const argv = ['git', 'push']
    expect(covers(record(), RULE, argv, '/repo')).toBe(false)
    const once = record({ outcome: Outcome.ALLOW, scope: Scope.ONCE })
    expect(covers(once, RULE, argv, '/repo')).toBe(true)
    // A ONCE answer is for the exact line, so a different line or a
    // different directory is not it.
    expect(covers(once, RULE, ['git', 'push', '-f'], '/repo')).toBe(false)
    expect(covers(once, RULE, argv, '/elsewhere')).toBe(false)
    // A SESSION answer covers any line the same rule asks about.
    const forever = record({ outcome: Outcome.ALLOW, scope: Scope.SESSION })
    expect(covers(forever, RULE, ['git', 'push', '-f'], '/elsewhere')).toBe(true)
    // An answer never answers a rule it was not given for: a persisted
    // record reopened under an edited profile must not speak for the
    // new rule.
    const other: CommandRule = { ...RULE, reason: 'different' }
    expect(covers(forever, other, argv, '/repo')).toBe(false)
  })

  it('records a question once and answers it once', async () => {
    const ledger = new Decisions()
    const first = await ledger.resolve(ctx(), ASK)
    expect(first?.kind).toBe('pending')
    // A retry reuses the record rather than filing a second one, so the
    // agent keeps quoting one id.
    const again = await ledger.resolve(ctx(), ASK)
    expect(again?.kind === 'pending' && again.id).toBe(first?.kind === 'pending' && first.id)
    expect(ledger.pending()).toHaveLength(1)
    const id = first?.kind === 'pending' ? first.id : ''
    await ledger.answer(id, Outcome.ALLOW, Scope.ONCE)
    expect(ledger.pending()).toEqual([])
    expect(ledger.list()).toHaveLength(1)
    expect(await ledger.resolve(ctx(), ASK)).toBeNull()
    // ONCE is consumed by the line it answered, so the next asks again.
    expect((await ledger.resolve(ctx(), ASK))?.kind).toBe('pending')
  })

  it('keeps a session answer and refuses on a deny', async () => {
    const ledger = new Decisions()
    const pending = await ledger.resolve(ctx(), ASK)
    await ledger.answer(pending?.kind === 'pending' ? pending.id : '', Outcome.ALLOW, Scope.SESSION)
    for (let i = 0; i < 3; i += 1) expect(await ledger.resolve(ctx(), ASK)).toBeNull()

    const refused = new Decisions()
    const asked = await refused.resolve(ctx(), ASK)
    await refused.answer(asked?.kind === 'pending' ? asked.id : '', Outcome.DENY)
    const action = await refused.resolve(ctx(), ASK)
    expect(action?.kind).toBe('deny')
    expect(action?.kind === 'deny' && action.reason).toBe('sign-off')
  })

  it('reads without recording or spending in held', async () => {
    const ledger = new Decisions()
    // Nothing is on file, so held reports waiting and files nothing.
    for (let i = 0; i < 3; i += 1) expect((await ledger.held(ctx(), ASK))?.kind).toBe('pending')
    expect(ledger.list()).toEqual([])
    const pending = await ledger.resolve(ctx(), ASK)
    await ledger.answer(pending?.kind === 'pending' ? pending.id : '', Outcome.ALLOW, Scope.ONCE)
    // Reading it does not spend it: the run that follows still passes.
    expect(await ledger.held(ctx(), ASK)).toBeNull()
    expect(await ledger.held(ctx(), ASK)).toBeNull()
    expect(await ledger.resolve(ctx(), ASK)).toBeNull()
  })

  it('rejects ASK as an answer and an unknown id', async () => {
    const ledger = new Decisions()
    const pending = await ledger.resolve(ctx(), ASK)
    const id = pending?.kind === 'pending' ? pending.id : ''
    await expect(ledger.answer(id, Outcome.ASK)).rejects.toThrow(/not an answer/)
    await expect(ledger.answer('nosuchid', Outcome.ALLOW)).rejects.toThrow(/no decision waiting/)
    // Answering twice is answering an id nothing is waiting on.
    await ledger.answer(id, Outcome.ALLOW)
    await expect(ledger.answer(id, Outcome.DENY)).rejects.toThrow(/no decision waiting/)
  })

  it('leaves nothing waiting when a host answers inside the line', async () => {
    const allow = (r: Decision): Promise<Decision> =>
      Promise.resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.SESSION })
    const ledger = new Decisions(null, allow)
    expect(await ledger.resolve(ctx(), ASK)).toBeNull()
    expect(ledger.pending()).toEqual([])
    expect(ledger.list()).toHaveLength(1)

    const waiting = new Decisions(null, () => Promise.resolve(null))
    expect((await waiting.resolve(ctx(), ASK))?.kind).toBe('pending')
    expect(waiting.pending()).toHaveLength(1)
  })

  it('spends an inline answer on the line that asked, not the next one', async () => {
    // The host answers while the line waits, so the answer belongs to that
    // line. Allowing once must not let the next identical line through with
    // nobody asked. A refusal still covers the immediate retry.
    let asked = 0
    const allow = (r: Decision): Promise<Decision> => {
      asked += 1
      return Promise.resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    }
    const ledger = new Decisions(null, allow)
    expect(await ledger.resolve(ctx(), ASK)).toBeNull()
    expect(await ledger.resolve(ctx(), ASK)).toBeNull()
    expect(asked).toBe(2)

    let refusals = 0
    const deny = (r: Decision): Promise<Decision> => {
      refusals += 1
      return Promise.resolve({ ...r, outcome: Outcome.DENY, scope: Scope.ONCE })
    }
    const refused = new Decisions(null, deny)
    for (const expected of [1, 1, 2]) {
      expect((await refused.resolve(ctx(), ASK))?.kind).toBe('deny')
      expect(refusals).toBe(expected)
    }

    // A SESSION answer still stands for the rest of the session.
    const forever = new Decisions(null, (r: Decision) =>
      Promise.resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.SESSION }),
    )
    for (let i = 0; i < 3; i += 1) expect(await forever.resolve(ctx(), ASK)).toBeNull()
  })

  it('hands the run signal to the host, so a prompt can be taken down', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const controller = new AbortController()
    const ledger = new Decisions(null, (r, signal) => {
      seen.push(signal)
      return Promise.resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    })
    expect(await ledger.resolve(ctx(), ASK, controller.signal)).toBeNull()
    expect(seen).toEqual([controller.signal])
  })

  it('stops waiting on a host when the run it belongs to is killed', async () => {
    const controller = new AbortController()
    const ledger = new Decisions(
      null,
      () =>
        new Promise(() => {
          // A host that never answers: without the bound below, the run
          // waiting on this would outlive its own deadline entirely.
        }),
    )
    const asked = ledger.resolve(ctx(), ASK, controller.signal)
    controller.abort()
    expect(await asked).toEqual({ kind: 'abandoned' })
    // Nobody answered, so the question is still open for whoever asks next.
    expect(ledger.pending()).toHaveLength(1)
  })

  it('puts nothing to a host on behalf of a run already over', async () => {
    const controller = new AbortController()
    controller.abort()
    let asked = false
    const ledger = new Decisions(null, () => {
      asked = true
      return Promise.resolve(null)
    })
    expect(await ledger.resolve(ctx(), ASK, controller.signal)).toEqual({ kind: 'abandoned' })
    expect(asked).toBe(false)
    expect(ledger.pending()).toHaveLength(1)
  })

  it('drops an answer that arrives after the kill instead of recording it', async () => {
    const controller = new AbortController()
    const host: { yes?: () => void } = {}
    const ledger = new Decisions(
      null,
      (r) =>
        new Promise<Decision>((resolve) => {
          host.yes = () => {
            resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.ONCE })
          }
        }),
    )
    const asked = ledger.resolve(ctx(), ASK, controller.signal)
    controller.abort()
    expect(await asked).toEqual({ kind: 'abandoned' })
    host.yes?.()
    await Promise.resolve()
    // Recording it would leave a spent-once grant behind, and the next
    // identical line would take it without anybody being asked.
    expect(ledger.pending()).toHaveLength(1)
    expect(ledger.list()[0]?.outcome).toBeNull()
  })

  it('swallows a host rejection that arrives after the kill', async () => {
    const controller = new AbortController()
    const host: { fail?: () => void } = {}
    const ledger = new Decisions(
      null,
      () =>
        new Promise<Decision>((_resolve, reject) => {
          host.fail = () => {
            reject(new Error('the approval channel fell over'))
          }
        }),
    )
    const asked = ledger.resolve(ctx(), ASK, controller.signal)
    controller.abort()
    expect(await asked).toEqual({ kind: 'abandoned' })
    // Left unhandled this would surface as an unhandled rejection and
    // take the host process down with it.
    host.fail?.()
    await Promise.resolve()
    expect(ledger.pending()).toHaveLength(1)
  })

  it('lists records per session and across them', async () => {
    const ledger = new Decisions()
    await ledger.resolve(ctx('a'), ASK)
    await ledger.resolve(ctx('b'), ASK)
    expect(ledger.list()).toHaveLength(2)
    expect(ledger.list('a')).toHaveLength(1)
    expect(ledger.list('a')[0]?.sessionId).toBe('a')
    expect(ledger.list('nobody')).toEqual([])
  })
})
