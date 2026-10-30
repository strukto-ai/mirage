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
import { KeyLock } from '../cache/lock.ts'
import { authorityId } from '../utils/ids.ts'
import { hasAborted } from '../utils/abort.ts'
import { openStreamSync } from '../rs/stream.ts'
import { units, fromUnits, ruleWire } from '../rs/policy.ts'
import type { RecordFields } from '../workspace/record/types.ts'
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
import { ApprovalUnavailable, PolicyDenied } from './errors.ts'
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
  Occurrence,
  VfsContext,
  Pending,
  SessionContext,
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

/** A stable display digest. Approval authority uses fresh opaque tickets. */
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
 * line, the variable), so a session answer reads "stop asking me about
 * this".
 */
export function askRule(
  ctx: CommandContext | RouteContext | VfsContext | ExecuteResultContext | SessionContext,
  ask: Ask,
): CommandRule {
  if (ask.rule != null) return ask.rule
  if ('verb' in ctx) return { reason: ask.reason, commands: [ctx.key] }
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
    (a.mount ?? '') === (b.mount ?? '') &&
    sameList(a.commands, b.commands) &&
    sameList(a.paths, b.paths)
  )
}

/**
 * Whether an answered record answers this rule of this line.
 *
 * A ONCE answer covers the exact line it was given for, compared field
 * by field. A SESSION answer covers every line the same rule asks
 * about. Both are keyed on the rule as well as the words: an answer
 * that outlives a rule change (a persisted store reopened under an
 * edited profile) must not answer the new rule's ask, and a stale
 * refusal must not speak in its voice.
 */
export function covers(
  record: Decision,
  rule: CommandRule,
  argv: readonly string[],
  cwd: string,
): boolean {
  const command = argv[0]
  if (command === undefined) throw new Error('approval question needs a command')
  const question = { ...record, command, argv: argv.slice(1), cwd }
  const result = inspectApproval(emptyLedger('inspection'), {
    op: 'inspect',
    query: {
      kind: 'covers',
      record: decisionWire(record),
      rule: ruleWire(rule),
      question: decisionWire(question),
    },
  })
  if (result.kind !== 'matches') throw new Error('invalid approval comparison')
  return result.matched
}

/**
 * The workspace's decision ledger: turns an Ask into run, refuse or
 * pending, and is the host's handle on every question raised and every
 * answer given.
 *
 * One record type, one store. A `Decision` with no outcome is a
 * question waiting; one with an outcome is a question settled, and how
 * far the answer reaches is its `scope`. Keeping both in one place is
 * the point: they used to be two stores, a pending map that vanished on
 * restart and a per-session answer list that did not, so a host could
 * see a question that no longer existed or miss one that did.
 *
 * Mirrors the Python Decisions.
 */
/**
 * A hand-off and every line it was evaluated from, innermost first;
 * empty outside a line.
 */
export function lineage(handed: HandOff | null): HandOff[] {
  const out: HandOff[] = []
  for (let h = handed; h !== null; h = h.parent) out.push(h)
  return out
}

/**
 * Whether two occurrences are one place: the same span of the same
 * text, under the same node all the way up.
 */
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

/**
 * Whether a refusal record is a question the host has not answered yet,
 * which holds the line for its retry rather than ending it. Mirrors the
 * Python `is_pending`.
 */
export function isPending(refusal: Refusal | null | undefined): boolean {
  return refusal?.kind === 'pending'
}

/**
 * A question about no command as the ledger keys it: no command, and the
 * words of its record are what was asked about: the path of a VFS call,
 * the variable a session write sets with the value it writes, the line.
 * Mirrors Python's `op_question`.
 */
