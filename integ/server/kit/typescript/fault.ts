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

import { FaultError } from './errors.ts'
import type { JsonValue, Reply } from './types.ts'

export const FAULTS_PATH = '/_kit/faults'

const BODY_FIELDS = new Set(['plans'])
const PLAN_FIELDS = new Set(['method', 'route', 'times', 'status', 'headers', 'body', 'delay_ms'])

// One armed fault: the next `times` requests that match `method` and `route`
// get it instead of their handler. `route` is the path a route DECLARES
// (`/drive/v3/files/:id`), not a request path, so one plan covers every id
// that route serves and a typo'd one is refused on arrival rather than never
// matching. With a `status` the request is answered with it after `delayMs`;
// with none it is never answered at all, and the socket closes after
// `delayMs`: a hang past the client's timeout when that is long, a reset
// connection when it is zero.
export interface FaultPlan {
  method: string
  route: string
  times: number
  status?: number
  headers?: Record<string, string>
  body?: JsonValue
  delayMs: number
}

// One plan as GET and DELETE report it. A type rather than an interface so
// it is a JsonValue as it is.
export type FaultReport = {
  method: string
  route: string
  times: number
  served: number
}

// Node clamps a longer timer to 1ms, which would turn a hang into a reset.
const MAX_DELAY_MS = 2 ** 31 - 1

// What one faulted request gets. `reply` null is the unanswered socket.
export interface FaultHit {
  reply: Reply | null
  delayMs: number
}

// The plans one TENANT has armed, in the order they were armed. They live in
// TenantState beside the clock and the minter for the reason those moved
// there: a fault armed by one host must not fire on another host's requests
// in the same run, and a /reset of a tenant forgets its plans with the rest
// of its world. A spent plan stays listed, so a caller can read back that
// every request it armed for was actually made.
export class Faults {
  private readonly armed: { plan: FaultPlan; served: number }[] = []

  arm(plans: readonly FaultPlan[]): void {
    for (const plan of plans) this.armed.push({ plan, served: 0 })
  }

  // The first unspent plan matching this route, consumed by one; null when
  // none does and the route should run.
  take(method: string, route: string): FaultHit | null {
    for (const entry of this.armed) {
      const { plan } = entry
      if (entry.served >= plan.times || plan.method !== method || plan.route !== route) continue
      entry.served += 1
      if (plan.status === undefined) return { reply: null, delayMs: plan.delayMs }
      const reply: Reply = {
        status: plan.status,
        body: plan.body ?? { error: 'injected_fault', status: plan.status },
      }
      if (plan.headers !== undefined) reply.headers = { ...plan.headers }
      return { reply, delayMs: plan.delayMs }
    }
    return null
  }

  report(): FaultReport[] {
    return this.armed.map(({ plan, served }) => ({
      method: plan.method,
      route: plan.route,
      times: plan.times,
      served,
    }))
  }

  clear(): void {
    this.armed.length = 0
  }
}

function isObject(v: JsonValue | undefined): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function count(v: JsonValue | undefined, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new FaultError(`fault ${field} must be an integer in [${String(min)}, ${String(max)}]`)
  }
  return v
}

function parsePlan(
  raw: JsonValue,
  declares: (method: string, route: string) => boolean,
): FaultPlan {
  if (!isObject(raw)) throw new FaultError('a fault plan must be a JSON object')
  const unknown = Object.keys(raw).filter((k) => !PLAN_FIELDS.has(k))
  if (unknown.length > 0) {
    throw new FaultError(`unknown fault plan fields: ${unknown.sort().join(', ')}`)
  }
  const { method, route, headers, body } = raw
  if (typeof method !== 'string' || method === '') {
    throw new FaultError('fault method must be a string')
  }
  if (typeof route !== 'string' || route === '')
    throw new FaultError('fault route must be a string')
  const upper = method.toUpperCase()
  if (!declares(upper, route)) {
    throw new FaultError(`fault names no route this fake declares: ${upper} ${route}`)
  }
  const plan: FaultPlan = {
    method: upper,
    route,
    times: raw.times === undefined ? 1 : count(raw.times, 'times', 1, Number.MAX_SAFE_INTEGER),
    delayMs: raw.delay_ms === undefined ? 0 : count(raw.delay_ms, 'delay_ms', 0, MAX_DELAY_MS),
  }
  if (raw.status !== undefined) plan.status = count(raw.status, 'status', 100, 599)
  if (plan.status === undefined && raw.delay_ms === undefined) {
    throw new FaultError('a fault plan needs a status, a delay_ms, or both')
  }
  if (headers !== undefined) {
    if (!isObject(headers) || !Object.values(headers).every((h) => typeof h === 'string')) {
      throw new FaultError('fault headers must map names to strings')
    }
    plan.headers = headers as Record<string, string>
  }
  if (body !== undefined) {
    if (plan.status === undefined) throw new FaultError('a fault body needs a status to carry it')
    plan.body = body
  }
  return plan
}

// `declares` is the fake's router, asked whether a route exists. An unknown
// field, a plan that cannot fire, or a route nothing serves is the caller's
// mistake and is refused whole, so a half-armed list never runs.
export function parseFaultBody(
  raw: JsonValue,
  declares: (method: string, route: string) => boolean,
): FaultPlan[] {
  if (!isObject(raw)) throw new FaultError('faults body must be a JSON object')
  const unknown = Object.keys(raw).filter((k) => !BODY_FIELDS.has(k))
  if (unknown.length > 0)
    throw new FaultError(`unknown faults fields: ${unknown.sort().join(', ')}`)
  const { plans } = raw
  if (!Array.isArray(plans)) throw new FaultError('faults plans must be a list')
  return plans.map((p) => parsePlan(p, declares))
}
