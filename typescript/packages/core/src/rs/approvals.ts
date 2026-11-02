import { z } from 'zod'
import type {
  Claim,
  Claimant,
  CommandRule,
  Decision,
  HandOff,
  Occurrence,
  Outcome,
} from '../policy/types.ts'
import { units } from './document.ts'
import { admissionMatcher, ruleWire, type Wire } from './policy.ts'

const key = z.number().int().nonnegative()

/** Decode one stateless approval result from the shared policy stream. */
export function approvalQuery<T>(query: Wire, result: z.ZodType<T>): T {
  return result.parse(admissionMatcher(null).ask('approvals', { query }))
}

/** One existing record, with an invocation-local identity distinct from its public id. */
export function recordWire(record: Decision, key: number): Wire {
  return {
    key,
    id: units(record.id),
    command: units(record.command),
    argv: record.argv.map(units),
    cwd: units(record.cwd),
    rule: ruleWire(record.rule),
    outcome: record.outcome,
    scope: record.scope,
  }
}

/** One occurrence node; parents travel as keys so depth does not become JSON nesting. */
export function occurrenceWire(occurrence: Occurrence, key: number, parent: number | null): Wire {
  return {
    key,
    parent,
    source: units(occurrence.source),
    start: occurrence.start,
    end: occurrence.end,
  }
}

/** Mechanical identity transport for a synchronous Rust approval query. */
export class ApprovalSnapshot {
  private static readonly RESPONSE = {
    keys: z.array(key),
    plan: z
      .object({
        answers: z.array(key.nullable()),
        denied: key.nullable(),
        missing: z.array(key),
        once: z.array(key),
        waiting: z.array(key.nullable()),
        claim: z
          .object({ records: z.array(key), live: z.array(key) })
          .strict()
          .nullable(),
      })
      .strict(),
    claim: z.object({ records: z.array(key), live: z.array(key) }).strict(),
    handUp: z.object({ parent: key, claims: z.array(key), live: z.array(key) }).strict(),
  }

  readonly recordObjects: Decision[]
  readonly holderObjects: HandOff[] = []
  readonly claimObjects: Claim[] = []
  readonly occurrenceObjects: Occurrence[] = []
  private readonly recordKeys: Map<Decision, number>
  private readonly holderKeys = new Map<HandOff, number>()
  private readonly claimKeys = new Map<Claim, number>()
  private readonly occurrenceKeys = new Map<Occurrence, number>()
  private readonly live: readonly HandOff[]

  constructor(
    private readonly records: readonly Decision[] = [],
    live: Iterable<HandOff> = [],
    roots: readonly HandOff[] = [],
  ) {
    this.recordObjects = []
    this.recordKeys = new Map()
    this.live = [...live]
    for (const record of records) this.recordKey(record)
    for (const holder of [...this.live, ...roots]) this.holderKey(holder)
  }

  recordKey(record: Decision): number {
    const found = this.recordKeys.get(record)
    if (found !== undefined) return found
    const key = this.recordObjects.length
    this.recordObjects.push(record)
    this.recordKeys.set(record, key)
    return key
  }

  holderKey(holder: HandOff): number {
    let node: HandOff | null = holder
    while (node !== null && !this.holderKeys.has(node)) {
      this.holderKeys.set(node, this.holderObjects.length)
      this.holderObjects.push(node)
      for (const claim of node.claimed) {
        if (!this.claimKeys.has(claim)) {
          this.claimKeys.set(claim, this.claimObjects.length)
          this.claimObjects.push(claim)
          this.recordKey(claim.decision)
          this.occurrenceKey(claim.occurrence)
        }
      }
      node = node.parent
    }
    const found = this.holderKeys.get(holder)
    if (found === undefined) throw new Error('approval holder was not registered')
    return found
  }

  occurrenceKey(occurrence: Occurrence | null): number | null {
    if (occurrence === null) return null
    let node: Occurrence | null = occurrence
    while (node !== null && !this.occurrenceKeys.has(node)) {
      this.occurrenceKeys.set(node, this.occurrenceObjects.length)
      this.occurrenceObjects.push(node)
      node = node.parent
    }
    const found = this.occurrenceKeys.get(occurrence)
    if (found === undefined) throw new Error('approval occurrence was not registered')
    return found
  }

  record(key: number): Decision {
    const record = this.recordObjects[key]
    if (record === undefined) throw new Error('approval returned an unknown record')
    return record
  }