export function opQuestion(
  ctx: VfsContext | SessionContext | RouteContext | ExecuteResultContext,
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
  } else if ('verb' in ctx) {
    words = ctx.value === null ? [ctx.key] : [ctx.key, ctx.value]
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

/**
 * Whether a command stands inside a scope: within the scope's span of
 * the same text, or on a line evaluated from a node that does.
 *
 * @param scope the enclosing node, a background job's.
 * @param occurrence the command's place.
 */
export function encloses(scope: Occurrence, occurrence: Occurrence): boolean {
  const result = inspectApproval(emptyLedger('inspection'), {
    op: 'inspect',
    query: {
      kind: 'encloses',
      scope: occurrenceWire(scope),
      occurrence: occurrenceWire(occurrence),
    },
  })
  if (result.kind !== 'matches') throw new Error('invalid approval comparison')
  return result.matched
}

const unitSchema = z.array(z.number().int().min(0).max(0x10ffff))
const ruleSchema = z.object({
  reason: unitSchema,
  commands: z.array(unitSchema),
  paths: z.array(unitSchema),
  mount: unitSchema.nullable(),
})
const decisionSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  command: unitSchema,
  argv: z.array(unitSchema),
  cwd: unitSchema,
  paths: z.array(unitSchema),
  reason: unitSchema,
  rule: ruleSchema,
  outcome: z.enum([Outcome.ALLOW, Outcome.DENY]).nullable(),
  scope: z.enum(Scope),
  note: unitSchema,
})
const occurrenceSchema = z.object({
  parent: z.unknown(),
  source: unitSchema,
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
})
const ledgerSchema = z
  .object({
    version: z.literal(1),
    incarnation: z.string(),
    revision: z.number().int().nonnegative(),
    records: z.array(decisionSchema),
    claims: z.array(
      z.object({
        owner: z.string(),
        holder: z.string(),
        decision: z.string(),
        occurrence: z.unknown(),
      }),
    ),
  })
  .loose()
const resultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allow') }),
  z.object({ kind: z.literal('pending'), record: decisionSchema, fresh: z.boolean() }),
  z.object({ kind: z.literal('deny'), reason: unitSchema }),
  z.object({ kind: z.literal('answered'), record: decisionSchema }),
  z.object({ kind: z.literal('applied') }),
  z.object({ kind: z.literal('missing') }),
  z.object({ kind: z.literal('blocked'), status: z.string() }),
  z.object({ kind: z.literal('matches'), matched: z.boolean() }),
  z.object({ kind: z.literal('grants'), rules: z.array(ruleSchema) }),
])
const effectSchema = z.object({
  op: z.literal('persist_approvals'),
  evaluation: z.string(),
  transition: z.string(),
  effect: z.literal(1),
  ledger: ledgerSchema,
})
type ApprovalResult = z.infer<typeof resultSchema>
type DecisionWire = z.infer<typeof decisionSchema>
interface ScopeBinding {
  sessionId: string
  incarnation: string
}
export const logger: { debug?: (message: string) => void } = {}

export function emptyLedger(incarnation: string): RecordFields {
  return {
    version: 1,
    incarnation,
    revision: 0,
    records: [],
    claims: [],
    holders: [],
    receipts: [],
    retired: [],
  }
}

export function decisionWire(record: Decision): RecordFields {
  return {
    id: record.id,
    session_id: record.sessionId,
    command: units(record.command),
    argv: record.argv.map(units),
    cwd: units(record.cwd),
    paths: record.paths.map(units),
    reason: units(record.reason),
    rule: ruleWire(record.rule),
    outcome: record.outcome,
    scope: record.scope,
    note: units(record.note),
  }
}

export function decisionFromWire(record: DecisionWire): Decision {
  const mount = record.rule.mount === null ? '' : fromUnits(record.rule.mount)
  return {
    id: record.id,
    sessionId: record.session_id,
    command: fromUnits(record.command),
    argv: record.argv.map(fromUnits),
    cwd: fromUnits(record.cwd),
    paths: record.paths.map(fromUnits),
    reason: fromUnits(record.reason),
    rule: {
      reason: fromUnits(record.rule.reason),
      commands: record.rule.commands.map(fromUnits),
      paths: record.rule.paths.map(fromUnits),
      ...(mount === '' ? {} : { mount }),
    },
    outcome: record.outcome,
    scope: record.scope,
    note: fromUnits(record.note),
  }
}

export function occurrenceWire(occurrence: Occurrence): RecordFields {
  return {
    parent: occurrence.parent === null ? null : occurrenceWire(occurrence.parent),
    source: units(occurrence.source),
    start: occurrence.start,
    end: occurrence.end,
  }
}

