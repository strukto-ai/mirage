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
import { makePool, makeState } from './base.ts'
import type { Fake, Runtime, RunState } from './base.ts'
import type { MinimalClient } from './db.ts'
import { FixtureError, KitError, ResetBodyError, TenantError } from './errors.ts'
import { Router } from './route.ts'
import type { Ctx } from './route.ts'
import { DEFAULT_FIXTURE, DEFAULT_FIXTURE_ROOT } from './fixture.ts'
import { applyReset, defaultTenantsOf, parseResetBody, withPathRun } from './reset.ts'
import { DEFAULT_RUN, RUN_PREFIX, resolveRun, resolveTenant, splitRunPath } from './tenant.ts'
import type { Headers } from './tenant.ts'
import { unrouted } from './unrouted.ts'
import type { JsonValue, Reply } from './types.ts'

export const HEALTH_PATH = '/_kit/health'
export const RESET_PATH = '/reset'

export function makeRuntime<C extends MinimalClient>(
  fake: Fake<C>,
  fixtureRoot: string = DEFAULT_FIXTURE_ROOT,
): Runtime<C> {
  const pool = makePool(fake)
  const states = new Map<string, RunState>()
  const state = (run: string): RunState => {
    const live = states.get(run)
    if (live !== undefined) return live
    const made = makeState(fake)
    states.set(run, made)
    return made
  }
  // The fixture a bare /reset replays. `--fixture` sets it at startup and a
  // reset that names one replaces it, so a harness seeds once when the
  // scenario changes and then resets freely within it. Defaulting every bare
  // reset back to `v1` would put a server started on another fixture back on
  // the wrong scenario the first time a host reset it.
  let current = DEFAULT_FIXTURE
  return {
    fake,
    pool,
    fixtureRoot,
    state,
    reset: async (body: JsonValue) => {
      const req = parseResetBody(body, defaultTenantsOf(fake), current)
      // Remembered only once the reset SUCCEEDS. Recording it up front let a
      // rejected reset poison the fixture every later bare reset replays: a
      // 400 for an unknown name left `current` pointing at that name, so the
      // next reset that named nothing failed too, and the fake was wedged by a
      // request it had already refused.
      const out = await applyReset(fake, pool, state, req, fixtureRoot)
      current = req.fixture
      return out
    },
    dispose: async () => {
      states.clear()
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
async function answer<C extends MinimalClient>(
  rt: Runtime<C>,
  router: Router<C>,
  method: string,
  url: URL,
  headers: Headers,
  raw: Buffer,
): Promise<Reply> {
  const { service, tenantKind, tenantFromBearer, tenantTokenPattern } = rt.fake.config
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
    return { status: 200, body: { ok: true, service, runs: rt.pool.runs() } }
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
      const done = await router.enqueue(runOfReset(body), () => rt.reset(body))
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
    run = resolveRun(headers, url, pathRun)
    tenant = resolveTenant(headers, url, tenantKind, tenantFromBearer, tenantTokenPattern)
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
  // A tenant nobody seeded has no state to serve, and until now the fake found
  // that out one layer down, where its own first query came back empty and it
  // threw into the 500 envelope. 500 is the wrong answer twice over: it reads
  // as a crashed fake to anything watching (a container healthcheck marks the
  // service permanently unhealthy), and every real vendor here refuses an
  // unknown credential with a 401. Refused CENTRALLY rather than in each fake
  // because the condition is the kit's own: the kit is what resolved the name.
  // Both ways of reaching an unseeded tenant land here, which is the point --
  // a legal name that was never seeded, and the DEFAULT_TENANT that an illegal
  // one falls back to, were two separate 500s with one cause.
  // Everything below observes the run, so nothing below may start while a
  // reset is still installing it. Router.run waits for this queue too, but too
  // late: it runs AFTER the ctx is built, and building the ctx calls
  // pool.client(run), which CREATES the run from the schema-only template. A
  // read arriving during a reset's template build therefore installed an empty
  // client, the reset's own clientFromSeeded then found that client already
  // there and never copied the seeded file, and the run stayed empty while the
  // reset reported 200. Probed on github: 0 rows where 357 were expected.
  //
  // Waiting here rather than only on the unknown-tenant path, because the
  // failure does not need a tenant to be unknown and hit exactly the fakes
  // that opt out of that refusal. This is not a new wait for a read, which
  // already waited on this queue one step later.
  await router.settled(run)
  const runState = rt.state(run)
  const refuse = rt.fake.unknownTenant
  if (refuse !== undefined && tenantKind !== 'none' && !runState.isSeeded(tenant)) {
    return refuse(tenant)
  }
  const hit = router.match(method, path)
  if (hit === null) return unrouted(service, method, path)
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
  return router.run(hit.spec, ctx)
}

export function createKitServer<C extends MinimalClient>(rt: Runtime<C>): Server {
  const { service, maxBodyBytes } = rt.fake.config
  const router = new Router<C>(rt.fake.routes())
  return createServer((req: IncomingMessage, res: ServerResponse) => {
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
          send(res, reply, method === 'HEAD')
        })
        .catch((err: unknown) => {
          send(res, envelope(service, err), method === 'HEAD')
        })
    })
  })
}
