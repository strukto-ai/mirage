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
import type { util } from 'zod'
import { Limit, type LimitInit, OnExceed } from '../types.ts'
import { units } from '../rs/policy.ts'
import { openStreamSync, type OpenStream } from '../rs/stream.ts'
import { StreamRefusal } from '../rs/errors.ts'
import { askRule, sameRule } from './decisions.ts'
import { PolicyError } from './errors.ts'
import type {
  Ask,
  CommandRule,
  Deny,
  Route,
  CommandContext,
  RouteContext,
  VfsContext,
  SessionContext,
} from './types.ts'

type Answer = Deny | Ask | Route
type Context = CommandContext | RouteContext | VfsContext | SessionContext
export const PACKET_BYTES = 8 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()
let sequence = 0
const resultSchema = z.object({
  answers: z.array(z.number().int().nonnegative()),
  action: z.number().int().nonnegative().nullable(),
  ask_rules: z.array(z.number().int().nonnegative()).nullable(),
  route: z.number().int().nonnegative().nullable(),
  conflict: z.array(z.number().int().nonnegative()),
  limit: z
    .object({
      max_bytes: z
        .union([z.number(), z.string().transform(Number)])
        .nullable()
        .optional(),
      max_lines: z
        .union([z.number(), z.string().transform(Number)])
        .nullable()
        .optional(),
      timeout_seconds: z.number().nullable().optional(),
      walk_limit: z
        .union([z.number(), z.string().transform(Number)])
        .nullable()
        .optional(),
      on_exceed: z.enum(OnExceed).nullable().optional(),
    })
    .nullable(),
  invalid: z
    .object({ action: z.number(), slot: z.number(), legal: z.array(z.string()) })
    .nullable(),
})
const effectSchema = (() => {
  const identity = { evaluation: z.string(), effect: z.number().int() }
  return z.discriminatedUnion('op', [
    z.object({
      ...identity,
      op: z.enum(['run_policy', 'read_action', 'read_settlement_action']),
      slot: z.number().int(),
    }),
    z.object({
      ...identity,
      op: z.literal('read_ask_rules'),
      first: z.number().int(),
      next: z.number().int(),
    }),
    z.object({
      ...identity,
      op: z.literal('replace_ask_rules'),
      action: z.number().int(),
      rules: z.array(z.number().int()),
    }),
    z.object({
      ...identity,
      op: z.literal('read_final_values'),
      routes: z.array(z.number().int()),
      limits: z.array(z.number().int()),
    }),
  ])
})()
const limitFields = {
  maxBytes: 'max_bytes',
  maxLines: 'max_lines',
  timeoutSeconds: 'timeout_seconds',
  walkLimit: 'walk_limit',
  onExceed: 'on_exceed',
} as const

function isAnswer(value: unknown): value is Answer {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value.kind === 'deny' || value.kind === 'ask' || value.kind === 'route')
  )
}

export interface CompositionResult {
  answers: Answer[]
  action: Deny | Ask | null
  route: Route | null
  limit: Limit | null
}

export class Composition {
  readonly stream: OpenStream = openStreamSync('policy_compose', {})
  readonly evaluation = `evaluation-${String(++sequence)}`
  private readonly actions: unknown[] = []
  private readonly originals: unknown[] = []
  private readonly rules: CommandRule[] = []
  readonly names = new Map<number, string>()

  constructor(private readonly settlement: readonly Answer[] | null = null) {
    if (settlement !== null) this.actions.push(...settlement)
  }

  static packet(value: Record<string, util.JSONType>): Uint8Array {
    const data = encoder.encode(JSON.stringify(value))
    if (data.byteLength > PACKET_BYTES)
      throw new StreamRefusal('policy composition packet limit exceeded', new Uint8Array())
    return data
  }

  feed(value: Record<string, util.JSONType>): void {
    this.stream.feed(Composition.packet(value))
  }