export function occurrenceFromWire(value: unknown): Occurrence {
  const parsed = occurrenceSchema.parse(value)
  return {
    parent: parsed.parent === null ? null : occurrenceFromWire(parsed.parent),
    source: fromUnits(parsed.source),
    start: parsed.start,
    end: parsed.end,
  }
}

export function resolveWire(
  ctx: CommandContext,
  rules: readonly CommandRule[],
  claimant: RecordFields | null,
): RecordFields {
  const rule = rules[0]
  if (rule === undefined) throw new Error('approval resolution needs a rule')
  const record: Decision = {
    id: authorityId(),
    sessionId: ctx.sessionId ?? '',
    command: ctx.command,
    argv: ctx.argv,
    cwd: ctx.cwd,
    paths: ctx.paths.map((path) => path.virtual),
    reason: rule.reason,
    rule,
    outcome: null,
    scope: Scope.ONCE,
    note: '',
  }
  return { op: 'resolve', question: decisionWire(record), rules: rules.map(ruleWire), claimant }
}

export function inspectApproval(ledger: RecordFields, event: RecordFields): ApprovalResult {
  const stream = openStreamSync('policy_decisions', {})
  try {
    const identity = authorityId()
    stream.feed(
      new TextEncoder().encode(
        JSON.stringify({ evaluation: identity, transition: identity, ledger, event }),
      ),
    )
    stream.finish()
    if (stream.request() !== null) throw new Error('approval inspection requested a write')
    return resultSchema.parse(JSON.parse(new TextDecoder().decode(stream.finish())))
  } finally {
    stream.close()
  }
}

export class Decisions extends DecisionOwner {
  private readonly owner = authorityId()
  private readonly memory = new Map<string, RecordFields>()
  private readonly locks = new KeyLock()
  private readonly holders = new WeakMap<HandOff, string>()
  private readonly bindings = new WeakMap<HandOff, ScopeBinding>()
  private readonly terminal = new WeakSet<HandOff>()
  private readonly readers = new Set<HandOff>()
  private readonly versions = new Map<string, number>()

  constructor(
    private readonly sessions: SessionDecisionsQuery | null = null,
    private readonly onAsk: AskHandler | null = null,
    private readonly version: (() => number) | null = null,
  ) {
    super()
  }

  private id(handed: HandOff): string {
    let found = this.holders.get(handed)
    if (found === undefined) {
      found = authorityId()
      this.holders.set(handed, found)
    }
    return found
  }

  private root(handed: HandOff): HandOff {
    let root = handed
    while (root.parent !== null) root = root.parent
    return root
  }

  private binding(sessionId: string, handed: HandOff): ScopeBinding | undefined {
    if (lineage(handed).some((reader) => this.terminal.has(reader)))
      throw new ApprovalUnavailable('stale_holder')
    const bound = this.bindings.get(this.root(handed))
    if (bound !== undefined && bound.sessionId !== sessionId)
      throw new ApprovalUnavailable('session_mismatch')
    return bound
  }

  async begin(sessionId: string, handed: HandOff): Promise<string> {
    let bound = this.binding(sessionId, handed)
    if (bound === undefined) {
      let incarnation: string
      if (this.sessions !== null) incarnation = await this.sessions.activate(sessionId)
      else {
        let state = this.memory.get(sessionId)
        if (state === undefined) {
          state = emptyLedger(authorityId())
          this.memory.set(sessionId, state)
        }
        incarnation = ledgerSchema.parse(state).incarnation
      }
      bound = { sessionId, incarnation }
      this.bindings.set(this.root(handed), bound)
    }
    this.readers.add(handed)
    this.id(handed)
    return bound.incarnation
  }

  private state(sessionId: string): RecordFields {
    if (this.sessions !== null)
      return (
        this.sessions.approvalStateOf(sessionId) ??
        emptyLedger(this.sessions.incarnationOf(sessionId) ?? 'unbound')
      )
    return this.memory.get(sessionId) ?? emptyLedger('unbound')
  }

  private keys(): readonly string[] {
    return this.sessions?.approvalSessions() ?? [...this.memory.keys()]
  }

