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

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { makePool, makeState } from './base.ts'
import type { Fake, Runtime, RunState } from './base.ts'
import type { MinimalClient } from './db.ts'
import { FaultError, FixtureError, KitError, ResetBodyError, TenantError } from './errors.ts'
import { FAULTS_PATH, parseFaultBody } from './fault.ts'
import type { Faults } from './fault.ts'
import { Router } from './route.ts'
import type { Ctx } from './route.ts'
import { DEFAULT_FIXTURE, DEFAULT_FIXTURE_ROOT } from './fixture.ts'
import { applyReset, defaultTenantsOf, parseResetBody, withPathRun } from './reset.ts'
import { checkName, DEFAULT_RUN, RUN_PREFIX, resolveIdentity, splitRunPath } from './tenant.ts'
import type { Headers } from './tenant.ts'
import { unrouted } from './unrouted.ts'
import type { JsonValue, Reply } from './types.ts'

export const HEALTH_PATH = '/_kit/health'
export const RESET_PATH = '/reset'

// How long an idle keep-alive socket stays open, and the one number in this
// file that is about the CLIENTS rather than the vendor being imitated. Node's
// default is 5s (the socket actually closes a second after that). The python
// host rides every backend on one aiohttp pool, which reuses a socket idle for
// up to 15s and never reads the timeout a server advertises, so a run of
// shell-only cases left the dropbox pool idle and the next request was written
// onto a socket node was closing at that very instant. aiohttp re-sends such a
// request only when the method is idempotent, and dropbox posts every read, so
// `grep -rl` died in CI with `Server disconnected`. Holding the socket well past
// the pool's reuse window is what a vendor's edge does too; undici, the
// TypeScript host's client, reads the advertised value and stays under it
// either way. Pinned by the kit selftest.
export const KEEP_ALIVE_TIMEOUT_MS = 60_000

export function makeRuntime<C extends MinimalClient>(
  fake: Fake<C>,
  fixtureRoot: string = DEFAULT_FIXTURE_ROOT,
  fixture: string = DEFAULT_FIXTURE,
): Runtime<C> {
  const pool = makePool(fake)
  const router = new Router<C>(fake.routes())
  const states = new Map<string, RunState>()
  const state = (run: string): RunState => {
    const live = states.get(run)
    if (live !== undefined) return live
    const made = makeState(fake)
    states.set(run, made)
    return made
  }
  const fixtures = new Map<string, string>()
  return {
    fake,
    pool,
    router,
    fixtureRoot,
    state,
    reset: (body: JsonValue) =>
      router.enqueue(runOfReset(body), async () => {
        const req = parseResetBody(
          body,
          defaultTenantsOf(fake),
          fixtures.get(runOfReset(body)) ?? fixture,
        )
        const out = await applyReset(fake, pool, state, req, fixtureRoot)
        fixtures.set(req.run, req.fixture)
        return out
      }),
    drop: (run: string) => {
      checkName('run', run)
      return router.enqueue(run, async () => {
        await pool.drop(run)
        states.delete(run)
        fixtures.delete(run)
      })
    },
    dispose: async () => {
      await router.drain()
      states.clear()
      fixtures.clear()
      await pool.dispose()
    },
  }
}

// The reset's target run is read before validation so the queue key exists even
// for a body that parseResetBody will reject; an invalid body is a 400 that
// still must not jump the queue.
function runOfReset(body: JsonValue): string {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const named = (body as Record<string, JsonValue>).run
    if (typeof named === 'string' && named !== '') return named
  }
  return DEFAULT_RUN
}

export function parseBody(raw: Buffer): JsonValue {
  if (raw.length === 0) return {}
  return JSON.parse(raw.toString('utf8')) as JsonValue
}

// /reset reads its body itself rather than through parseBody, because a
// malformed one is the caller's mistake and belongs in the same 400 envelope
// as an unknown field. JSON.parse raises a SyntaxError, which is not a
// KitError, so it fell past the catch below and answered the 500 envelope --
// a typo'd curl read as a crashed fake. A malformed body on an ordinary route
// still throws, which is what the fakes' originals did.
function parseResetRequest(raw: Buffer): JsonValue {
  try {
    return parseBody(raw)
  } catch (err: unknown) {
    throw new ResetBodyError(`/reset body is not JSON: ${(err as Error).message}`)
  }
}

// The same rule /reset's body follows: a malformed list of plans is the
// caller's mistake, not a crashed fake.
function parseFaultRequest(raw: Buffer): JsonValue {
  try {
    return parseBody(raw)
  } catch (err: unknown) {
    throw new FaultError(`${FAULTS_PATH} body is not JSON: ${(err as Error).message}`)
  }
}

