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

import { z } from 'zod'
import { ApprovalSnapshot, approvalQuery, recordWire } from '../rs/approvals.ts'
import { concat } from '../utils/bytes.ts'
import { asyncContextIsolatesTasks } from '../utils/async_context.ts'
import {
  type Caller,
  currentCaller,
  explaining,
  liveCallers,
  runWithCaller,
} from '../context/session_context.ts'
import { sha256Hex } from '../utils/hash.ts'
import type { Refusal } from '../types.ts'
import { PolicyDenied } from './errors.ts'
import { DecisionOwner, Outcome } from './types.ts'
import type {
  Abandoned,
  Ask,
  Claimant,
  CommandContext,
  CommandRule,
  Decision,
  Deny,
  ExecuteResultContext,
  HandOff,
  NetworkContext,
  Occurrence,
  VfsContext,
  Pending,
  SessionDecisionsQuery,
} from './types.ts'
import { DryRun, Scope } from './types.ts'
import type { RouteContext } from './types.ts'

const ABANDONED: Abandoned = { kind: 'abandoned' }

/**
 * Tell the abandonment of a question from a host's answer.
 *
 * Structural, not by identity: a `Decision` carries no `kind`, so the
 * field alone separates the two without depending on this module being
 * the only place the sentinel is built.
 *
 * @param said what the wait produced.
 * @returns true when the run went away mid-question.
 */
function isAbandoned(said: Decision | null | Abandoned): said is Abandoned {
  return said !== null && 'kind' in said
}

/**
 * A host's answer, or the abandonment of the question when the run
 * waiting on it is killed first.
 *
 * The wait is taken as a thunk so a run already over never starts one:
 * nothing should be put to a host on behalf of a line that no longer
 * exists. An abandoned wait is not cancelled, because a promise cannot
 * be; its value is dropped, and the rejection handler stays attached so
 * a channel that falls over afterwards does not surface as an unhandled
 * rejection.
 *
 * @param start begins the wait; called at most once.
 * @param signal the run's abort signal; absent leaves the wait alone.
 * @returns the answer, or ABANDONED once the run is gone.
 */