  list(sessionId = ''): Decision[] {
    const keys = sessionId === '' ? this.keys() : [sessionId]
    return keys.flatMap((key) => ledgerSchema.parse(this.state(key)).records.map(decisionFromWire))
  }

  pending(sessionId = ''): Decision[] {
    return this.list(sessionId).filter((record) => record.outcome === null)
  }

  private project(sessionId: string): void {
    const state = ledgerSchema.parse(this.state(sessionId))
    const records = new Map(state.records.map((record) => [record.id, decisionFromWire(record)]))
    for (const reader of this.readers) {
      const bound = this.bindings.get(this.root(reader))
      if (bound?.sessionId !== sessionId) continue
      const holder = this.id(reader)
      const claims = state.claims
        .filter((claim) => claim.owner === this.owner && claim.holder === holder)
        .map((claim) => {
          const decision = records.get(claim.decision)
          if (decision === undefined) throw new Error('approval claim refers to a missing record')
          return { occurrence: occurrenceFromWire(claim.occurrence), decision }
        })
      reader.claimed.splice(0, reader.claimed.length, ...claims)
    }
  }

  private claimant(claimant: Claimant | null): RecordFields | null {
    return claimant === null
      ? null
      : {
          owner: this.owner,
          holder: this.id(claimant.line),
          lineage: lineage(claimant.line.parent).map((parent) => this.id(parent)),
          occurrence: occurrenceWire(claimant.occurrence),
        }
  }

  private async event(
    sessionId: string,
    event: RecordFields,
    epoch: string,
  ): Promise<ApprovalResult> {
    const revision = this.version?.()
    let result: ApprovalResult
    if (this.sessions !== null)
      result = resultSchema.parse(await this.sessions.approvalEvent(sessionId, event, epoch))
    else
      result = await this.locks.withLock(sessionId, () => {
        const stream = openStreamSync('policy_decisions', {})
        const identity = authorityId()
        try {
          stream.feed(
            new TextEncoder().encode(
              JSON.stringify({
                evaluation: identity,
                transition: identity,
                ledger: this.state(sessionId),
                event,
                expected_incarnation: epoch,
              }),
            ),
          )
          stream.finish()
          const taken = stream.request()
          if (taken !== null) {
            const effect = effectSchema.parse(taken[0])
            if (taken[1].byteLength !== 0) throw new Error('invalid approval storage effect')
            this.memory.set(sessionId, effect.ledger)
            stream.respond(
              {
                evaluation: identity,
                transition: identity,
                effect: 1,
                status: 'committed',
                revision: effect.ledger.revision,
              },
              new Uint8Array(),
            )
          }
          return Promise.resolve(
            resultSchema.parse(JSON.parse(new TextDecoder().decode(stream.finish()))),
          )
        } finally {
          stream.close()
        }
      })
    if (
      revision !== this.version?.() &&
      ['resolve', 'answer', 'validate', 'session_grants'].includes(String(event.op))
    ) {
      await this.event(sessionId, { op: 'invalidate' }, epoch)
      this.versions.set(sessionId, this.version?.() ?? 0)
      throw new ApprovalUnavailable('policy_changed')
    }
    if (result.kind === 'blocked') throw new ApprovalUnavailable(result.status)
    this.project(sessionId)
    return result
  }

  private async checkVersion(sessionId: string, epoch: string): Promise<boolean> {
    const current = this.version?.() ?? 0
    const previous = this.versions.get(sessionId)
    if (previous !== undefined && previous !== current) {
      await this.event(sessionId, { op: 'invalidate' }, epoch)
      this.versions.set(sessionId, current)
      return true
    }
    this.versions.set(sessionId, current)
    return false
  }

  async validate(sessionId: string, handed: HandOff): Promise<void> {
    const epoch = await this.begin(sessionId, handed)
    if (this.sessions !== null) await this.sessions.refreshApproval(sessionId, epoch)
    await this.checkVersion(sessionId, epoch)
    await this.event(
      sessionId,
      {
        op: 'validate',
        owner: this.owner,
        holders: lineage(handed).map((reader) => this.id(reader)),
      },
      epoch,
    )
  }

