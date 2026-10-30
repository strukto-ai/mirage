import { z } from 'zod'
import { ApprovalUnavailable } from '../../policy/errors.ts'
import { MountMode } from '../../types.ts'
import { SecretRefSchema } from '../../secrets/config.ts'
import { parseProcessPermissions } from '../../process/config.ts'
import { SessionState } from './session.ts'
import { openStreamSync } from '../../rs/stream.ts'
import { authorityId } from '../../utils/ids.ts'
import type { NamespaceStore } from '../mount/namespace/store.ts'
import { CAS_MAX_RETRIES, generationOf, type RecordFields } from '../record/types.ts'

export const AUTHORITY_FIELDS = [
  'commands',
  'scripts',
  'profile',
  'mount_modes',
  'hidden_paths',
  'shown_paths',
  'hide_reasons',
  'hidden_vars',
  'processes',
  'command_limits',
] satisfies string[]

export const logger: { debug?: (message: string) => void } = {}

const stateSchema = z
  .object({ incarnation: z.string().min(1), revision: z.number().int().nonnegative() })
  .loose()
const effectSchema = z.object({
  op: z.literal('persist_approvals'),
  evaluation: z.string(),
  effect: z.literal(1),
  transition: z.string(),
  ledger: stateSchema,
  approval_required: z.boolean(),
  authority: z.record(z.string(), z.json()).nullable(),
})
const resultSchema = z
  .object({
    kind: z.enum([
      'allow',
      'pending',
      'deny',
      'answered',
      'applied',
      'missing',
      'blocked',
      'rebased',
      'grants',
    ]),
  })
  .loose()

const ruleSchema = z
  .object({
    reason: z.string(),
    commands: z.array(z.string()).optional(),
    paths: z.array(z.string()).optional(),
    mount: z.string().optional(),
  })
  .transform((rule) => ({
    reason: rule.reason,
    ...(rule.commands === undefined ? {} : { commands: rule.commands }),
    ...(rule.paths === undefined ? {} : { paths: rule.paths }),
    ...(rule.mount === undefined ? {} : { mount: rule.mount }),
  }))
const pathScopeSchema = z.object({
  paths: z.array(z.string()).default([]),
  patterns: z.array(z.string()).default([]),
})
const approvalSessionSchema = z.object({
  session_id: z.string(),
  generation: z.number().int().nonnegative().optional(),
  incarnation: z.string().min(1).nullable().optional(),
  approval_state: z.record(z.string(), z.unknown()).nullable().optional(),
  commands: z
    .object({
      allow: z.array(z.string()).nullable(),
      ask: z.array(ruleSchema),
      deny: z.array(ruleSchema),
    })
    .nullable()
    .optional(),
  scripts: z
    .record(
      z.string(),
      z.array(
        z.object({
          profile: z.string(),
          language: z.string(),
          source: z.string(),
          runtime: z.string(),
          config: z.record(z.string(), z.unknown()).default({}),
          env: z.record(z.string(), z.union([z.string(), SecretRefSchema])).default({}),
        }),
      ),
    )
    .nullable()
    .optional(),
  profile: z.string().nullable().optional(),
  mount_modes: z.record(z.string(), z.enum(MountMode)).nullable().optional(),
  hidden_paths: pathScopeSchema.nullable().optional(),
  shown_paths: z
    .object({
      entries: z
        .array(
          z.object({ path: z.string(), mode: z.enum(MountMode).optional() }).transform((entry) => ({
            path: entry.path,
            ...(entry.mode === undefined ? {} : { mode: entry.mode }),
          })),
        )
        .default([]),
    })
    .nullable()
    .optional(),
  hide_reasons: z
    .array(z.object({ patterns: z.array(z.string()).default([]), reason: z.string().default('') }))
    .nullable()
    .optional(),
  hidden_vars: z
    .object({ names: z.array(z.string()).default([]), patterns: z.array(z.string()).default([]) })
    .nullable()
    .optional(),
  command_limits: z.unknown().optional(),
  processes: z.unknown().transform(parseProcessPermissions).optional(),
})

export interface ApprovalReply {
  fields: RecordFields
  result: z.infer<typeof resultSchema>
}

export interface SessionReset {
  fields: RecordFields
  event: RecordFields
  expectedEpoch: string | null
  expectedClosed: string | null
  transition: string
}

export function planReset(
  fields: RecordFields,
  current: RecordFields | null,
  close: boolean,
): SessionReset {
  const payload = structuredClone(fields)
  payload.generation = generationOf(current)
  delete payload.incarnation
  delete payload.approval_state
  return {
    fields: payload,
    event: { op: 'reset', incarnation: authorityId(), closed: close ? authorityId() : null },
    expectedEpoch: current?.incarnation == null ? null : z.string().parse(current.incarnation),
    expectedClosed: current?.closed == null ? null : z.string().parse(current.closed),
    transition: authorityId(),
  }
}

export function authorityFields(fields: RecordFields): RecordFields {
  return Object.fromEntries(AUTHORITY_FIELDS.map((key) => [key, fields[key] ?? null]))
}