// The fault-plan hook every kit fake gets, on the tenant the request resolves
// to exactly as an API request would. POST arms the listed plans after any
// already armed, GET lists them with how many requests each has served, and
// DELETE disarms them and answers that same list, so a harness clears a
// case's faults and learns whether every one fired in one call. A /reset of
// the tenant disarms them too.
function faultsEndpoint<C extends MinimalClient>(
  router: Router<C>,
  faults: Faults,
  method: string,
  raw: Buffer,
): Reply {
  if (method === 'GET') return { status: 200, body: { plans: faults.report() } }
  if (method === 'DELETE') {
    const plans = faults.report()
    faults.clear()
    return { status: 200, body: { plans } }
  }
  if (method !== 'POST') {
    return { status: 405, body: { error: 'method_not_allowed', method, path: FAULTS_PATH } }
  }
  try {
    faults.arm(parseFaultBody(parseFaultRequest(raw), (m, r) => router.declares(m, r)))
  } catch (err: unknown) {
    if (err instanceof FaultError) {
      return {
        status: 400,
        body: { error: 'bad_faults', kind: err.constructor.name, message: err.message },
      }
    }
    throw err
  }
  return { status: 200, body: { plans: faults.report() } }
}

function send(res: ServerResponse, reply: Reply, head: boolean): void {
  const headers: Record<string, string> = { ...(reply.headers ?? {}) }
  let payload: Buffer
  if (reply.body === undefined) {
    payload = Buffer.alloc(0)
  } else if (Buffer.isBuffer(reply.body)) {
    payload = reply.body
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/octet-stream'
  } else {
    payload = Buffer.from(JSON.stringify(reply.body), 'utf8')
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
  }
  // RFC 7230 forbids Content-Length on a 204 or a 304, and every aiohttp fake
  // this kit replaces omitted it there, so a caller diffing the two sees the
  // same headers. A HEAD still carries the length its GET would have.
  if (reply.status !== 204 && reply.status !== 304) {
    headers['Content-Length'] = String(payload.length)
  }
  res.writeHead(reply.status, headers)
  res.end(head ? undefined : payload)
}

// A fake that throws must say so in a shape the caller can read, and must not
// take the process down: a 500 carrying the message beats a hung socket, which
// is indistinguishable from a slow backend.
function envelope(service: string, err: unknown): Reply {
  const message = err instanceof Error ? err.message : String(err)
  const kind = err instanceof KitError ? err.constructor.name : 'Error'
  process.stderr.write(`${service} fake: ${kind}: ${message}\n`)
  return { status: 500, body: { error: 'internal_error', kind, message } }
}