  async answer(
    decisionId: string,
    outcome: Outcome,
    scope: Scope = Scope.ONCE,
    note = '',
  ): Promise<void> {
    if (outcome === Outcome.ASK) throw new Error('ASK is not an answer')
    if (this.sessions !== null) {
      await this.sessions.ensureLoaded()
      for (const sid of this.keys()) {
        const epoch = this.sessions.incarnationOf(sid)
        if (epoch !== null) await this.sessions.refreshApproval(sid, epoch)
      }
    }
    const record = this.pending().find((item) => item.id === decisionId)
    if (record === undefined) throw new Error(`no decision waiting with id ${decisionId}`)
    const epoch =
      this.sessions === null
        ? ledgerSchema.parse(this.state(record.sessionId)).incarnation
        : this.sessions.incarnationOf(record.sessionId)
    if (epoch === null) throw new ApprovalUnavailable('session_invalid')
    const result = await this.event(
      record.sessionId,
      { op: 'answer', id: decisionId, outcome, scope, note: units(note), claimant: null },
      epoch,
    )
    if (result.kind === 'missing') throw new Error(`no decision waiting with id ${decisionId}`)
  }

  async resolve(
    ctx: CommandContext,
    ask: Ask,
    signal?: AbortSignal,
    claimant: Claimant | null = null,
    recheck?: () => Promise<Deny | Ask | null>,
  ): Promise<Deny | Pending | Abandoned | null> {
    if (hasAborted(signal)) return ABANDONED
    const sessionId = ctx.sessionId ?? ''
    try {
      let epoch: string
      if (claimant !== null) epoch = await this.begin(sessionId, claimant.line)
      else if (this.sessions !== null) {
        await this.sessions.ensureLoaded()
        epoch = this.sessions.incarnationOf(sessionId) ?? (await this.sessions.activate(sessionId))
      } else {
        let state = this.memory.get(sessionId)
        if (state === undefined) {
          state = emptyLedger(authorityId())
          this.memory.set(sessionId, state)
        }
        epoch = ledgerSchema.parse(state).incarnation
      }
      await this.checkVersion(sessionId, epoch)
      for (;;) {
        const rules = ask.rules ?? [askRule(ctx, ask)]
        const result = await this.event(
          sessionId,
          resolveWire(ctx, rules, this.claimant(claimant)),
          epoch,
        )
        if (await this.checkVersion(sessionId, epoch)) {
          if (recheck !== undefined) {
            const current = await recheck()
            if (current?.kind === 'deny') return current
          }
          throw new ApprovalUnavailable('policy_changed')
        }
        if (result.kind === 'allow') return null
        if (result.kind === 'deny') return { kind: 'deny', reason: fromUnits(result.reason) }
        if (result.kind !== 'pending') throw new Error('invalid approval resolution')
        const record = decisionFromWire(result.record)
        const onAsk = this.onAsk
        if (onAsk === null) return { kind: 'pending', id: record.id, reason: record.reason }
        const said = await answered(() => onAsk(record, signal), signal)
        if (isAbandoned(said)) return said
        if (said?.outcome == null) return { kind: 'pending', id: record.id, reason: record.reason }
        if (said.id !== record.id) throw new ApprovalUnavailable('stale_reply')
        if (said.outcome === Outcome.ASK) throw new Error('ASK is not an answer')
        if (hasAborted(signal)) return ABANDONED
        if (this.sessions !== null) await this.sessions.refreshApproval(sessionId, epoch)
        if (await this.checkVersion(sessionId, epoch)) {
          if (recheck !== undefined) {
            const current = await recheck()
            if (current?.kind === 'deny') return current
          }
          throw new ApprovalUnavailable('policy_changed')
        }
        if (recheck !== undefined) {
          const current = await recheck()
          if (current?.kind !== 'ask') {
            if (current === null && claimant !== null) await this.validate(sessionId, claimant.line)
            return current
          }
          ask = current
          const checked = await this.event(
            sessionId,
            resolveWire(ctx, ask.rules ?? [askRule(ctx, ask)], this.claimant(claimant)),
            epoch,
          )
          if (checked.kind === 'allow') return null
          if (checked.kind === 'deny') return { kind: 'deny', reason: fromUnits(checked.reason) }
          if (checked.kind !== 'pending') throw new Error('invalid approval recheck')
          if (checked.record.id !== record.id) continue
        }
        const settled = await this.event(
          sessionId,
          {
            op: 'answer',
            id: record.id,
            outcome: said.outcome,
            scope: said.scope,
            note: units(said.note),
            claimant: this.claimant(claimant),
          },
          epoch,
        )
        if (settled.kind === 'missing') throw new ApprovalUnavailable('stale_reply')
        if (said.outcome === Outcome.DENY) return { kind: 'deny', reason: record.reason }
      }
    } catch (error) {
      if (!(error instanceof ApprovalUnavailable)) throw error
      logger.debug?.(`approval admission refused: ${error.status}`)
      return { kind: 'deny', reason: error.message, failed: true }
    }
  }

