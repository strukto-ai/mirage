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

import type { JsonValue, Reply } from './types.ts'

export const HOLDS_PATH = '/_kit/holds'

export class HoldsBodyError extends Error {}

// The request a hold caught, as the wait reports it. `route` is the path the
// route declares, `path` the one the client sent, as the request list has
// them. A type rather than an interface so it is a JsonValue as it is.
export type HeldRequest = {
  method: string
  route: string
  path: string
}

// What a release does with the request it lets go: null runs it as it would
// have run, a reply answers it instead.
export type Release = Reply | null

// What a hold catches: a request to one of `routes`, and with a `query` only
// one asked with exactly that query string, '' for none.
export interface HoldPlan {
  routes: { method: string; route: string }[]
  query?: string
}

interface Hold extends HoldPlan {
  caught: HeldRequest | null
  waiters: ((caught: HeldRequest | null) => void)[]
  release: ((how: Release | undefined) => void) | null
}

function isObject(v: JsonValue | undefined): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// What a hold body names: `{"routes": [[method, route], ...]}`, each a route
// this fake declares, so a typo is refused rather than never matching, and an
// optional `query`, the query string a caught request is asked with.
export function parseHoldsBody(
  raw: Buffer,
  declares: (method: string, route: string) => boolean,
): HoldPlan {
  let body: JsonValue
  try {
    body = JSON.parse(raw.toString('utf8')) as JsonValue
  } catch {
    throw new HoldsBodyError('body is not JSON')
  }
  const routes = isObject(body) ? body.routes : undefined
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new HoldsBodyError('routes must be a list of [method, route] pairs')
  }
  const query = isObject(body) ? body.query : undefined
  if (query !== undefined && (typeof query !== 'string' || query.startsWith('?'))) {
    throw new HoldsBodyError('a hold query must be a query string without its ?')
  }
  const named = routes.map((pair) => {
    const [method, route] = Array.isArray(pair) ? pair : []
    if (typeof method !== 'string' || typeof route !== 'string' || !Array.isArray(pair)) {
      throw new HoldsBodyError('routes must be a list of [method, route] pairs')
    }
    const upper = method.toUpperCase()
    if (pair.length !== 2 || !declares(upper, route)) {
      throw new HoldsBodyError(`a hold names no route this fake declares: ${upper} ${route}`)
    }
    return { method: upper, route }
  })
  return query === undefined ? { routes: named } : { routes: named, query }
}

// What a release body asks: an empty body runs the request, `{"status": n}`
// answers it with n instead, and `body` with that body.
export function parseReleaseBody(raw: Buffer): Release {
  if (raw.length === 0) return null
  let body: JsonValue
  try {
    body = JSON.parse(raw.toString('utf8')) as JsonValue
  } catch {
    throw new HoldsBodyError('body is not JSON')
  }
  if (!isObject(body)) throw new HoldsBodyError('a release body is a JSON object')
  const unknown = Object.keys(body).filter((k) => k !== 'status' && k !== 'body')
  if (unknown.length > 0) {
    throw new HoldsBodyError(`unknown release fields: ${unknown.sort().join(', ')}`)
  }
  const { status } = body
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
    throw new HoldsBodyError('a release status must be an integer in [200, 599]')
  }
  return {
    status,
    body: body.body === undefined ? { error: 'injected_fault', status } : body.body,
  }
}

// The holds one TENANT has armed. A hold catches the first request to one of
// its routes that arrives after it is armed, and that request waits, ahead of
// the fault plans, the run's queue and the handler, until the hold is
// released. It is how a test makes a change between a client's lookup and the
// request that acts on it: the held request touches no row and takes no place
// in the queue, so the test's own writes meanwhile run, and the request then
// meets the world they left. They live in TenantState beside the fault plans,
// and a /reset of the tenant, or the run's end, lets every held request go
// unanswered.
export class Holds {
  private next = 1
  private readonly armed = new Map<number, Hold>()

  arm(plan: HoldPlan): number {
    const id = this.next++
    this.armed.set(id, { ...plan, caught: null, waiters: [], release: null })
    return id
  }

  // The wait of a request the earliest armed hold on its route and query
  // catches; null when none does and the request goes on. The wait answers
  // how it is released, and undefined when it is let go unanswered.
  take(
    method: string,
    route: string,
    path: string,
    query: string,
  ): Promise<Release | undefined> | null {
    for (const hold of this.armed.values()) {
      if (hold.caught !== null) continue
      if (!hold.routes.some((r) => r.method === method && r.route === route)) continue
      if (hold.query !== undefined && hold.query !== query) continue
      const caught = { method, route, path }
      hold.caught = caught
      for (const wake of hold.waiters.splice(0)) wake(caught)
      return new Promise((resolve) => {
        hold.release = resolve
      })
    }
    return null
  }

  // The request hold `id` caught, once it has caught one; null when there is
  // no such hold, or it went before catching one.
  caught(id: number): Promise<HeldRequest | null> {
    const hold = this.armed.get(id)
    if (hold === undefined) return Promise.resolve(null)
    if (hold.caught !== null) return Promise.resolve(hold.caught)
    return new Promise((resolve) => hold.waiters.push(resolve))
  }

  // Let hold `id`'s request go as `how` says, or disarm it if it caught none;
  // whether it had caught one, and null when there is no such hold.
  release(id: number, how: Release): boolean | null {
    const hold = this.armed.get(id)
    if (hold === undefined) return null
    this.armed.delete(id)
    for (const wake of hold.waiters.splice(0)) wake(null)
    hold.release?.(how)
    return hold.caught !== null
  }

  // Every hold gone, and every request one held let go unanswered.
  clear(): void {
    for (const hold of this.armed.values()) {
      for (const wake of hold.waiters.splice(0)) wake(null)
      hold.release?.(undefined)
    }
    this.armed.clear()
  }
}
