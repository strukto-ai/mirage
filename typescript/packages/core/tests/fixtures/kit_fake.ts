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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { inject } from 'vitest'

declare module 'vitest' {
  export interface ProvidedContext {
    kitFakeDir: string
  }
}

/** A JSON value, as the kit sends and takes it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

const INTEG = fileURLToPath(new URL('../../../../../integ/', import.meta.url))
const START_MS = 20_000
const SETUP_HEADER = 'X-Kit-Setup'
// A bearer token that names its run and tenant, as integ/README.md's
// credential routing reads one.
const RUN_TOKENS = '^kitrun:(?<run>[^:]+):(?<tenant>[^:]+)$'

/**
 * The bearer token that reaches `tenant` in `run` on a fake `serve` started,
 * for a client whose config takes a bare origin and so cannot carry a run's
 * path.
 */
export function runToken(run: string, tenant: string): string {
  return `kitrun:${run}:${tenant}`
}
// Taken when the module loads, so a test that stubs the global fetch to
// shape what the code under test receives never reshapes its own setup.
const FETCH = globalThis.fetch

/**
 * The origin of `integ/server/<service>/main.ts`, started once a run.
 *
 * The fake is the one the integ battery runs against, on a port of its own.
 * The first test file to ask starts it and every file reads the line it
 * announces; the run's teardown (kit_fake_setup.ts) stops it. It needs
 * `pnpm install` and `pnpm run prisma:clients` in `integ/`. A bearer token
 * of `runToken`'s shape names its run and tenant; any other routes as before.
 */