  async sessionGrants(
    ctx: CommandContext,
    claimant: Claimant | null = null,
  ): Promise<CommandRule[]> {
    const sessionId = ctx.sessionId ?? ''
    const call = claimant?.line ?? (asyncContextIsolatesTasks ? getOpCall(this, sessionId) : null)
    if (claimant === null && call !== null)
      claimant = {
        line: call,
        occurrence: { parent: call.origin, source: ctx.command, start: 0, end: ctx.command.length },
      }
    let epoch: string
    if (claimant !== null) epoch = await this.begin(sessionId, claimant.line)
    else if (this.sessions !== null) {
      await this.sessions.ensureLoaded()
      epoch = this.sessions.incarnationOf(sessionId) ?? (await this.sessions.activate(sessionId))
    } else {
      if (!this.memory.has(sessionId)) this.memory.set(sessionId, emptyLedger(authorityId()))
      epoch = ledgerSchema.parse(this.state(sessionId)).incarnation
    }
    if (this.sessions !== null) await this.sessions.refreshApproval(sessionId, epoch)
    await this.checkVersion(sessionId, epoch)
    const reader = this.claimant(
      claimant === null
        ? null
        : { ...claimant, occurrence: { parent: null, source: '', start: 0, end: 0 } },
    )
    const result = await this.event(sessionId, { op: 'session_grants', claimant: reader }, epoch)
    if (result.kind !== 'grants') throw new Error('invalid session approval grants')
    return result.rules.map((rule) => ({
      reason: fromUnits(rule.reason),
      commands: rule.commands.map(fromUnits),
      paths: rule.paths.map(fromUnits),
      ...(rule.mount === null || rule.mount.length === 0 ? {} : { mount: fromUnits(rule.mount) }),
    }))
  }

  held(
    ctx: CommandContext,
    ask: Ask,
    claimant: Claimant | null = null,
  ): Promise<Deny | Pending | null> {
    return Promise.resolve().then(() => {
      const rules = ask.rules ?? [askRule(ctx, ask)]
      const result = inspectApproval(this.state(ctx.sessionId ?? ''), {
        ...resolveWire(ctx, rules, this.claimant(claimant)),
        explain: true,
      })
      if (result.kind === 'allow') return null
      if (result.kind === 'deny') return { kind: 'deny', reason: fromUnits(result.reason) }
      if (result.kind === 'blocked')
        return { kind: 'deny', reason: `approval unavailable: ${result.status}`, failed: true }
      if (result.kind !== 'pending') throw new Error('invalid approval inspection')
      const record = decisionFromWire(result.record)
      return { kind: 'pending', id: record.id, reason: record.reason }
    })
  }

  async resolveOp(
    ctx: VfsContext | SessionContext,
    ask: Ask,
    caller?: Caller,
    recheck?: () => Promise<Deny | Ask | null>,
  ): Promise<Deny | Pending | null> {
    const trace = caller === undefined ? explaining() : caller.explaining
    if (trace === DryRun.DECIDING) return this.heldOp(ctx, ask)
    const [asked, keyed] = opQuestion(ctx, ask)
    const sessionId = ctx.sessionId ?? ''
    const call =
      caller !== undefined
        ? callOf(caller, this, sessionId)
        : asyncContextIsolatesTasks
          ? getOpCall(this, sessionId)
          : null
    const claimant: Claimant | null =
      call === null
        ? null
        : {
            line: call,
            occurrence: { parent: null, source: asked.argv[0] ?? '', start: 0, end: 0 },
          }
    const said = await this.resolve(
      asked,
      keyed,
      undefined,
      claimant,
      recheck === undefined
        ? undefined
        : async () => {
            const current = await recheck()
            return current?.kind === 'ask' ? opQuestion(ctx, current)[1] : current
          },
    )
    return said?.kind === 'abandoned' ? { kind: 'deny', reason: ask.reason } : said
  }