// The kit knows a tenant is unknown; only the fake knows how its vendor says
// so, so the body is the fake's whenever it declares one. The fallback is a
// 401 rather than a 404 because the tenant is reached through a credential in
// every fake that has one, and refusing the credential is what the vendor does.
// A null answer is an armed fault that leaves the request unanswered.
async function answer<C extends MinimalClient>(
  rt: Runtime<C>,
  router: Router<C>,
  method: string,
  url: URL,
  headers: Headers,
  raw: Buffer,
): Promise<Reply | null> {
  const { service, tenantKind } = rt.fake.config
  // Stripped FIRST, so every path below is the one the fake declares. A run
  // prefix is transport, not routing: `/_run/h1/v1/users/me` is the same route
  // as `/v1/users/me`, and health and /reset answer under it too, which is
  // what lets a harness point one base URL at everything it needs.
  let pathRun: string | undefined
  let path: string
  try {
    const split = splitRunPath(url.pathname)
    pathRun = split.run
    path = split.path
    // The URL a HANDLER sees loses the prefix too, not just the one the router
    // matches on. A handler reads this pathname for things a caller observes:
    // github renders it into a pull_request url, and the http fake LOOKS ROWS
    // UP by it, which a prefixed path misses outright. Leaving it also put the
    // harness's random run id into error text, so a golden would differ
    // between runs. Origin, host and query are untouched.
    url.pathname = path
  } catch (err: unknown) {
    if (err instanceof TenantError) {
      return {
        status: 400,
        body: { error: 'bad_run', kind: err.constructor.name, message: err.message },
      }
    }
    throw err
  }
  if (path === HEALTH_PATH && (method === 'GET' || method === 'HEAD')) {
    return { status: 200, body: { ok: true, service, runs: rt.pool.runs().length } }
  }
  if (path.startsWith('/_kit/runs/') && method === 'DELETE') {
    try {
      const name = splitRunPath(`/_run/${path.slice('/_kit/runs/'.length)}`)
      if (name.path !== '/' || name.run === undefined) throw new TenantError('invalid run path')
      if (pathRun !== undefined && pathRun !== name.run)
        throw new TenantError('contradictory run path')
      await rt.drop(name.run)
      return { status: 204 }
    } catch (err: unknown) {
      if (err instanceof TenantError)
        return { status: 400, body: { error: 'bad_run', message: err.message } }
      throw err
    }
  }
  if (path === RESET_PATH && method === 'POST') {
    try {
      // Enqueued on the run's own write queue. A reset deletes and reseeds
      // rows, and for a fake with no tenant column recreates the SQLite file
      // outright, so running it beside an in-flight write unlinked the
      // database under that write: the request 500'd and every later request
      // on the run failed forever. It is a write and queues like one.
      // A reset reached through `/_run/<id>/reset` is about THAT run, so the
      // prefix fills the body's `run` in. Naming a different one in the body
      // under a prefix is a caller contradicting itself, and is refused rather
      // than silently resolved in favour of either.
      const body = withPathRun(parseResetRequest(raw), pathRun)
      const done = await rt.reset(body)
      return { status: 200, body: JSON.parse(JSON.stringify(done)) as JsonValue }
    } catch (err: unknown) {
      // A body the kit will not interpret is the caller's mistake, so it is a
      // 400 naming the field. Only a failure inside the seed falls through to
      // the 500 envelope, where it belongs.
      if (
        err instanceof ResetBodyError ||
        err instanceof FixtureError ||
        err instanceof TenantError
      ) {
        return {
          status: 400,
          body: { error: 'bad_reset', kind: err.constructor.name, message: err.message },
        }
      }
      throw err
    }
  }
  let run: string
  let tenant: string
  try {
    const identity = resolveIdentity(
      rt.fake.config,
      headers,
      url,
      pathRun,
      rt.fake.requestToken?.(headers, url, raw),
    )
    run = identity.run
    tenant = identity.tenant
  } catch (err: unknown) {
    // Same shape /reset already used, just reached from the request path. An
    // illegal `?_run=..%2Fx` or `?_tenant=bad name` reached the 500 envelope
    // from here, so a caller typo read as a crashed fake.
    if (err instanceof TenantError) {
      return {
        status: 400,
        body: { error: 'bad_tenant', kind: err.constructor.name, message: err.message },
      }
    }
    throw err
  }
  if (path === FAULTS_PATH)
    return faultsEndpoint(router, rt.state(run).of(tenant).faults, method, raw)
  const hit = router.match(method, path)
  if (hit === null) return unrouted(service, method, path)
  // Ahead of the run's queue and of the handler: a faulted request touches
  // no row, so it neither waits behind a write nor holds one up while it
  // hangs, and a write route faulted with a 5xx has provably not applied.
  // The request's own method, not the route's: a HEAD answered by a GET
  // route must not spend a plan armed for the GET.
  const fault = rt.state(run).peek(tenant)?.faults.take(method, hit.spec.path) ?? null
  if (fault !== null) {
    // Unreferenced, so a hang still pending when the server closes does not
    // keep the process alive past its own teardown.
    if (fault.delayMs > 0) await delay(fault.delayMs, undefined, { ref: false })
    return fault.reply
  }
  const work = (): Promise<Reply> | Reply => {
    const runState = rt.state(run)
    const refuse = rt.fake.unknownTenant
    if (refuse !== undefined && tenantKind !== 'none' && !runState.isSeeded(tenant))
      return refuse(tenant)
    const st = runState.of(tenant)
    const ctx: Ctx<C> = {
      params: hit.params,
      query: url.searchParams,
      body: raw,
      run,
      tenant,
      runPrefix: pathRun === undefined ? '' : `/${RUN_PREFIX}/${pathRun}`,
      db: rt.pool.client(run),
      clock: st.clock,
      minter: st.minter,
      headers,
      url,
      json: () => parseBody(raw),
    }
    return hit.spec.handler(ctx)
  }
  return router.run(run, hit.spec.write, work)
}

export function createKitServer<C extends MinimalClient>(rt: Runtime<C>): Server {
  const { service, maxBodyBytes } = rt.fake.config
  const router = rt.router
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? '127.0.0.1'
    const url = new URL(req.url ?? '/', `http://${host}`)
    const method = (req.method ?? 'GET').toUpperCase()
    const chunks: Buffer[] = []
    let size = 0
    let refused = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBodyBytes) {
        // Stop buffering, but let the request drain and answer from `end`.
        // Destroying the socket in the same tick as the write means the peer
        // reads ECONNRESET instead of the 413, so an over-large body looked
        // like a crashed server rather than a refused request.
        refused = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (refused) {
        send(res, { status: 413, body: { error: 'body_too_large', limit: maxBodyBytes } }, false)
        return
      }
      void answer(rt, router, method, url, req.headers as Headers, Buffer.concat(chunks))
        .then((reply) => {
          if (reply === null) res.destroy()
          else send(res, reply, method === 'HEAD')
        })
        .catch((err: unknown) => {
          send(res, envelope(service, err), method === 'HEAD')
        })
    })
  })
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
  return server
}