async function answered(
  start: () => Promise<Decision | null>,
  signal: AbortSignal | undefined,
): Promise<Decision | null | Abandoned> {
  if (signal === undefined) return start()
  if (signal.aborted) return ABANDONED
  const pending = start()
  return new Promise<Decision | null | Abandoned>((resolve, reject) => {
    const onAbort = (): void => {
      resolve(ABANDONED)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

/**
 * A host that answers an Ask inside the line.
 *
 * `signal` is the run's, so a host that puts a question to a person can
 * take its prompt down when the run it belongs to is killed. Ignoring it
 * is safe: the ledger stops waiting on the handler either way.
 */
export type AskHandler = (record: Decision, signal?: AbortSignal) => Promise<Decision | null>

/**
 * The id a record is named by: a digest of what was asked, so a retry
 * of the same line quotes the same id and a host answers it once.
 *
 * The id names the record; it does not decide what a retry matches.
 * That comparison is made against the recorded fields themselves
 * (`covers`), so a line the digest cannot tell apart from another still
 * cannot borrow its answer.
 */
export async function decisionId(
  sessionId: string,
  cwd: string,
  argv: readonly string[],
): Promise<string> {
  const enc = new TextEncoder()
  const parts = [sessionId, cwd, ...argv].map((part) => enc.encode(part + '\0'))
  const bytes = concat(parts)
  return (await sha256Hex(bytes)).slice(0, 12)
}

/**
 * The rule an Ask is keyed on: the document's, or for a coded Ask one
 * synthesized over what was asked about (the program, the path, the
 * line, the host), so a session answer reads "stop asking me about
 * this".
 */
export function askRule(
  ctx: CommandContext | RouteContext | VfsContext | ExecuteResultContext | NetworkContext,
  ask: Ask,
): CommandRule {
  if (ask.rule != null) return ask.rule
  if ('address' in ctx)
    return { reason: ask.reason, commands: [ctx.host === '' ? ctx.address : ctx.host] }
  if ('call' in ctx) return { reason: ask.reason, paths: [ctx.path.virtual] }
  if ('commands' in ctx) return { reason: ask.reason, commands: [ctx.line] }
  const program = (ctx.program ?? [ctx.command]).join(' ')
  return { reason: ask.reason, commands: [program] }
}

function sameList(a: readonly string[] = [], b: readonly string[] = []): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function sameRule(a: CommandRule, b: CommandRule): boolean {
  return (
    a.reason === b.reason &&
    a.mount === b.mount &&
    sameList(a.commands, b.commands) &&
    sameList(a.paths, b.paths)
  )
}

export function covers(
  record: Decision,
  rule: CommandRule,
  argv: readonly string[],
  cwd: string,
): boolean {
  return approvalQuery(
    {
      kind: 'covers',
      record: recordWire(record, 0, sameRule(record.rule, rule) ? 0 : null, argv, cwd),
      rule: 0,
    },
    z.boolean(),
  )
}

export function lineage(handed: HandOff | null): HandOff[] {
  const out: HandOff[] = []
  for (let h = handed; h !== null; h = h.parent) out.push(h)
  return out
}

export function sameOccurrence(a: Occurrence | null, b: Occurrence | null): boolean {
  let x = a
  let y = b
  while (x !== null && y !== null) {
    if (x.source !== y.source || x.start !== y.start || x.end !== y.end) return false
    x = x.parent
    y = y.parent
  }
  return x === null && y === null
}

export function isPending(refusal: Refusal | null | undefined): boolean {
  return refusal?.kind === 'pending'
}

export function opQuestion(
  ctx: VfsContext | RouteContext | ExecuteResultContext,
  ask: Ask,
): [CommandContext, Ask] {
  const rules = ask.rules ?? [askRule(ctx, ask)]
  const rule = ask.rule ?? rules[0]
  const keyed: Ask = { ...ask, ...(rule !== undefined ? { rule } : {}), rules }
  let words: string[]
  let paths: CommandContext['paths'] = []
  let cwd = ''
  if ('call' in ctx) {
    words = [ctx.path.virtual]
    paths = [ctx.path]
  } else {
    words = [ctx.line]
    cwd = ctx.session?.cwd() ?? ''
  }
  const asked: CommandContext = {
    command: '',
    paths,
    argv: words,
    cwd,
    sessionId: ctx.sessionId ?? '',
  }
  return [asked, keyed]
}

export function encloses(scope: Occurrence, occurrence: Occurrence): boolean {
  const facts = new ApprovalSnapshot()
  const outer = facts.occurrenceKey(scope)
  const inner = facts.occurrenceKey(occurrence)
  const state = facts.wire
  return approvalQuery(
    {
      kind: 'encloses',
      occurrences: state.occurrences ?? [],
      sources: state.sources ?? [],
      scope: outer,
      occurrence: inner,
    },
    z.boolean(),
  )
}

export class Decisions extends DecisionOwner {
  private readonly sessions: SessionDecisionsQuery | null
  private readonly onAsk: AskHandler | null
  private readonly memory = new Map<string, Decision[]>()
  private readonly live = new Map<string, Set<HandOff>>()

  constructor(sessions: SessionDecisionsQuery | null = null, onAsk: AskHandler | null = null) {
    super()
    this.sessions = sessions
    this.onAsk = onAsk
  }

  /** Every record, oldest first: questions waiting and questions settled. */
  list(sessionId = ''): Decision[] {
    if (sessionId) return [...this.records(sessionId)]
    return this.keys().flatMap((key) => [...this.records(key)])
  }

  pending(sessionId = ''): Decision[] {
    return this.list(sessionId).filter((record) => record.outcome === null)
  }

  async answer(
    decisionId: string,
    outcome: Outcome,
    scope: Scope = Scope.ONCE,
    note = '',
  ): Promise<void> {
    this.writeAnswer(decisionId, outcome, scope, note)
    await this.flush()
  }

  private writeAnswer(decisionId: string, outcome: Outcome, scope: Scope, note: string): Decision {
    if (outcome === Outcome.ASK) throw new Error('ASK is the question, not an answer')
    for (const sessionId of this.keys()) {
      const records = [...this.records(sessionId)]
      const candidates = records.filter((record) => record.id === decisionId)
      if (candidates.length === 0) continue
      const selected = new ApprovalSnapshot(candidates).answer(decisionId, outcome)
      if (selected === null) continue
      const index = records.indexOf(selected)
      const settled: Decision = { ...selected, outcome, scope, note }
      records[index] = settled
      this.set(sessionId, records)
      return settled
    }
    throw new Error(`no decision waiting with id ${decisionId}`)
  }

  async resolve(
    ctx: CommandContext,
    ask: Ask,
    signal?: AbortSignal,
    claimant: Claimant | null = null,
  ): Promise<Deny | Pending | Abandoned | null> {
    const rules = ask.rules ?? [askRule(ctx, ask)]
    const argv = [ctx.command, ...ctx.argv]
    const sessionId = ctx.sessionId ?? ''
    const initial = this.plan(sessionId, rules, argv, ctx.cwd, claimant)
    if (initial.denied !== null) {
      const refused = rules[initial.denied]
      if (refused === undefined) throw new Error('approval returned an unknown rule')
      await this.spend(sessionId, initial.once)
      return { kind: 'deny', reason: refused.reason }
    }
    for (const [position, index] of initial.missing.entries()) {
      const rule = rules[index]
      if (rule === undefined) throw new Error('approval returned an unknown rule')
      const waiting =
        position === 0 ? (initial.waiting[index] ?? null) : this.waiting(ctx, rule, argv)
      const action = await this.raise(ctx, rule, argv, signal, claimant, waiting)
      if (action !== null) return action
    }
    const settled =
      initial.missing.length === 0 ? initial : this.plan(sessionId, rules, argv, ctx.cwd, claimant)
    if (claimant === null) await this.spend(sessionId, settled.once)
    else if (settled.claim !== null) this.applyClaim(sessionId, claimant, settled.claim)
    return null
  }

  private claim(sessionId: string, claimant: Claimant, once: readonly Decision[]): void {
    if (once.length === 0) return
    const facts = new ApprovalSnapshot([], this.live.get(sessionId), [claimant.line])
    this.applyClaim(sessionId, claimant, facts.claim(claimant.line, once))
  }

  async resolveOp(ctx: VfsContext, ask: Ask, caller?: Caller): Promise<Deny | Pending | null> {
    const trace = caller === undefined ? explaining() : caller.explaining
    if (trace === DryRun.DECIDING) return this.heldOp(ctx, ask)
    const [asked, keyed] = opQuestion(ctx, ask)
    const sessionId = ctx.sessionId ?? ''
    const call = caller !== undefined ? callOf(caller, this, sessionId) : getOpCall(this, sessionId)
    const claimant: Claimant | null =
      call === null
        ? null
        : {
            line: call,
            occurrence: { parent: null, source: asked.argv[0] ?? '', start: 0, end: 0 },
          }
    const said = await this.resolve(asked, keyed, undefined, claimant)
    return said?.kind === 'abandoned' ? { kind: 'deny', reason: ask.reason } : said
  }

  heldOp(ctx: VfsContext, ask: Ask): Promise<Deny | Pending | null> {
    const [asked, keyed] = opQuestion(ctx, ask)
    return this.held(asked, keyed)
  }

  async withinCall<T>(sessionId: string, run: (handed: HandOff) => Promise<T>): Promise<T> {
    const outer = asyncContextIsolatesTasks ? getOpCall(this, sessionId) : null
    if (outer !== null) return run(outer)
    const handed: HandOff = { claimed: [], parent: null, origin: null }
    try {
      return await runWithOpCall(this, handed, sessionId, () => run(handed))
    } catch (err) {
      const held = err instanceof PolicyDenied && isPending(err.refusal)
      if (held && asyncContextIsolatesTasks) this.release(sessionId, handed)
      throw err
    } finally {
      await this.revoke(sessionId, handed)
    }
  }

  async revoke(sessionId: string, handed: HandOff): Promise<void> {
    if (handed.claimed.length === 0 && !this.live.get(sessionId)?.has(handed)) return
    const facts = new ApprovalSnapshot([], this.live.get(sessionId), [handed])
    await this.spend(sessionId, facts.revoke(handed))
    this.release(sessionId, handed)
  }

  split(sessionId: string, handed: HandOff, scope: Occurrence): HandOff {
    const job: HandOff = { claimed: [], parent: handed.parent, origin: handed.origin }
    const facts = new ApprovalSnapshot([], [], [handed])
    if (facts.claimObjects.length === 0) return job
    job.claimed.push(...facts.split(handed, scope))
    if (job.claimed.length > 0) {
      const live = this.live.get(sessionId) ?? new Set<HandOff>()
      live.add(job)
      this.live.set(sessionId, live)
    }
    return job
  }

  handUp(sessionId: string, handed: HandOff): void {
    if (handed.parent === null) throw new Error("a typed line's claims are spent, not handed up")
    if (
      handed.claimed.length === 0 &&
      handed.parent.claimed.length === 0 &&
      !this.live.get(sessionId)?.has(handed)
    )
      return
    const facts = new ApprovalSnapshot([], this.live.get(sessionId), [handed])
    const result = facts.handUp(handed)
    result.parent.claimed.push(...result.claims)
    handed.claimed.length = 0
    this.live.set(sessionId, new Set(result.live))
  }

  release(sessionId: string, handed: HandOff): void {
    handed.claimed.length = 0
    this.live.get(sessionId)?.delete(handed)
  }

  async held(
    ctx: CommandContext,
    ask: Ask,
    claimant: Claimant | null = null,
  ): Promise<Deny | Pending | null> {
    const rules = ask.rules ?? [askRule(ctx, ask)]
    const argv = [ctx.command, ...ctx.argv]
    const sessionId = ctx.sessionId ?? ''
    const result = this.plan(sessionId, rules, argv, ctx.cwd, claimant)
    if (result.denied !== null) {
      const refused = rules[result.denied]
      if (refused === undefined) throw new Error('approval returned an unknown rule')
      return { kind: 'deny', reason: refused.reason }
    }
    const index = result.missing[0]
    if (index === undefined) return null
    const unanswered = rules[index]
    if (unanswered === undefined) throw new Error('approval returned an unknown rule')
    return {
      kind: 'pending',
      id: await decisionId(sessionId, ctx.cwd, argv),
      reason: unanswered.reason,
    }
  }

  private async raise(
    ctx: CommandContext,
    rule: CommandRule,
    argv: readonly string[],
    signal?: AbortSignal,
    claimant: Claimant | null = null,
    record: Decision | null = null,
  ): Promise<Deny | Pending | Abandoned | null> {
    if (record === null) {
      record = {
        id: await decisionId(ctx.sessionId ?? '', ctx.cwd, argv),
        sessionId: ctx.sessionId ?? '',
        command: ctx.command,
        argv: [...ctx.argv],
        cwd: ctx.cwd,
        paths: ctx.paths.map((p) => p.virtual),
        reason: rule.reason,
        rule,
        outcome: null,
        scope: Scope.ONCE,
        note: '',
      }
      this.add(ctx.sessionId ?? '', record)
      await this.flush()
    }
    const onAsk = this.onAsk
    if (onAsk === null) return { kind: 'pending', id: record.id, reason: rule.reason }
    const said = await answered(() => onAsk(record, signal), signal)
    if (isAbandoned(said)) return said
    if (said?.outcome == null) return { kind: 'pending', id: record.id, reason: rule.reason }
    const settled = this.writeAnswer(record.id, said.outcome, said.scope, said.note)
    if (claimant !== null && settled.outcome === Outcome.ALLOW && settled.scope === Scope.ONCE)
      this.claim(ctx.sessionId ?? '', claimant, [settled])
    await this.flush()
    return said.outcome === Outcome.DENY ? { kind: 'deny', reason: rule.reason } : null
  }

  private waiting(
    ctx: CommandContext,
    rule: CommandRule,
    argv: readonly string[],
  ): Decision | null {
    const records = this.records(ctx.sessionId ?? '').filter((record) =>
      sameRule(record.rule, rule),
    )
    return new ApprovalSnapshot(records).waiting(argv, ctx.cwd)
  }

  private async spend(sessionId: string, spent: readonly Decision[]): Promise<void> {
    if (spent.length === 0) return
    this.set(
      sessionId,
      this.records(sessionId).filter((record) => !spent.some((consumed) => consumed === record)),
    )
    await this.flush()
  }

  private keys(): string[] {
    return this.sessions !== null ? [...this.sessions.decisionSessions()] : [...this.memory.keys()]
  }

  private plan(
    sessionId: string,
    rules: readonly CommandRule[],
    argv: readonly string[],
    cwd: string,
    claimant: Claimant | null,
  ) {
    const records: Decision[] = []
    const recordRules: number[] = []
    const knownRules = new Map<CommandRule, number>()
    const asked = rules.map((rule) => {
      const key = rules.findIndex((other) => sameRule(rule, other))
      knownRules.set(rule, key)
      return key
    })
    for (const record of this.records(sessionId)) {
      let rule = knownRules.get(record.rule)
      if (rule === undefined) {
        rule = rules.findIndex((rule) => sameRule(record.rule, rule))
        knownRules.set(record.rule, rule)
      }
      if (rule < 0) continue
      records.push(record)
      recordRules.push(rule)
    }
    return new ApprovalSnapshot(records, this.live.get(sessionId)).plan(
      recordRules,
      asked,
      argv,
      cwd,
      claimant,
    )
  }

  private applyClaim(
    sessionId: string,
    claimant: Claimant,
    result: { records: readonly Decision[]; live: readonly HandOff[] },
  ): void {
    if (result.records.length === 0) return
    claimant.line.claimed.push(
      ...result.records.map((decision) => ({ occurrence: claimant.occurrence, decision })),
    )
    this.live.set(sessionId, new Set(result.live))
  }

  private records(sessionId: string): readonly Decision[] {
    return this.sessions !== null
      ? this.sessions.decisionsOf(sessionId)
      : (this.memory.get(sessionId) ?? [])
  }

  private set(sessionId: string, records: Decision[]): void {
    if (this.sessions !== null) this.sessions.setDecisions(sessionId, records)
    else this.memory.set(sessionId, records)
  }

  private add(sessionId: string, record: Decision): void {
    this.set(sessionId, [...this.records(sessionId), record])
  }

  private async flush(): Promise<void> {
    if (this.sessions !== null) await this.sessions.flush()
  }
}

/**
 * Run one call, the unit an op-level answer covers: a file tool's, or a
 * line's or a job's, whose session writes are its ops. A grant one of its
 * ops is answered by is claimed on `handed` for the call's other ops on
 * that subject. `owner` is the ledger
 * the call runs under, the only one that claims on `handed` and spends
 * it. Mirrors Python's `set_op_call`.
 */
export function runWithOpCall<T>(
  owner: Decisions,
  handed: HandOff,
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithCaller({ ...currentCaller(), call: [owner, handed, sessionId] }, fn)
}

/**
 * The call running in this context under `owner`'s ledger for
 * `sessionId`, null for a bare op, for a call another ledger
 * runs (a host callback reaching a second workspace mid-call) or for
 * another session's call. Without task isolation every live call is in
 * reach, so the newest of this ledger's and session's is taken.
 */
export function getOpCall(owner: Decisions, sessionId: string): HandOff | null {
  const call = liveCallers()
    .flatMap((caller) => (caller.call === null ? [] : [caller.call]))
    .reverse()
    .find(([ledger, , session]) => ledger === owner && session === sessionId)
  return call?.[1] ?? null
}

/**
 * The call `caller` runs in under `owner`'s ledger for `sessionId`, null
 * for a bare op, for a call another ledger runs or for another session's
 * call. Mirrors Python's `call_of`.
 */
export function callOf(caller: Caller, owner: Decisions, sessionId: string): HandOff | null {
  const call = caller.call
  if (call?.[0] !== owner || call[2] !== sessionId) return null
  return call[1]
}