  holder(key: number): HandOff {
    const holder = this.holderObjects[key]
    if (holder === undefined) throw new Error('approval returned an unknown holder')
    return holder
  }

  private originalClaim(key: number): Claim {
    const claim = this.claimObjects[key]
    if (claim === undefined) throw new Error('approval returned an unknown claim')
    return claim
  }

  get wire(): Wire {
    return {
      records: this.records.map((record) => recordWire(record, this.recordKey(record))),
      holders: this.holderObjects.map((holder, key) => ({
        key,
        parent: holder.parent === null ? null : this.holderKey(holder.parent),
        claims: holder.claimed.map((claim) => {
          const key = this.claimKeys.get(claim)
          if (key === undefined) throw new Error('approval claim was not registered')
          return key
        }),
      })),
      claims: this.claimObjects.map((claim, key) => ({
        key,
        record: this.recordKey(claim.decision),
        occurrence: this.occurrenceKey(claim.occurrence),
      })),
      occurrences: this.occurrenceObjects.map((occurrence, key) =>
        occurrenceWire(occurrence, key, this.occurrenceKey(occurrence.parent)),
      ),
      live: this.live.map((holder) => this.holderKey(holder)),
    }
  }

  plan(
    rules: readonly CommandRule[],
    argv: readonly string[],
    cwd: string,
    claimant: Claimant | null,
  ) {
    const reader =
      claimant === null
        ? null
        : {
            holder: this.holderKey(claimant.line),
            occurrence: this.occurrenceKey(claimant.occurrence),
          }
    const query = {
      kind: 'plan',
      state: this.wire,
      rules: rules.map(ruleWire),
      argv: argv.map(units),
      cwd: units(cwd),
      claimant: reader,
    } satisfies Wire
    const result = approvalQuery(query, ApprovalSnapshot.RESPONSE.plan)
    return {
      answers: result.answers.map((key) => (key === null ? null : this.record(key))),
      denied: result.denied,
      missing: result.missing,
      once: result.once.map((key) => this.record(key)),
      waiting: result.waiting.map((key) => (key === null ? null : this.record(key))),
      claim:
        result.claim === null
          ? null
          : {
              records: result.claim.records.map((key) => this.record(key)),
              live: result.claim.live.map((key) => this.holder(key)),
            },
    }
  }

  waiting(rule: CommandRule, argv: readonly string[], cwd: string): Decision | null {
    const found = approvalQuery(
      {
        kind: 'waiting',
        records: this.wire.records ?? [],
        rule: ruleWire(rule),
        argv: argv.map(units),
        cwd: units(cwd),
      },
      key.nullable(),
    )
    return found === null ? null : this.record(found)
  }

  answer(id: string, outcome: Outcome): Decision | null {
    const found = approvalQuery(
      { kind: 'answer', records: this.wire.records ?? [], id: units(id), outcome },
      key.nullable(),
    )
    return found === null ? null : this.record(found)
  }

  claim(holder: HandOff, records: readonly Decision[]) {
    const owner = this.holderKey(holder)
    const recordKeys = records.map((record) => this.recordKey(record))
    const result = approvalQuery(
      { kind: 'claim', state: this.wire, holder: owner, records: recordKeys },
      ApprovalSnapshot.RESPONSE.claim,
    )
    return {
      records: result.records.map((key) => this.record(key)),
      live: result.live.map((key) => this.holder(key)),
    }
  }

  split(holder: HandOff, scope: Occurrence): Claim[] {
    const owner = this.holderKey(holder)
    const occurrence = this.occurrenceKey(scope)
    return approvalQuery(
      { kind: 'split', state: this.wire, holder: owner, scope: occurrence },
      ApprovalSnapshot.RESPONSE.keys,
    ).map((key) => this.originalClaim(key))
  }

  handUp(holder: HandOff) {
    const owner = this.holderKey(holder)
    const result = approvalQuery(
      { kind: 'hand_up', state: this.wire, holder: owner },
      ApprovalSnapshot.RESPONSE.handUp,
    )
    return {
      parent: this.holder(result.parent),
      claims: result.claims.map((key) => this.originalClaim(key)),
      live: result.live.map((key) => this.holder(key)),
    }
  }

  revoke(holder: HandOff): Decision[] {
    const owner = this.holderKey(holder)
    return approvalQuery(
      { kind: 'revoke', state: this.wire, holder: owner },
      ApprovalSnapshot.RESPONSE.keys,
    ).map((key) => this.record(key))
  }
}