  private ruleId(rule: CommandRule): number {
    const index = this.rules.findIndex((entry) => sameRule(entry, rule))
    if (index >= 0) return index
    this.rules.push(rule)
    return this.rules.length - 1
  }

  descriptors(answered: unknown, name: string): util.JSONType[] {
    const descriptors: util.JSONType[] = []
    for (const value of Array.isArray(answered) ? answered : [answered]) {
      if (value === null) continue
      const index = this.actions.length
      this.actions.push(value)
      this.originals.push(value)
      let descriptor: Record<string, util.JSONType> = { kind: 'invalid', action: index }
      if (value instanceof Limit) {
        descriptor = { kind: 'limit', action: index }
      } else if (isAnswer(value)) {
        const action =
          name !== '' && (value.policy === undefined || value.policy === '')
            ? { ...value, policy: name }
            : value
        this.actions[index] = action
        descriptor = { kind: action.kind, action: index }
      }
      descriptors.push(descriptor)
    }
    return descriptors
  }

  request(): z.infer<typeof effectSchema> | null {
    const requested = this.stream.request()
    return requested === null ? null : effectSchema.parse(requested[0])
  }

  respond(
    effect: z.infer<typeof effectSchema>,
    answered: unknown,
    name: string,
    more: boolean,
  ): void {
    const value = {
      evaluation: this.evaluation,
      effect: effect.effect,
      actions: this.descriptors([answered], name),
      more,
    }
    Composition.packet(value)
    this.stream.respond(value, new Uint8Array())
  }

  respondEffect(effect: z.infer<typeof effectSchema>, ctx?: Context): boolean {
    const identity = { evaluation: this.evaluation, effect: effect.effect }
    let response: Record<string, util.JSONType>
    switch (effect.op) {
      case 'read_settlement_action': {
        const action = this.actions[effect.slot]
        const kind =
          typeof action === 'object' && action !== null && 'kind' in action
            ? action.kind
            : 'invalid'
        response = {
          ...identity,
          actions: [{ kind: typeof kind === 'string' ? kind : 'invalid', action: effect.slot }],
        }
        break
      }
      case 'read_ask_rules': {
        const first = this.answer(effect.first)
        const next = this.originals[effect.next]
        if (!isAnswer(next)) throw new Error('invalid policy ask reference')
        if (first.kind !== 'ask' || next.kind !== 'ask' || ctx === undefined)
          throw new Error('invalid policy ask reference')
        this.rules.length = 0
        const firstRules = first.rules ?? [askRule(ctx, first)]
        const nextRules = next.rules ?? [askRule(ctx, next)]
        response = {
          ...identity,
          first_rules: firstRules.map((rule) => this.ruleId(rule)),
          next_rules: nextRules.map((rule) => this.ruleId(rule)),
          same_ask: false,
        }
        break
      }
      case 'replace_ask_rules': {
        const action = this.answer(effect.action)
        if (action.kind !== 'ask') throw new Error('invalid policy ask reference')
        const rules = effect.rules.map((index) => {
          const rule = this.rules[index]
          if (rule === undefined) throw new Error('invalid policy rule reference')
          return rule
        })
        this.actions[effect.action] = { ...action, rules }
        response = identity
        break
      }
      case 'read_final_values': {
        const routes = effect.routes.map((index) => {
          const action = this.settlement?.[index] ?? this.answer(index)
          if (!('runtime' in action)) throw new Error('invalid policy route reference')
          return { action: index, runtime: units(action.runtime) }
        })
        const sources = effect.limits.map((index) => {
          const limit = this.actions[index]
          if (!(limit instanceof Limit)) throw new Error('invalid policy limit reference')
          return limit
        })
        const fieldsSet = new Set(sources.flatMap((limit) => [...limit.fieldsSet]))
        const limits = sources.map((action, position) => {
          const index = effect.limits[position]
          if (index === undefined) throw new Error('invalid policy limit reference')
          const fields: Record<string, util.JSONType> = {}
          for (const key of fieldsSet) {
            const value = action[key]
            fields[limitFields[key]] =
              typeof value === 'number' && key !== 'timeoutSeconds'
                ? BigInt(value).toString()
                : value
          }
          return { action: index, value: fields }
        })
        response = { ...identity, routes, limits }
        break
      }
      default:
        return false
    }
    Composition.packet(response)
    this.stream.respond(response, new Uint8Array())
    return true
  }