  heldOp(ctx: VfsContext | SessionContext, ask: Ask): Promise<Deny | Pending | null> {
    return this.held(...opQuestion(ctx, ask))
  }

  async withinCall<T>(sessionId: string, run: (handed: HandOff) => Promise<T>): Promise<T> {
    const outer = asyncContextIsolatesTasks ? getOpCall(this, sessionId) : null
    if (outer !== null) return run(outer)
    const handed: HandOff = { claimed: [], parent: null, origin: null }
    await this.begin(sessionId, handed)
    try {
      return await runWithOpCall(this, handed, sessionId, () => run(handed))
    } catch (error) {
      if (error instanceof PolicyDenied && isPending(error.refusal))
        await this.release(sessionId, handed)
      throw error
    } finally {
      await this.revoke(sessionId, handed)
    }
  }

  async split(sessionId: string, handed: HandOff, scope: Occurrence): Promise<HandOff> {
    const epoch = await this.begin(sessionId, handed)
    const job: HandOff = { claimed: [], parent: null, origin: handed.origin }
    this.bindings.set(job, { sessionId, incarnation: epoch })
    this.readers.add(job)
    try {
      await this.event(
        sessionId,
        {
          op: 'split',
          owner: this.owner,
          lineage: lineage(handed).map((reader) => this.id(reader)),
          job: this.id(job),
          scope: occurrenceWire(scope),
        },
        epoch,
      )
    } catch (error) {
      this.terminal.add(job)
      try {
        await this.event(
          sessionId,
          { op: 'revoke', owner: this.owner, holder: this.id(job) },
          epoch,
        )
      } catch (cleanup) {
        logger.debug?.(`unconfirmed job approval cleanup: ${String(cleanup)}`)
      } finally {
        this.readers.delete(job)
      }
      throw error
    }
    return job
  }

  async handUp(sessionId: string, handed: HandOff): Promise<void> {
    if (handed.parent === null) throw new Error('a top-level caller has no parent')
    const bound = this.bindings.get(this.root(handed))
    if (bound === undefined) return
    this.readers.add(handed.parent)
    this.terminal.add(handed)
    try {
      await this.event(
        sessionId,
        {
          op: 'hand_up',
          owner: this.owner,
          holder: this.id(handed),
          parent: this.id(handed.parent),
        },
        bound.incarnation,
      )
    } catch (error) {
      if (
        !(error instanceof ApprovalUnavailable) ||
        !['session_replaced', 'session_closed', 'stale_incarnation'].includes(error.status)
      )
        throw error
      logger.debug?.(`retired approval cleanup: ${error.status}`)
      this.project(sessionId)
    } finally {
      this.readers.delete(handed)
    }
  }

  private async end(op: 'release' | 'revoke', sessionId: string, handed: HandOff): Promise<void> {
    const bound = this.bindings.get(this.root(handed))
    if (bound === undefined) return
    this.terminal.add(handed)
    try {
      await this.event(
        sessionId,
        { op, owner: this.owner, holder: this.id(handed) },
        bound.incarnation,
      )
    } catch (error) {
      if (
        !(error instanceof ApprovalUnavailable) ||
        !['session_replaced', 'session_closed', 'stale_incarnation'].includes(error.status)
      )
        throw error
      logger.debug?.(`retired approval cleanup: ${error.status}`)
      this.project(sessionId)
    } finally {
      this.readers.delete(handed)
    }
  }

  async revoke(sessionId: string, handed: HandOff): Promise<void> {
    await this.end('revoke', sessionId, handed)
  }
  async release(sessionId: string, handed: HandOff): Promise<void> {
    await this.end('release', sessionId, handed)
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
 * another session's call. Callers without task isolation must pass an
 * explicit Caller and use callOf instead of inheriting this context.
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