export async function serve(service: string): Promise<string> {
  const dir = inject('kitFakeDir')
  const announced = join(dir, `${service}.out`)
  try {
    mkdirSync(join(dir, service))
    const child = spawn(
      `${INTEG}node_modules/.bin/tsx`,
      [`${INTEG}server/${service}/main.ts`, '--port', '0'],
      {
        cwd: INTEG,
        env: { ...process.env, MIRAGE_RUN_TOKEN_PATTERN: RUN_TOKENS },
        stdio: ['ignore', openSync(announced, 'w'), 'inherit'],
      },
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

/**
 * One run of a kit fake: a world of its own, reached under `url`.
 *
 * Every request it sends is marked as the test's own setup, so the fake
 * lists, holds and faults only the requests of the code under test.
 */
export class KitRun {
  readonly url: string
  private readonly changes: Promise<void>[] = []
  private readonly stop = new AbortController()

  /**
   * @param origin the fake's origin, as `serve` answers it.
   * @param headers what selects the tenant, as the client under test sends it.
   * @param name the run's name, for a token that must carry it (`runToken`);
   *   a fresh one when left out.
   */
  constructor(
    readonly origin: string,
    private readonly tenantHeaders: Record<string, string>,
    readonly name: string = randomUUID().replaceAll('-', ''),
  ) {
    this.url = `${origin}/_run/${this.name}`
  }

  /** One request to the fake, answered as JSON; null for no body. */
  async call<T = JsonValue>(
    method: string,
    path: string,
    request: RequestOptions = {},
  ): Promise<T> {
    const res = await this.request(method, path, request)
    const text = await res.text()
    if (res.status >= 300) throw new Error(`${method} ${path} -> ${String(res.status)} ${text}`)
    return (text === '' ? null : JSON.parse(text)) as T
  }

  /** One request to the fake, answered as bytes, redirects followed. */
  async read(path: string, method = 'GET', request: RequestOptions = {}): Promise<Uint8Array> {
    const res = await this.request(method, path, request)
    const body = new Uint8Array(await res.arrayBuffer())
    if (res.status >= 300) throw new Error(`${method} ${path} -> ${String(res.status)}`)
    return body
  }

  /** One request to the fake, its response whatever its status. */
  request(
    method: string,
    path: string,
    request: RequestOptions = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    const json = request.json !== undefined
    // Header names have no case, so an override replaces the default
    // rather than joining it.
    const headers = new Headers(this.tenantHeaders)
    headers.set(SETUP_HEADER, '1')
    if (json) headers.set('Content-Type', 'application/json')
    for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name, value)
    return FETCH(this.url + path, {
      method,
      headers,
      ...(json ? { body: JSON.stringify(request.json) } : {}),
      ...(request.body !== undefined
        ? { body: request.body as NonNullable<RequestInit['body']> }
        : {}),
      ...(signal === undefined ? {} : { signal }),
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
    const listed = await this.call<{
      requests: { method: string; route: string; body: JsonValue }[]
    }>('GET', '/_kit/requests')
    return listed.requests
      .filter((r) => r.method === method && r.route === route)
      .map((r) => r.body)
  }

  /**
   * Answer the next `times` requests to `route` with `status`, and `body`
   * when given: bytes are sent as written. A null `status` closes the
   * connection instead. With `path`, only requests to that one path; with
   * `query`, only requests asked with exactly that query string, `''` for
   * none. Each request waits `delayMs` before it is answered.
   */
  async answerNext(
    method: string,
    route: string,
    status: number | null,
    body?: JsonValue | Uint8Array,
    times = 1,
    path?: string,
    query?: string,
    delayMs = 0,
  ): Promise<void> {
    const plan: Record<string, JsonValue> = { method, route, times, delay_ms: delayMs }
    if (status !== null) plan.status = status
    if (path !== undefined) plan.path = path
    if (query !== undefined) plan.query = query
    if (body instanceof Uint8Array) plan.text = new TextDecoder().decode(body)
    else if (body !== undefined) plan.body = body
    await this.call('POST', '/_kit/faults', { json: { plans: [plan] } })
  }

  /** Disarm every answer `answerNext` armed. */
  async clearAnswers(): Promise<void> {
    await this.call('DELETE', '/_kit/faults')
  }

  /**
   * Hold the next request to one of `routes` and run `change` while it
   * waits, then serve it, or answer it with `status`.
   *
   * It is another client's write landing between the lookup the code under
   * test made and the request it acts on, made on purpose.
   *
   * @param routes `[method, route]` pairs, each route as the fake declares it.
   * @param change what happens while the request waits.
   * @param status the status to answer it with instead of serving it.
   * @param query the one query string a held request is asked with, `''`
   *   for none; any when not given.
   */
  async beforeNext(
    routes: [string, string][],
    change: () => unknown,
    status?: number,
    query?: string,
  ): Promise<void> {
    const armed = await this.call<{ hold: number }>('POST', '/_kit/holds', {
      json: query === undefined ? { routes } : { routes, query },
    })
    const hold = `/_kit/holds/${String(armed.hold)}`
    const changed = this.changeWhenHeld(hold, change, status)
    // Handled here so a change that throws is not an unhandled rejection
    // meanwhile; close() throws it.
    changed.catch(() => undefined)
    this.changes.push(changed)
  }

  private async changeWhenHeld(
    hold: string,
    change: () => unknown,
    status: number | undefined,
  ): Promise<void> {
    let caught: Response
    try {
      caught = await this.request('GET', hold, {}, this.stop.signal)
    } catch (err) {
      if (this.stop.signal.aborted) return
      throw err
    }
    await caught.text()
    if (caught.status === 404) return
    let release: JsonValue | undefined = status === undefined ? undefined : { status }
    try {
      await change()
    } catch (err) {
      release = { status: 500 }
      throw err
    } finally {
      await this.call('DELETE', hold, release === undefined ? {} : { json: release })
    }
  }

  /**
   * Run one SQL statement on the run's database, for a stored state no
   * vendor request makes.
   *
   * The run is loaded back from the result, which starts its kit state
   * afresh: a recording of its requests stops.
   */
  async execute(sql: string, ...params: SQLInputValue[]): Promise<void> {
    const ops = `/_kit/runs/${this.name}`
    const snapshot = await this.call<{ [key: string]: JsonValue; db: string }>(
      'GET',
      `${ops}/snapshot`,
    )
    const dir = mkdtempSync(join(tmpdir(), 'kit-run-'))
    try {
      const file = join(dir, 'run.db')
      writeFileSync(file, Buffer.from(snapshot.db, 'base64'))
      const db = new DatabaseSync(file)
      try {
        db.prepare(sql).run(...params)
      } finally {
        db.close()
      }
      snapshot.db = readFileSync(file).toString('base64')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    await this.call('POST', `${ops}/load`, { json: snapshot })
  }

  /** Drop the run and what it holds, and throw what a change threw. */
  async close(): Promise<void> {
    this.stop.abort()
    const done = await Promise.allSettled(this.changes)
    const res = await FETCH(`${this.origin}/_kit/runs/${this.name}`, { method: 'DELETE' })
    if (res.status !== 204) throw new Error(`drop ${this.name} -> ${String(res.status)}`)
    for (const result of done) if (result.status === 'rejected') throw result.reason
  }
}
