import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { RAMNamespaceStore } from '../workspace/mount/namespace/ram.ts'
import type { RecordFields } from '../workspace/record/types.ts'
import { SessionManager } from '../workspace/session/manager.ts'
import { Decisions } from './decisions.ts'
import {
  Outcome,
  Scope,
  type CommandContext,
  type CommandRule,
  type Decision,
  type HandOff,
  type Occurrence,
  type SessionDecisionsQuery,
} from './types.ts'

const outcome = z.enum(['allow', 'deny', 'ask'])
const scope = z.enum(['once', 'session'])
const reader = z.object({ holder: z.string(), at: z.string() })
const action = z.discriminatedUnion('op', [
  z.object({
    op: z.enum(['resolve', 'held']),
    rules: z.array(z.number()).default([0]),
    argv: z.array(z.string()).default(['push']),
    cwd: z.string().default('/repo'),
    reader: reader.nullable().default(null),
  }),
  z.object({
    op: z.literal('holder'),
    holder: z.string(),
    parent: z.string().nullable().default(null),
    origin: z.string().nullable().default(null),
  }),
  z.object({
    op: z.literal('answer'),
    record: z.number().default(0),
    outcome,
    scope: scope.default('once'),
  }),
  z.object({ op: z.literal('split'), holder: z.string(), target: z.string(), at: z.string() }),
  z.object({ op: z.enum(['hand_up', 'release', 'revoke']), holder: z.string() }),
])
const corpus = z
  .object({
    baseline: z.string(),
    stored_session: z.object({
      session_id: z.string(),
      cwd: z.string(),
      generation: z.number(),
      decisions: z.array(
        z.object({
          id: z.string(),
          session_id: z.string(),
          command: z.string(),
          argv: z.array(z.string()),
          cwd: z.string(),
          paths: z.array(z.string()),
          reason: z.string(),
          rule: z.object({
            reason: z.string(),
            commands: z.array(z.string()),
            paths: z.array(z.string()),
            mount: z.string().optional(),
          }),
          outcome: z.string().nullable(),
          scope: z.string(),
          note: z.string(),
        }),
      ),
    }),
    cases: z.array(
      z.object({
        name: z.string(),
        rules: z.array(z.string()).default(['first']),
        occurrences: z
          .record(
            z.string(),
            z.object({
              parent: z.string().nullable().default(null),
              source: z.string().default('line'),
              start: z.number(),
              end: z.number(),
            }),
          )
          .default({}),
        answers: z.array(z.object({ outcome, scope: scope.default('once') })).optional(),
        steps: z.array(action),
        expected: z.array(z.unknown()),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('../../../../../integ/policy/approvals.json', import.meta.url), 'utf8'),
    ),
  )

const outcomes = { allow: Outcome.ALLOW, deny: Outcome.DENY, ask: Outcome.ASK }
const scopes = { once: Scope.ONCE, session: Scope.SESSION }

class Sessions implements SessionDecisionsQuery {
  records = new Map<string, readonly Decision[]>()
  flushes = 0

  decisionSessions(): readonly string[] {
    return [...this.records.keys()]
  }

  decisionsOf(sessionId: string): readonly Decision[] {
    return this.records.get(sessionId) ?? []
  }

  setDecisions(sessionId: string, records: readonly Decision[]): void {
    this.records.set(sessionId, records)
  }

  flush(): Promise<void> {
    this.flushes += 1
    return Promise.resolve()
  }
}

function required<T>(values: ReadonlyMap<string, T>, key: string): T {
  const value = values.get(key)
  if (value === undefined) throw new Error(`unknown corpus reference ${key}`)
  return value
}

function record(value: Decision) {
  return {
    id: value.id,
    session_id: value.sessionId,
    command: value.command,
    argv: value.argv,
    cwd: value.cwd,
    paths: value.paths,
    reason: value.reason,
    rule: value.rule,
    outcome: value.outcome,
    scope: value.scope,
    note: value.note,
  }
}

describe('approval behavior recorded from main', () => {
  it.each(corpus.cases)('$name', async (row) => {
    const sessions = new Sessions()
    let prompts = 0
    const onAsk = (value: Decision): Promise<Decision | null> => {
      const answer = row.answers?.[prompts]
      prompts += 1
      return Promise.resolve(
        answer === undefined
          ? null
          : { ...value, outcome: outcomes[answer.outcome], scope: scopes[answer.scope] },
      )
    }
    const ledger = new Decisions(sessions, row.answers === undefined ? undefined : onAsk)
    const rules: CommandRule[] = row.rules.map((reason) => ({
      reason,
      commands: ['git push'],
      paths: [],
      mount: '',
    }))
    const occurrences = new Map<string, Occurrence>()
    for (const [name, value] of Object.entries(row.occurrences))
      occurrences.set(name, {
        parent: value.parent === null ? null : required(occurrences, value.parent),
        source: value.source,
        start: value.start,
        end: value.end,
      })
    const holders = new Map<string, HandOff>()
    const actual = []
    for (const step of row.steps) {
      let result: { kind: string; id?: string; reason?: string } = { kind: 'ok' }
      switch (step.op) {
        case 'holder':
          holders.set(step.holder, {
            claimed: [],
            parent: step.parent === null ? null : required(holders, step.parent),
            origin: step.origin === null ? null : required(occurrences, step.origin),
          })
          break
        case 'resolve':
        case 'held': {
          const selected = step.rules.map((index) => {
            const rule = rules[index]
            if (rule === undefined) throw new Error(`unknown corpus rule ${String(index)}`)
            return rule
          })
          const first = selected[0]
          if (first === undefined) throw new Error('corpus ask must name a rule')
          const ask = { kind: 'ask', reason: first.reason, rules: selected } satisfies {
            kind: 'ask'
            reason: string
            rules: CommandRule[]
          }
          const ctx: CommandContext = {
            command: 'git',
            argv: step.argv,
            cwd: step.cwd,
            paths: [],
            sessionId: 's',
          }
          const claimant =
            step.reader === null
              ? null
              : {
                  line: required(holders, step.reader.holder),
                  occurrence: required(occurrences, step.reader.at),
                }
          const action =
            step.op === 'resolve'
              ? await ledger.resolve(ctx, ask, undefined, claimant)
              : await ledger.held(ctx, ask, claimant)
          result = action ?? { kind: 'allow' }
          break
        }
        case 'answer': {
          const value = ledger.list('s')[step.record]
          if (value === undefined) throw new Error('corpus answer must name a record')
          await ledger.answer(value.id, outcomes[step.outcome], scopes[step.scope])
          break
        }
        case 'split':
          holders.set(
            step.target,
            ledger.split('s', required(holders, step.holder), required(occurrences, step.at)),
          )
          break
        case 'hand_up':
          ledger.handUp('s', required(holders, step.holder))
          break
        case 'release':
          ledger.release('s', required(holders, step.holder))
          break
        case 'revoke':
          await ledger.revoke('s', required(holders, step.holder))
          break
      }
      actual.push({
        result,
        records: ledger.list('s').map(record),
        flushes: sessions.flushes,
        prompts,
      })
    }
    expect(actual).toEqual(row.expected)
  })
})

class CountingStore extends RAMNamespaceStore {
  reads = 0
  writes = 0

  override load(): Promise<Map<string, RecordFields>> {
    this.reads += 1
    return super.load()
  }

  override set(key: string, fields: RecordFields): Promise<void> {
    this.writes += 1
    return super.set(key, fields)
  }

  override casSet(key: string, fields: RecordFields, generation: number): Promise<boolean> {
    this.writes += 1
    return super.casSet(key, fields, generation)
  }
}

it('hydrates a main-saved grant and checks it without store I/O', async () => {
  const saved = corpus.stored_session
  const store = new CountingStore()
  await store.set('s', saved)
  const sessions = new SessionManager('s', store)
  await sessions.ensureLoaded()
  expect([store.reads, store.writes]).toEqual([1, 1])
  const baseline = [store.reads, store.writes]
  const ledger = new Decisions(sessions)
  const ctx: CommandContext = {
    command: 'git',
    argv: ['push'],
    paths: [],
    cwd: '/repo',
    sessionId: 's',
  }
  const ask = {
    kind: 'ask',
    reason: 'first',
    rule: { reason: 'first', commands: ['git push'], paths: [], mount: '' },
  } satisfies { kind: 'ask'; reason: string; rule: CommandRule }
  for (let index = 0; index < 3; index += 1) {
    expect(await ledger.resolve(ctx, ask)).toBeNull()
    expect(await ledger.held(ctx, ask)).toBeNull()
  }
  await sessions.flush()
  expect([store.reads, store.writes]).toEqual(baseline)
  expect(sessions.get('s').toDict().decisions).toEqual(saved.decisions)
})

it('observes mutable approval fields and aliased rule arrays without replacing the record list', async () => {
  const sessions = new Sessions()
  const ledger = new Decisions(sessions)
  const rule: CommandRule = { reason: 'first', commands: ['git push'] }
  const ask = { kind: 'ask', reason: 'first', rule } satisfies {
    kind: 'ask'
    reason: string
    rule: CommandRule
  }
  const ctx: CommandContext = {
    command: 'git',
    argv: ['push'],
    paths: [],
    cwd: '/repo',
    sessionId: 's',
  }
  await ledger.resolve(ctx, ask)
  const record = ledger.list('s')[0]
  if (record === undefined) throw new Error('expected the pending approval')
  await ledger.answer(record.id, Outcome.ALLOW, Scope.SESSION)
  const granted = ledger.list('s')[0]
  if (granted === undefined) throw new Error('expected the settled approval')
  expect(await ledger.resolve(ctx, ask)).toBeNull()
  granted.rule.reason = 'updated'
  expect(await ledger.resolve(ctx, ask)).toBeNull()
  const commands = ['git push']
  granted.rule.commands = commands
  expect(await ledger.resolve(ctx, ask)).toBeNull()
  commands[0] = 'git status'
  expect(await ledger.resolve(ctx, ask)).toBeNull()
  granted.scope = Scope.ONCE
  granted.outcome = Outcome.DENY
  expect(await ledger.resolve(ctx, ask)).toMatchObject({ kind: 'deny' })
  expect(ledger.list('s')).toEqual([])
})