export function approvalSession(fields: RecordFields): SessionState {
  const parsed = approvalSessionSchema.parse(fields)
  return SessionState.fromDict({
    session_id: parsed.session_id,
    generation: parsed.generation ?? 0,
    incarnation: parsed.incarnation ?? null,
    approval_state: parsed.approval_state ?? null,
    commands: parsed.commands ?? null,
    scripts: parsed.scripts ?? null,
    profile: parsed.profile ?? null,
    mount_modes: parsed.mount_modes ?? null,
    hidden_paths: parsed.hidden_paths ?? null,
    shown_paths: parsed.shown_paths ?? null,
    hide_reasons: parsed.hide_reasons ?? null,
    hidden_vars: parsed.hidden_vars ?? null,
    command_limits: parsed.command_limits,
    ...(parsed.processes === undefined ? {} : { processes: parsed.processes }),
  })
}

export function approvalEpoch(state: RecordFields | null): string | null {
  return state === null ? null : stateSchema.parse(state).incarnation
}

export function emptyApprovals(incarnation: string | null = null): RecordFields {
  return {
    version: 1,
    incarnation: incarnation ?? authorityId(),
    revision: 0,
    records: [],
    claims: [],
    receipts: [],
    retired: [],
  }
}

export async function transactApprovals(
  store: NamespaceStore,
  baseline: RecordFields,
  event: RecordFields,
  expectedEpoch: string | null,
  expectedClosed: string | null = null,
  transitionId: string | null = null,
): Promise<ApprovalReply> {
  baseline = structuredClone(baseline)
  const sessionId = z.string().parse(baseline.session_id)
  const transition = transitionId ?? authorityId()
  const initial = emptyApprovals(expectedEpoch)
  const ownEpoch = event.op === 'reset' ? z.string().parse(event.incarnation) : initial.incarnation
  let lastError: unknown
  for (let attempt = 0; attempt < CAS_MAX_RETRIES; attempt++) {
    let current = await store.get(sessionId)
    if (current === null) {
      if (generationOf(baseline) > 0 || baseline.approval_state != null)
        throw new ApprovalUnavailable('session_disappeared')
      current = { ...structuredClone(baseline), generation: 0 }
      delete current.approval_state
    }
    const ownReset = event.op === 'reset' && current.incarnation === ownEpoch
    if ((current.closed ?? null) !== expectedClosed && !ownReset)
      throw new ApprovalUnavailable('session_closed')
    if ((current.incarnation ?? null) !== expectedEpoch && current.incarnation !== ownEpoch) {
      throw new ApprovalUnavailable('session_replaced')
    }
    const state = current.approval_state ?? initial
    if (
      current.approval_state != null &&
      stateSchema.parse(state).incarnation !== current.incarnation
    ) {
      throw new ApprovalUnavailable('session_invalid')
    }
    const stream = openStreamSync('policy_decisions', {})
    try {
      stream.feed(
        new TextEncoder().encode(
          JSON.stringify({
            evaluation: transition,
            transition,
            ledger: state,
            event,
            expected_incarnation: current.incarnation ?? null,
            facts: {
              expected: authorityFields(baseline),
              current: authorityFields(current),
            },
          }),
        ),
      )
      stream.finish()
      const taken = stream.request()
      if (taken === null) {
        const result = resultSchema.parse(JSON.parse(new TextDecoder().decode(stream.finish())))
        if (result.kind === 'blocked')
          throw new ApprovalUnavailable(z.string().parse(result.status))
        return { fields: current, result }
      }
      const effect = effectSchema.parse(taken[0])
      if (taken[1].byteLength !== 0) throw new Error('invalid approval storage effect')
      if (effect.approval_required) {
        try {
          await store.approvalGuarantee()
        } catch (error) {
          throw new ApprovalUnavailable('storage_unqualified', { cause: error })
        }
      }
      const fields: RecordFields = {
        ...(['session_write', 'reset'].includes(String(event.op)) ? baseline : current),
        approval_state: effect.ledger,
        incarnation: effect.ledger.incarnation,
        generation: generationOf(current) + 1,
      }
      if (effect.ledger.closed == null) delete fields.closed
      else fields.closed = effect.ledger.closed
      if (effect.authority !== null) {
        for (const [key, value] of Object.entries(effect.authority)) {
          if (value === null) Reflect.deleteProperty(fields, key)
          else fields[key] = value
        }
      }
      delete fields.decisions
      let placed: boolean
      try {
        placed = await store.casSet(sessionId, fields, generationOf(current))
      } catch (error) {
        logger.debug?.(`approval write has an uncertain outcome: ${String(error)}`)
        lastError = error
        continue
      }
      stream.respond(
        {
          evaluation: effect.evaluation,
          effect: effect.effect,
          transition: effect.transition,
          status: placed ? 'committed' : 'conflict',
          revision: effect.ledger.revision,
        },
        new Uint8Array(),
      )
      const result = resultSchema.parse(JSON.parse(new TextDecoder().decode(stream.finish())))
      if (placed) return { fields, result }
    } finally {
      stream.close()
    }
  }
  throw new ApprovalUnavailable('storage_unconfirmed', { cause: lastError })
}
