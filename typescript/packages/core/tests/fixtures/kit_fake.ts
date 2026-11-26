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

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { inject } from 'vitest'
import type { JsonValue } from '../../src/types.ts'

const INTEG = fileURLToPath(new URL('../../../../../integ/', import.meta.url))
const START_MS = 20_000

/**
 * The origin of `integ/server/<service>/main.ts`, started once a run.
 *
 * The fake is the one the integ battery runs against, on a port of its own.
 * The first test file to ask starts it and every file reads the line it
 * announces; the run's teardown (kit_fake_setup.ts) stops it. It needs
 * `pnpm install` and `pnpm run prisma:clients` in `integ/`.
 */
export async function serve(service: string): Promise<string> {
  const dir = inject('kitFakeDir')
  const announced = join(dir, `${service}.out`)
  try {
    mkdirSync(join(dir, service))
    const child = spawn(
      `${INTEG}node_modules/.bin/tsx`,
      [`${INTEG}server/${service}/main.ts`, '--port', '0'],
      { cwd: INTEG, stdio: ['ignore', openSync(announced, 'w'), 'inherit'] },
    )
    writeFileSync(join(dir, `${service}.pid`), String(child.pid))
    child.unref()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const name = `${service.toUpperCase().replaceAll('-', '_')}_URL=`
  const until = Date.now() + START_MS
  while (Date.now() < until) {
    const line = existsSync(announced) ? readFileSync(announced, 'utf8') : ''
    if (line.startsWith(name) && line.includes('\n')) {
      return line.slice(name.length, line.indexOf('\n')).replace(/\/+$/, '')
    }
    await delay(10)
  }
  throw new Error(
    `${service} fake did not start; run pnpm install and pnpm run prisma:clients in integ/`,
  )
}

/** What one request to the fake sends beyond its method and path. */
interface RequestOptions {
  json?: JsonValue
  body?: FormData | Uint8Array
  headers?: Record<string, string>
}

/** One run of a kit fake: a world of its own, reached under `url`. */
export class KitRun {
  readonly name = randomUUID().replaceAll('-', '')
  readonly url: string

  /**
   * @param origin the fake's origin, as `serve` answers it.
   * @param headers what selects the tenant, as the client under test sends it.
   */
  constructor(
    readonly origin: string,
    private readonly tenantHeaders: Record<string, string>,
  ) {
    this.url = `${origin}/_run/${this.name}`
  }

  /** One request to the fake, answered as JSON; null for no body. */
  async call<T = JsonValue>(
    method: string,
    path: string,
    request: RequestOptions = {},
  ): Promise<T> {
    const res = await this.send(method, path, request)
    const text = await res.text()
    if (res.status >= 300) throw new Error(`${method} ${path} -> ${String(res.status)} ${text}`)
    return (text === '' ? null : JSON.parse(text)) as T
  }

  /** One request to the fake, answered as bytes, redirects followed. */
  async read(path: string, method = 'GET', request: RequestOptions = {}): Promise<Uint8Array> {
    const res = await this.send(method, path, request)
    const body = new Uint8Array(await res.arrayBuffer())
    if (res.status >= 300) throw new Error(`${method} ${path} -> ${String(res.status)}`)
    return body
  }

  private send(method: string, path: string, request: RequestOptions): Promise<Response> {
    const json = request.json !== undefined
    return fetch(this.url + path, {
      method,
      headers: {
        ...this.tenantHeaders,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...request.headers,
      },
      ...(json ? { body: JSON.stringify(request.json) } : {}),
      ...(request.body !== undefined ? { body: request.body as BodyInit } : {}),
    })
  }

  /** Start listing the tenant's requests, emptying an earlier list, keeping `headers`. */
  async recordRequests(...headers: string[]): Promise<void> {
    await this.call('POST', '/_kit/requests', { json: { headers } })
  }

  /**
   * The requests made since the last `recordRequests`, as `METHOD path` and
   * then `name=value` for each kept header a request carried.
   */
  async requests(): Promise<string[]> {
    const listed = await this.call<{
      requests: { method: string; path: string; headers: Record<string, string> }[]
    }>('GET', '/_kit/requests')
    return listed.requests.map((r) =>
      [r.method, r.path, ...Object.entries(r.headers).map(([k, v]) => `${k}=${v}`)].join(' '),
    )
  }

  /** The query of each listed request to `route`, in order. */
  async params(method: string, route: string): Promise<Record<string, string>[]> {
    const listed = await this.call<{
      requests: { method: string; route: string; query: string }[]
    }>('GET', '/_kit/requests')
    return listed.requests
      .filter((r) => r.method === method && r.route === route)
      .map((r) => Object.fromEntries(new URLSearchParams(r.query)))
  }

  /** The kept headers of each listed request to `route`, in order. */
  async headers(method: string, route: string): Promise<Record<string, string>[]> {
    const listed = await this.call<{
      requests: { method: string; route: string; headers: Record<string, string> }[]
    }>('GET', '/_kit/requests')
    return listed.requests
      .filter((r) => r.method === method && r.route === route)
      .map((r) => r.headers)
  }

  /** The JSON body of each listed request to `route`, in order. */
  async bodies(method: string, route: string): Promise<JsonValue[]> {
    const listed = await this.call<{ requests: { method: string; route: string; body: JsonValue }[] }>(
      'GET',
      '/_kit/requests',
    )
    return listed.requests.filter((r) => r.method === method && r.route === route).map((r) => r.body)
  }

  /** Answer the next `times` requests to `route` with `status`, and `body` when given. */
  async answerNext(
    method: string,
    route: string,
    status: number,
    body?: JsonValue,
    times = 1,
  ): Promise<void> {
    const plan: Record<string, JsonValue> = { method, route, status, times }
    if (body !== undefined) plan.body = body
    await this.call('POST', '/_kit/faults', { json: { plans: [plan] } })
  }

  /** Drop the run and what it holds. */
  async close(): Promise<void> {
    const res = await fetch(`${this.origin}/_kit/runs/${this.name}`, { method: 'DELETE' })
    if (res.status !== 204) throw new Error(`drop ${this.name} -> ${String(res.status)}`)
  }
}