  private answer(index: number): Answer {
    const value = this.actions[index]
    if (!isAnswer(value)) throw new Error('invalid policy action reference')
    return value
  }

  settlementResult(): Answer | null {
    if (this.settlement === null) throw new Error('missing settlement inputs')
    const result = resultSchema.parse(JSON.parse(decoder.decode(this.stream.finish())))
    if (result.conflict.length > 0) {
      const routes = result.conflict.map((index) => {
        const route = this.settlement?.[index]
        if (route === undefined || !('runtime' in route))
          throw new Error('invalid policy route reference')
        return route
      })
      return {
        kind: 'deny',
        reason: `policies place the line on different runtimes: ${routes.map((r) => `${r.policy ?? ''} on ${r.runtime}`).join(', ')}`,
        policy: [...new Set(routes.map((r) => r.policy ?? ''))].join(', '),
      }
    }
    const index = result.action ?? result.route
    if (index === null) return null
    const action = this.settlement[index]
    if (action === undefined) throw new Error('invalid policy action reference')
    return action
  }

  result(method = ''): CompositionResult {
    const result = resultSchema.parse(JSON.parse(decoder.decode(this.stream.finish())))
    if (result.invalid !== null) {
      const { action, slot, legal } = result.invalid
      throw new PolicyError(
        `${method} of ${this.names.get(slot) ?? ''} returned ${JSON.stringify(this.actions[action])}; ` +
          `legal kinds here: ${[...legal].sort((a, b) => (a === 'deny' ? -1 : b === 'deny' ? 1 : 0)).join(', ')}`,
      )
    }
    const answers = result.answers.map((index) => this.answer(index))
    const selected = result.action === null ? null : this.answer(result.action)
    let action = selected?.kind === 'route' ? null : selected
    const route =
      selected?.kind === 'route'
        ? selected
        : result.route === null
          ? null
          : this.answer(result.route)
    if (route !== null && route.kind !== 'route') throw new Error('invalid policy route reference')
    if (result.conflict.length > 0) {
      const routes = result.conflict.map((index) => {
        const answer = this.answer(index)
        if (answer.kind !== 'route') throw new Error('invalid policy route reference')
        return answer
      })
      action = {
        kind: 'deny',
        reason: `policies place the line on different runtimes: ${routes.map((r) => `${r.policy ?? ''} on ${r.runtime}`).join(', ')}`,
        policy: [...new Set(routes.map((r) => r.policy ?? ''))].join(', '),
      }
    }
    let limit: Limit | null = null
    if (result.limit !== null) {
      const init: LimitInit = {}
      for (const [key, field] of Object.entries(limitFields)) {
        if (field in result.limit) Object.assign(init, { [key]: result.limit[field] })
      }
      limit = new Limit(init)
    }
    return { answers, action, route, limit }
  }

  close(): void {
    this.stream.cancel()
    this.stream.close()
  }
}

export function composeSettled(answers: readonly Route[], mode: 'agreed'): Deny | Route | null
export function composeSettled(answers: readonly Answer[], mode: 'settled'): Answer | null
export function composeSettled(
  answers: readonly Answer[],
  mode: 'settled' | 'agreed',
): Answer | null {
  if (answers.length === 0) return null
  const composition = new Composition(answers)
  try {
    composition.feed({
      op: 'settle',
      mode,
      evaluation: composition.evaluation,
      count: answers.length,
    })
    composition.stream.finish()
    for (let effect = composition.request(); effect !== null; effect = composition.request()) {
      if (!composition.respondEffect(effect)) throw new Error('invalid settlement effect')
    }
    return composition.settlementResult()
  } finally {
    composition.close()
  }
}
