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

import { Decisions, askRule, covers, decisionId, encloses } from './decisions.ts'
import { Outcome, Scope } from './types.ts'
import type {
  Ask,
  Claimant,
  CommandContext,
  CommandRule,
  Decision,
  HandOff,
  Occurrence,
  SessionDecisionsQuery,
} from './types.ts'

const RULE: CommandRule = { reason: 'sign-off', commands: ['git push'], paths: [], mount: '' }
const ASK: Ask = { kind: 'ask', reason: 'sign-off', rule: RULE }

/** A fresh line's hand-off. */
function fresh(parent: HandOff | null = null): HandOff {
  return { claimed: [], parent, origin: null }
}

/** The reader for one spelling of a command on a line, each its own occurrence. */
function at(handed: HandOff, index = 0): Claimant {
  const occurrence: Occurrence = { parent: null, source: 'line', start: index, end: index + 1 }
  return { line: handed, occurrence }
}

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

  it('spends an inline grant on the line that asked, not the next one', async () => {
    // The host answers while the line waits, so the grant belongs to that
    // line: allowing once must not let the next identical line through with
    // nobody asked.
    let asked = 0
    const allow = (r: Decision): Promise<Decision> => {
      asked += 1
      return Promise.resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    }
    const ledger = new Decisions(null, allow)
    expect(await ledger.resolve(ctx(), ASK)).toBeNull()
    expect(await ledger.resolve(ctx(), ASK)).toBeNull()
    expect(asked).toBe(2)

    // A refusal is the other way round, by design: the human who said no is
    // not asked about the agent's immediate retry. The record stands to
    // refuse that retry, is spent by it, and the run after is a new question.
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

  it('spends nothing on a hand-off, so the pass that follows finds every grant', async () => {
    // The pass that judges a line on the gate's behalf asks and leaves the
    // answer standing; the gate runs the line on it and the line's end
    // spends it. One question per run, and a grant already on file when
    // the hand-off began is left exactly as untouched as the one the host
    // gives during it.
    let asked = 0
    const allow = (r: Decision): Promise<Decision> => {
      asked += 1
      return Promise.resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    }
    const ledger = new Decisions(null, allow)
    const first: HandOff = fresh()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(first))).toBeNull()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(first))).toBeNull()
    expect(asked).toBe(1)
    // Claimed by a live line, the grant is not on offer off the line.
    expect(await ledger.resolve(ctx(), ASK)).toBeNull()
    expect(asked).toBe(2)
    await ledger.revoke('s', first)
    expect(ledger.list('s')).toEqual([])

    const other: CommandRule = {
      reason: 'twice over',
      commands: ['git push'],
      paths: [],
      mount: '',
    }
    const both: Ask = { kind: 'ask', reason: 'sign-off', rules: [RULE, other] }
    // The first rule is granted to a line that was then held, which
    // releases its claim; the second during this line's own pass.
    const earlier: HandOff = fresh()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(earlier))).toBeNull()
    ledger.release('s', earlier)
    const line: HandOff = fresh()
    expect(await ledger.resolve(ctx(), both, undefined, at(line))).toBeNull()
    expect(asked).toBe(4)
    // The gate finds both standing and asks nothing; the line's end
    // spends them.
    expect(await ledger.resolve(ctx(), both, undefined, at(line))).toBeNull()
    expect(asked).toBe(4)
    expect(ledger.list('s')).toHaveLength(2)
    await ledger.revoke('s', line)
    expect(ledger.list('s')).toEqual([])
  })

  it('asks again once a hand-off is revoked', async () => {
    // A grant handed off to a line that was then refused is handed back,
    // and the next identical line is a question again.
    let asked = 0
    const allow = (r: Decision): Promise<Decision> => {
      asked += 1
      return Promise.resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    }
    const ledger = new Decisions(null, allow)
    const handed: HandOff = fresh()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(handed))).toBeNull()
    expect(ledger.list('s')).toHaveLength(1)
    expect(handed.claimed.map((c) => c.decision)).toEqual(ledger.list('s'))
    await ledger.revoke('s', handed)
    expect(ledger.list('s')).toEqual([])
    expect(handed.claimed).toEqual([])
    expect(await ledger.resolve(ctx(), ASK)).toBeNull()
    expect(asked).toBe(2)
  })

  it('claims a grant for one occurrence of a command on a hand-off', async () => {
    // A command spelled twice on one line is two questions: the grant the
    // first spelling claimed is not standing for the second, and the
    // line's end spends one per spelling.
    let asked = 0
    const allow = (r: Decision): Promise<Decision> => {
      asked += 1
      return Promise.resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    }
    const ledger = new Decisions(null, allow)
    const handed: HandOff = fresh()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(handed, 0))).toBeNull()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(handed, 1))).toBeNull()
    expect(asked).toBe(2)
    expect(handed.claimed).toHaveLength(2)
    expect(ledger.list('s')).toHaveLength(2)
    // The pass reading either spelling again finds it answered.
    expect(await ledger.resolve(ctx(), ASK, undefined, at(handed, 1))).toBeNull()
    expect(asked).toBe(2)
    expect(await ledger.resolve(ctx(), ASK, undefined, at(handed, 0))).toBeNull()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(handed, 1))).toBeNull()
    expect(asked).toBe(2)
    expect(ledger.list('s')).toHaveLength(2)
    await ledger.revoke('s', handed)
    expect(ledger.list('s')).toEqual([])
  })

  it('offers a claim to its occurrence alone', async () => {
    // A grant the pass claimed for one spelling is not on offer to
    // another spelling of the same command on the same line, whether a
    // pass or a gate reads it: a word that expands at run time into the
    // command cannot run on the nod a literal spelling was given.
    const ledger = new Decisions()
    const waiting = await ledger.resolve(ctx(), ASK)
    expect(waiting?.kind).toBe('pending')
    await ledger.answer((waiting as { id: string }).id, Outcome.ALLOW)
    const handed = fresh()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(handed, 0))).toBeNull()
    expect((await ledger.resolve(ctx(), ASK, undefined, at(handed, 1)))?.kind).toBe('pending')
    expect((await ledger.held(ctx(), ASK, at(handed, 1)))?.kind).toBe('pending')
    expect(await ledger.held(ctx(), ASK, at(handed, 0))).toBeNull()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(handed, 0))).toBeNull()
    expect(ledger.pending('s')).toHaveLength(1)
  })

  it('lets a nested line run on what its parent pass claimed', async () => {
    // A line evaluated from inside another reads the outer line's claims
    // as its own: its pass finds the occurrence answered instead of
    // asking again, its gate runs on it, and only what it claims itself
    // is hidden from its own pass. Every other line still sees none of
    // it.
    const asked: string[] = []
    const ledger = new Decisions(null, (record) => {
      asked.push(record.id)
      return Promise.resolve({ ...record, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    })
    const ask: Ask = { kind: 'ask', reason: 'sign-off', rule: RULE }
    const outer: HandOff = fresh()
    expect(await ledger.resolve(ctx(), ask, undefined, at(outer))).toBeNull()
    expect(asked).toHaveLength(1)
    const inner: HandOff = fresh(outer)
    // The inner pass finds the outer claim standing for this occurrence.
    expect(await ledger.resolve(ctx(), ask, undefined, at(inner, 0))).toBeNull()
    expect(asked).toHaveLength(1)
    // A second spelling on the inner line is a question of its own.
    expect(await ledger.resolve(ctx(), ask, undefined, at(inner, 1))).toBeNull()
    expect(asked).toHaveLength(2)
    // A line outside the lineage sees neither claim.
    const stranger: HandOff = fresh()
    expect(await ledger.resolve(ctx(), ask, undefined, at(stranger))).toBeNull()
    expect(asked).toHaveLength(3)
    // The inner gates run on both without asking.
    expect(await ledger.resolve(ctx(), ask, undefined, at(inner, 0))).toBeNull()
    expect(await ledger.resolve(ctx(), ask, undefined, at(inner, 1))).toBeNull()
    expect(asked).toHaveLength(3)
    await ledger.revoke('s', inner)
    await ledger.revoke('s', outer)
    await ledger.revoke('s', stranger)
    expect(ledger.list('s')).toEqual([])
  })

  it('keeps a grant one line claimed off offer to another', async () => {
    // Two lines judged at once cannot both pass on one nod: the grant the
    // first line claimed is invisible to the second line's pass and to a
    // gate outside any line, and only the first line's own gate runs on
    // it.
    const ledger = new Decisions()
    const waiting = await ledger.resolve(ctx(), ASK)
    if (waiting?.kind !== 'pending') throw new Error('unreachable')
    await ledger.answer(waiting.id, Outcome.ALLOW)
    const first: HandOff = fresh()
    const second: HandOff = fresh()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(first))).toBeNull()
    expect((await ledger.resolve(ctx(), ASK, undefined, at(second)))?.kind).toBe('pending')
    expect((await ledger.resolve(ctx(), ASK))?.kind).toBe('pending')
    expect(await ledger.resolve(ctx(), ASK, undefined, at(first))).toBeNull()
    expect(ledger.pending('s')).toHaveLength(1)
    expect(ledger.list('s')).toHaveLength(2)
    // Released at the line's end, a claim no longer hides anything.
    await ledger.revoke('s', first)
    expect(ledger.list('s')).toHaveLength(1)
    await ledger.answer(ledger.pending('s')[0]?.id ?? '', Outcome.ALLOW)
    expect(await ledger.resolve(ctx(), ASK, undefined, at(second))).toBeNull()
  })

  it('reads a span and the lines evaluated inside it as enclosed', () => {
    const line = 'sleep 1 && cat s & ls'
    const scope: Occurrence = { parent: null, source: line, start: 0, end: 18 }
    const inside: Occurrence = { parent: null, source: line, start: 11, end: 16 }
    expect(encloses(scope, inside)).toBe(true)
    expect(encloses(scope, { parent: inside, source: 'cat s', start: 0, end: 5 })).toBe(true)
    expect(encloses(scope, { parent: null, source: line, start: 19, end: 21 })).toBe(false)
    expect(encloses(scope, { parent: null, source: 'cat s', start: 0, end: 5 })).toBe(false)
  })

  it("hands a job's claims to a run of its own", async () => {
    // A background job takes a copy of the claims made inside its span
    // onto a hand-off of its own, so the line's end, a release for a
    // question left waiting included, lets go of the line's claims alone,
    // and the job's stay reserved until the job ends.
    const ledger = new Decisions()
    const handed: HandOff = fresh()
    for (const index of [0, 1]) {
      const waiting = await ledger.resolve(ctx(), ASK)
      if (waiting?.kind !== 'pending') throw new Error('unreachable')
      await ledger.answer(waiting.id, Outcome.ALLOW)
      expect(await ledger.resolve(ctx(), ASK, undefined, at(handed, index))).toBeNull()
    }
    const job = ledger.split('s', handed, { parent: null, source: 'line', start: 1, end: 2 })
    expect(handed.claimed.map((c) => c.occurrence.start)).toEqual([0, 1])
    expect(job.claimed.map((c) => c.occurrence.start)).toEqual([1])
    ledger.release('s', handed)
    // The line's grant is on offer again; the job's is not.
    expect(await ledger.resolve(ctx(), ASK, undefined, at(fresh(), 0))).toBeNull()
    expect((await ledger.held(ctx(), ASK, at(fresh(), 1)))?.kind).toBe('pending')
    expect(await ledger.resolve(ctx(), ASK, undefined, at(job, 1))).toBeNull()
    expect(ledger.list('s')).toHaveLength(2)
    await ledger.revoke('s', job)
    expect(ledger.list('s')).toHaveLength(1)
  })

  it('keeps a claim standing for every visit until the line ends', async () => {
    // A grant bound to one place on the line is spent when the line ends,
    // not by the first gate to read it: a loop body revisits the place,
    // and the second visit runs on the same nod rather than asking again
    // after the rest of the body already ran once more.
    let asked = 0
    const allow = (r: Decision): Promise<Decision> => {
      asked += 1
      return Promise.resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    }
    const ledger = new Decisions(null, allow)
    const line: HandOff = fresh()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(line))).toBeNull()
    expect(asked).toBe(1)
    for (let visit = 0; visit < 2; visit += 1) {
      expect(await ledger.resolve(ctx(), ASK, undefined, at(line))).toBeNull()
    }
    expect(asked).toBe(1)
    expect(line.claimed).toHaveLength(1)
    expect(ledger.list('s')).toHaveLength(1)
    await ledger.revoke('s', line)
    expect(ledger.list('s')).toEqual([])
    expect(await ledger.resolve(ctx(), ASK)).toBeNull()
    expect(asked).toBe(2)
  })

  it('claims an inline grant before the ledger yields to its store', async () => {
    // A host's inline nod is claimed for the asking line in the same step
    // that records it, before the flush waits on the store. A line judged
    // during that wait finds the grant claimed, not standing, and asks for
    // itself; it used to take the nod, and the first line, resuming to
    // find its nod gone, ran on nothing at all. The in-memory ledger never
    // yields, which is what hid the window.
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
    const held = new Map<string, readonly Decision[]>()
    let flushes = 0
    const store: SessionDecisionsQuery = {
      decisionSessions: () => [...held.keys()],
      decisionsOf: (sessionId) => held.get(sessionId) ?? [],
      setDecisions: (sessionId, records) => {
        held.set(sessionId, records)
      },
      flush: async () => {
        flushes += 1
        await tick()
      },
    }
    let asked = 0
    const ledger = new Decisions(store, (r) => {
      asked += 1
      return Promise.resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    })
    const first = fresh()
    const second = fresh()
    let done = false
    const running = ledger.resolve(ctx(), ASK, undefined, at(first)).finally(() => {
      done = true
    })
    // Two flushes in, the question has been recorded and then answered,
    // and the first line is parked in the flush of its answer.
    for (let i = 0; i < 20 && flushes < 2; i += 1) await tick()
    expect(flushes).toBe(2)
    expect(done).toBe(false)
    expect(ledger.list('s').map((r) => r.outcome)).toEqual([Outcome.ALLOW])
    expect(asked).toBe(1)
    expect(await ledger.resolve(ctx(), ASK, undefined, at(second))).toBeNull()
    expect(asked).toBe(2)
    expect(await running).toBeNull()
    expect(first.claimed).toHaveLength(1)
    expect(second.claimed).toHaveLength(1)
    expect(ledger.list('s')).toHaveLength(2)
    await ledger.revoke('s', first)
    await ledger.revoke('s', second)
    expect(ledger.list('s')).toEqual([])
  })

  it("binds a gate's own answer to its place on the line", async () => {
    // A question a gate raises itself, on a line no pass read for it, is
    // answered for the line the same way: the grant is claimed for the
    // gate's place, a second visit runs on it, another place on the line
    // is a question of its own, and the line's end spends them all. Off a
    // line, a reader spends what it matched at once.
    let asked = 0
    const allow = (r: Decision): Promise<Decision> => {
      asked += 1
      return Promise.resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    }
    const ledger = new Decisions(null, allow)
    const line: HandOff = fresh()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(line, 0))).toBeNull()
    expect(asked).toBe(1)
    expect(line.claimed).toHaveLength(1)
    expect(await ledger.resolve(ctx(), ASK, undefined, at(line, 0))).toBeNull()
    expect(asked).toBe(1)
    expect(await ledger.resolve(ctx(), ASK, undefined, at(line, 1))).toBeNull()
    expect(asked).toBe(2)
    expect(line.claimed).toHaveLength(2)
    expect((await ledger.held(ctx(), ASK))?.kind).toBe('pending')
    await ledger.revoke('s', line)
    expect(ledger.list('s')).toEqual([])
    expect(await ledger.resolve(ctx(), ASK)).toBeNull()
    expect(asked).toBe(3)
    expect(ledger.list('s')).toEqual([])
  })

  it('shares ancestor claims with the job', async () => {
    const ledger = new Decisions()
    const outer = fresh()
    for (const index of [0, 1]) {
      const waiting = await ledger.resolve(ctx(), ASK)
      if (waiting?.kind !== 'pending') throw new Error('unreachable')
      await ledger.answer(waiting.id, Outcome.ALLOW)
      expect(await ledger.resolve(ctx(), ASK, undefined, at(outer, index))).toBeNull()
    }
    const nested = fresh(outer)
    expect(await ledger.resolve(ctx(), ASK, undefined, at(nested, 1))).toBeNull()
    const inner = fresh(nested)
    const job = ledger.split('s', inner, { parent: null, source: 'line', start: 1, end: 2 })
    expect(outer.claimed.map((c) => c.occurrence.start)).toEqual([0, 1])
    expect(nested.claimed).toEqual([])
    expect(inner.claimed).toEqual([])
    expect(job.claimed.map((c) => c.occurrence.start)).toEqual([1])
    for (const handed of [inner, nested, outer]) await ledger.revoke('s', handed)
    expect(ledger.list('s')).toHaveLength(1)
    expect((await ledger.held(ctx(), ASK))?.kind).toBe('pending')
    expect(await ledger.held(ctx(), ASK, at(job, 1))).toBeNull()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(job, 1))).toBeNull()
    await ledger.revoke('s', job)
    expect(ledger.list('s')).toEqual([])
  })

  it('runs every job launched from one place on its grant', async () => {
    // A loop launching the same job twice hands each job a copy of the
    // grant claimed for the one place they share; the grant stays hidden
    // from every other line while any holder lives and is spent when the
    // last of them ends.
    const ledger = new Decisions()
    const waiting = await ledger.resolve(ctx(), ASK)
    if (waiting?.kind !== 'pending') throw new Error('unreachable')
    await ledger.answer(waiting.id, Outcome.ALLOW)
    const line = fresh()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(line))).toBeNull()
    const scope: Occurrence = { parent: null, source: 'line', start: 0, end: 1 }
    const first = ledger.split('s', line, scope)
    const second = ledger.split('s', line, scope)
    expect(first.claimed).toHaveLength(1)
    expect(second.claimed).toHaveLength(1)
    await ledger.revoke('s', line)
    expect(ledger.list('s')).toHaveLength(1)
    expect((await ledger.held(ctx(), ASK))?.kind).toBe('pending')
    expect(await ledger.resolve(ctx(), ASK, undefined, at(first))).toBeNull()
    await ledger.revoke('s', first)
    expect(ledger.list('s')).toHaveLength(1)
    expect(await ledger.resolve(ctx(), ASK, undefined, at(second))).toBeNull()
    await ledger.revoke('s', second)
    expect(ledger.list('s')).toEqual([])
  })

  it("hands a nested line's claims to the line it ran from", async () => {
    // What a nested line's gate claims goes to the outer line when the
    // nested line ends, so the next evaluation from the same node runs on
    // it, and the typed line's end spends it; a typed line's own hand-off
    // is spent, never handed up.
    let asked = 0
    const allow = (r: Decision): Promise<Decision> => {
      asked += 1
      return Promise.resolve({ ...r, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    }
    const ledger = new Decisions(null, allow)
    const outer = fresh()
    const first = fresh(outer)
    expect(await ledger.resolve(ctx(), ASK, undefined, at(first))).toBeNull()
    expect(asked).toBe(1)
    expect(first.claimed).toHaveLength(1)
    ledger.handUp('s', first)
    expect(first.claimed).toEqual([])
    expect(outer.claimed).toHaveLength(1)
    expect((await ledger.held(ctx(), ASK))?.kind).toBe('pending')
    const second = fresh(outer)
    expect(await ledger.resolve(ctx(), ASK, undefined, at(second))).toBeNull()
    expect(asked).toBe(1)
    ledger.handUp('s', second)
    expect(outer.claimed).toHaveLength(1)
    await ledger.revoke('s', outer)
    expect(ledger.list('s')).toEqual([])
    expect(() => {
      ledger.handUp('s', fresh())
    }).toThrow()
  })

  it("spends a job's unspent grant when the job ends", async () => {
    const ledger = new Decisions()
    const waiting = await ledger.resolve(ctx(), ASK)
    if (waiting?.kind !== 'pending') throw new Error('unreachable')
    await ledger.answer(waiting.id, Outcome.ALLOW)
    const handed: HandOff = fresh()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(handed))).toBeNull()
    const job = ledger.split('s', handed, { parent: null, source: 'line', start: 0, end: 1 })
    await ledger.revoke('s', handed)
    expect(ledger.list('s')).toHaveLength(1)
    await ledger.revoke('s', job)
    expect(ledger.list('s')).toEqual([])
  })

  it('reads held through a live line’s claim', async () => {
    // A dry run reports what a run would find: a grant one line has
    // claimed reads as waiting to everyone else, and as answered to that
    // line.
    const ledger = new Decisions()
    const waiting = await ledger.resolve(ctx(), ASK)
    if (waiting?.kind !== 'pending') throw new Error('unreachable')
    await ledger.answer(waiting.id, Outcome.ALLOW)
    expect(await ledger.held(ctx(), ASK)).toBeNull()
    const handed: HandOff = fresh()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(handed))).toBeNull()
    expect((await ledger.held(ctx(), ASK))?.kind).toBe('pending')
    expect((await ledger.held(ctx(), ASK, at(fresh())))?.kind).toBe('pending')
    ledger.release('s', handed)
    expect(await ledger.held(ctx(), ASK)).toBeNull()
  })

  it('hands back a grant given before the pass when the line is revoked', async () => {
    // A grant answered out of band is claimed by the pass that reads it
    // exactly as an inline one is, so a refusal hands it back too and the
    // next identical line is a question again.
    const ledger = new Decisions()
    const waiting = await ledger.resolve(ctx(), ASK)
    expect(waiting?.kind).toBe('pending')
    if (waiting?.kind !== 'pending') throw new Error('unreachable')
    await ledger.answer(waiting.id, Outcome.ALLOW)
    const handed: HandOff = fresh()
    expect(await ledger.resolve(ctx(), ASK, undefined, at(handed))).toBeNull()
    expect(handed.claimed).toHaveLength(1)
    await ledger.revoke('s', handed)
    expect(ledger.list('s')).toEqual([])
    expect((await ledger.resolve(ctx(), ASK))?.kind).toBe('pending')
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
