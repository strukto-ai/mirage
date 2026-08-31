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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANNOUNCE_RE } from '../typescript/announce.ts'
import { Prisma } from '../../../generated/selftest/index.js'
import { clearTenants, deleteOrder, untenanted } from '../typescript/clear.ts'
import type { Dmmf } from '../typescript/seed.ts'
import { unroutedLine } from '../typescript/unrouted.ts'
import type { JsonValue } from '../typescript/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..', '..')

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`selftest failed: ${name} ${detail}`)
}

function eq(name: string, got: JsonValue, want: JsonValue): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  check(name, a === b, a === b ? a : `got ${a} want ${b}`)
}

interface Fake {
  child: ChildProcessByStdio<null, Readable, Readable>
  endpoint: string
  stderr: () => string
}

async function launch(env: Record<string, string> = {}, argv: string[] = []): Promise<Fake> {
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--port', '0', ...argv],
    { cwd: INTEG, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } },
  )
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err += d
  })
  const first = await new Promise<string>((ok, bad) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl !== -1) ok(out.slice(0, nl))
    })
    child.on('exit', (code) => {
      bad(new Error(`fake exited ${String(code)} before announcing\n${err}`))
    })
  })
  check('announce line matches ANNOUNCE_RE', ANNOUNCE_RE.test(first), first)
  return { child, endpoint: first.split('=').slice(1).join('='), stderr: () => err }
}

interface CallOpts {
  method?: string
  body?: JsonValue
  run?: string
  tenant?: string
  // Address the run through the URL instead of the header, which is the only
  // spelling a mount handing its base URL to an SDK can actually use.
  runInPath?: string
}

async function call(
  fake: Fake,
  path: string,
  opts: CallOpts = {},
): Promise<{ status: number; json: JsonValue }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.run !== undefined) headers['x-mirage-run'] = opts.run
  if (opts.tenant !== undefined) headers['x-mirage-tenant'] = opts.tenant
  const prefix = opts.runInPath === undefined ? '' : `/_run/${opts.runInPath}`
  const res = await fetch(`${fake.endpoint}${prefix}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  const text = await res.text()
  return { status: res.status, json: text === '' ? null : (JSON.parse(text) as JsonValue) }
}

function titles(payload: JsonValue): string[] {
  const cards = (payload as { cards: { title: string }[] }).cards
  return cards.map((c) => c.title)
}

function rowsOf(payload: JsonValue, tenant: string): JsonValue {
  const seeded = (payload as { seeded: { tenant: string; rows: JsonValue }[] }).seeded
  const hit = seeded.find((s) => s.tenant === tenant)
  return hit === undefined ? null : hit.rows
}

async function main(): Promise<void> {
  const fake = await launch()
  try {
    process.stdout.write('\n1. announce + reachable\n')
    check(
      'endpoint is an origin with no path',
      /^http:\/\/127\.0\.0\.1:\d+$/.test(fake.endpoint),
      fake.endpoint,
    )

    process.stdout.write('\n2. health\n')
    const health = await call(fake, '/_kit/health')
    check('GET /_kit/health is 200', health.status === 200, JSON.stringify(health.json))

    process.stdout.write('\n3. run isolation\n')
    const ra = await call(fake, '/reset', { method: 'POST', body: { run: 'a' } })
    const rb = await call(fake, '/reset', { method: 'POST', body: { run: 'b' } })
    check('reset a is 200', ra.status === 200, JSON.stringify(ra.json))
    check('reset b is 200', rb.status === 200, JSON.stringify(rb.json))
    const wrote = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'a',
      body: { title: 'written-into-a' },
    })
    check('write into run a is 201', wrote.status === 201, JSON.stringify(wrote.json))
    const inA = await call(fake, '/boards/brd_1/cards', { run: 'a' })
    const inB = await call(fake, '/boards/brd_1/cards', { run: 'b' })
    eq('run a sees the write', titles(inA.json) as unknown as JsonValue, [
      'zebra',
      'apple',
      'mango',
      'written-into-a',
    ])
    eq('run b does NOT see it', titles(inB.json) as unknown as JsonValue, [
      'zebra',
      'apple',
      'mango',
    ])

    process.stdout.write('\n4. two tenants, one run, same fixture ids\n')
    const rc = await call(fake, '/reset', {
      method: 'POST',
      body: { run: 'c', tenants: ['s1', 's2'] },
    })
    check('reset with two tenants is 200', rc.status === 200, JSON.stringify(rc.json))
    const s1 = await call(fake, '/cards/crd_a', { run: 'c', tenant: 's1' })
    const s2 = await call(fake, '/cards/crd_a', { run: 'c', tenant: 's2' })
    check('tenant s1 has crd_a', s1.status === 200, JSON.stringify(s1.json))
    check('tenant s2 has the SAME id crd_a', s2.status === 200, JSON.stringify(s2.json))
    const w1 = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'c',
      tenant: 's1',
      body: { title: 'only-in-s1' },
    })
    check('write into tenant s1 is 201', w1.status === 201, JSON.stringify(w1.json))
    eq(
      'tenant s2 is unaffected',
      titles(
        (await call(fake, '/boards/brd_1/cards', { run: 'c', tenant: 's2' })).json,
      ) as unknown as JsonValue,
      ['zebra', 'apple', 'mango'],
    )

    process.stdout.write('\n5. generic seeder, zero per-entity code\n')
    eq('seeded row counts for s1', rowsOf(rc.json, 's1'), { Board: 2, Card: 3, Owner: 1 })
    eq('seeded row counts for s2', rowsOf(rc.json, 's2'), { Board: 2, Card: 3, Owner: 1 })
    const boards = await call(fake, '/boards', { run: 'c', tenant: 's2' })
    eq(
      'nested single-object child (owner) landed',
      ((boards.json as { boards: { owner: JsonValue }[] }).boards[0] as { owner: JsonValue }).owner,
      { id: 'own_1', name: 'Ada Lovelace' },
    )

    process.stdout.write('\n6. fixture order (the include ordering trap)\n')
    const fresh = titles((await call(fake, '/boards/brd_1/cards-naive', { run: 'b' })).json)
    process.stdout.write(`       fresh seed, include with NO orderBy -> ${JSON.stringify(fresh)}\n`)
    const retitled = await call(fake, '/cards/crd_a', {
      method: 'PUT',
      run: 'b',
      body: { title: 'apricot' },
    })
    check(
      'retitle (delete + re-create) is 200',
      retitled.status === 200,
      JSON.stringify(retitled.json),
    )
    const naiveTitles = titles((await call(fake, '/boards/brd_1/cards-naive', { run: 'b' })).json)
    const seqTitles = titles((await call(fake, '/boards/brd_1/cards', { run: 'b' })).json)
    process.stdout.write(
      `       after write, include with NO orderBy -> ${JSON.stringify(naiveTitles)}\n`,
    )
    process.stdout.write(
      `       after write, findMany orderBy seq    -> ${JSON.stringify(seqTitles)}\n`,
    )
    check(
      'the naive include read LOST fixture order (trap reproduced)',
      JSON.stringify(naiveTitles) !== JSON.stringify(['zebra', 'apricot', 'mango']),
      JSON.stringify(naiveTitles),
    )
    eq('seq + orderBy still reads back fixture order', seqTitles as unknown as JsonValue, [
      'zebra',
      'apricot',
      'mango',
    ])

    process.stdout.write('\n7. mint + clock determinism across reset\n')
    const epoch = '2026-01-01T00:00:00Z'
    await call(fake, '/reset', { method: 'POST', body: { run: 'd', epoch } })
    const first1 = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'd',
      body: { title: 'one' },
    })
    const first2 = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'd',
      body: { title: 'two' },
    })
    await call(fake, '/reset', { method: 'POST', body: { run: 'd', epoch } })
    const again1 = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'd',
      body: { title: 'one' },
    })
    const again2 = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'd',
      body: { title: 'two' },
    })
    eq('first mint + clock', first1.json, {
      id: 'crd_new_1',
      title: 'one',
      seq: 3,
      createdAt: '2026-01-01T00:00:01.000Z',
    })
    eq('second mint + clock', first2.json, {
      id: 'crd_new_2',
      title: 'two',
      seq: 4,
      createdAt: '2026-01-01T00:00:02.000Z',
    })
    eq('same after reset (1)', again1.json, first1.json)
    eq('same after reset (2)', again2.json, first2.json)

    process.stdout.write('\n8. unrouted\n')
    const miss = await call(fake, '/no/such/thing')
    check('unrouted path is 404', miss.status === 404, JSON.stringify(miss.json))
    await new Promise((r) => setTimeout(r, 100))
    const want = unroutedLine('selftest', 'GET', '/no/such/thing')
    check('unrouted printed the stderr line', fake.stderr().includes(want), want)

    process.stdout.write('\n9. write serialization (per-run queue)\n')
    await call(fake, '/reset', { method: 'POST', body: { run: 'e' } })
    const burst = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        call(fake, '/boards/brd_2/cards', {
          method: 'POST',
          run: 'e',
          body: { title: `burst-${String(n)}` },
        }),
      ),
    )
    const seqs = burst.map((b) => (b.json as { seq: number }).seq).sort((a, b) => a - b)
    process.stdout.write(`       five concurrent POSTs -> seq ${JSON.stringify(seqs)}\n`)
    eq('concurrent writes got distinct seqs', seqs as unknown as JsonValue, [0, 1, 2, 3, 4])
    const ids = burst.map((b) => (b.json as { id: string }).id).sort()
    eq('and distinct minted ids', ids as unknown as JsonValue, [
      'crd_new_1',
      'crd_new_2',
      'crd_new_3',
      'crd_new_4',
      'crd_new_5',
    ])

    // A read must WAIT for a pending write on the same run. two-phase writes
    // its row as `phase-1`, sleeps, then updates it to `phase-2`, so a read
    // landing in the gap is NAMED stale rather than merely early. 300ms of gap
    // against a 60ms head start is not a coin flip. The read does not JOIN the
    // queue, which is what keeps this from costing writes any concurrency.
    const slow = call(fake, '/boards/brd_2/two-phase?ms=300', { method: 'POST', run: 'e' })
    await new Promise((r) => setTimeout(r, 60))
    const during = await call(fake, '/boards/brd_2/cards', { run: 'e' })
    await slow
    const seen = (during.json as { cards: { title: string }[] }).cards.map((c) => c.title)
    check(
      'a read issued mid-write never observes phase-1',
      !seen.includes('phase-1'),
      JSON.stringify(seen),
    )
    check('and it does observe the completed phase-2', seen.includes('phase-2'))

    process.stdout.write('\n10. an IPv6 bind announces a parseable authority\n')
    const v6 = await launch({ MIRAGE_BIND_HOST: '::1' })
    try {
      check('IPv6 literal is bracketed', v6.endpoint.startsWith('http://[::1]:'), v6.endpoint)
      let parsed = ''
      try {
        parsed = new URL(v6.endpoint).href
      } catch {
        parsed = ''
      }
      check('and new URL() accepts it', parsed !== '', parsed === '' ? 'rejected' : parsed)
      const reachable = await call(v6, '/boards')
      check('and the announced authority is dialable', reachable.status === 200)
    } finally {
      v6.child.kill()
    }

    process.stdout.write('\n11. /reset refuses what it cannot interpret\n')
    const badField = await call(fake, '/reset', {
      method: 'POST',
      body: { run: 'f', workspace: 'ws_1' },
    })
    check('unknown /reset field is 400', badField.status === 400, JSON.stringify(badField.json))
    const badFixture = await call(fake, '/reset', {
      method: 'POST',
      body: { run: 'f', fixture: '../trello/v1' },
    })
    check('pathed fixture name is 400', badFixture.status === 400, JSON.stringify(badFixture.json))
    const missing = await call(fake, '/reset', {
      method: 'POST',
      body: { run: 'f', fixture: 'nope' },
    })
    check('unknown fixture name is 400', missing.status === 400, JSON.stringify(missing.json))

    // The reason two hosts may share one server. A reset used to recreate the
    // whole run FILE, so the second host's /reset destroyed the first host's
    // world; both hosts land on run `default` because no adapter sends one, so
    // this was not a corner case, it was the normal path.
    process.stdout.write('\n12. a scoped reset touches only the tenants it names\n')
    const two = await call(fake, '/reset', {
      method: 'POST',
      body: { run: 'g', tenants: ['h1', 'h2'], epoch },
    })
    eq('reset reports it was scoped', (two.json as { scoped: JsonValue }).scoped, true)
    const kept = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'g',
      tenant: 'h1',
      body: { title: 'host-1-work' },
    })
    eq('h1 wrote and minted the first id', (kept.json as { id: JsonValue }).id, 'crd_new_1')

    const solo = await call(fake, '/reset', {
      method: 'POST',
      body: { run: 'g', tenants: ['h2'], epoch },
    })
    eq('resetting h2 alone is 200', solo.status as unknown as JsonValue, 200)
    eq(
      'and it reseeded ONLY h2',
      (solo.json as { seeded: { tenant: string }[] }).seeded.map((x) => x.tenant),
      ['h2'],
    )
    eq(
      "h1's row SURVIVED h2's reset",
      titles((await call(fake, '/boards/brd_1/cards', { run: 'g', tenant: 'h1' })).json),
      ['zebra', 'apple', 'mango', 'host-1-work'],
    )
    eq(
      'h2 is back at the fixture',
      titles((await call(fake, '/boards/brd_1/cards', { run: 'g', tenant: 'h2' })).json),
      ['zebra', 'apple', 'mango'],
    )

    // The half that a row check cannot see. The minter and the clock were
    // per-RUN, so h2's reset cleared the counter h1 was still minting from and
    // h1's next id repeated crd_new_1 -- a duplicate id inside one tenant, from
    // a reset that never named it.
    const after = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'g',
      tenant: 'h1',
      body: { title: 'host-1-again' },
    })
    eq(
      "h1's minter was NOT rewound by h2's reset",
      (after.json as { id: JsonValue }).id,
      'crd_new_2',
    )
    const fresh2 = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'g',
      tenant: 'h2',
      body: { title: 'host-2-first' },
    })
    eq("h2's own minter DID restart, at its own epoch", fresh2.json, {
      id: 'crd_new_1',
      title: 'host-2-first',
      seq: 3,
      createdAt: '2026-01-01T00:00:01.000Z',
    })

    // The guard that keeps the scoped delete as exhaustive as recreating the
    // file was: a model with no tenant column cannot be cleared per tenant, so
    // the reset refuses rather than leaving rows behind for the next seed.
    process.stdout.write('\n13. a schema a scoped reset cannot honor is refused\n')
    const shared: Dmmf = {
      datamodel: {
        models: [
          {
            name: 'Scoped',
            fields: [{ name: 'tenant', kind: 'scalar', isList: false, type: 'String' }],
          },
          {
            name: 'Global',
            fields: [{ name: 'id', kind: 'scalar', isList: false, type: 'String' }],
          },
        ],
      },
    }
    eq('untenanted() names the offending model', untenanted(shared) as unknown as JsonValue, [
      'Global',
    ])
    // The order is the whole trick, and it is easy to get backwards: this is an
    // insert order read in reverse, so the FK holders (Card, Owner) must come
    // out before what they point at (Board). Deleting Board first is what the
    // required-relation refusal above looks like from the caller's side.
    eq('deleteOrder puts FK holders before their parent', deleteOrder(Prisma.dmmf), [
      'Owner',
      'Card',
      'Board',
    ])

    let refused = ''
    try {
      await clearTenants({}, shared, ['h1'])
    } catch (err: unknown) {
      refused = (err as Error).message
    }
    check(
      'and clearTenants refuses that schema by name',
      refused.includes('Global') && refused.includes('tenant'),
      refused === '' ? 'did NOT throw' : refused,
    )

    // One binary, several scenarios. github is served three ways from one
    // server (three repos, one repo and no creation, and empty for the watch
    // battery), which only works if a bare reset replays what the process was
    // started on rather than defaulting back to v1.
    process.stdout.write(
      '\n14. --fixture picks the startup scenario, and a bare reset replays it\n',
    )
    const alt = await launch({}, ['--fixture', 'alt'])
    try {
      const seeded = await call(alt, '/boards')
      eq(
        'startup seeded the named fixture',
        (seeded.json as { boards: { name: JsonValue }[] }).boards.map((b) => b.name),
        ['Alternate'],
      )
      const bare = await call(alt, '/reset', { method: 'POST', body: {} })
      eq('bare reset succeeds', (bare.json as { ok: JsonValue }).ok, true)
      const again = await call(alt, '/boards')
      eq(
        'and it replayed alt, NOT the default v1',
        (again.json as { boards: { name: JsonValue }[] }).boards.map((b) => b.name),
        ['Alternate'],
      )
      // A refused reset must not change what a later bare one replays. Recording
      // the name before applying it wedged the fake: the 400 left the bad name
      // remembered, so the next bare reset failed on a request already refused.
      const refusedFixture = await call(alt, '/reset', {
        method: 'POST',
        body: { fixture: 'nope' },
      })
      check(
        'a reset naming an unknown fixture is still 400',
        refusedFixture.status === 400,
        JSON.stringify(refusedFixture.json),
      )
      const after = await call(alt, '/reset', { method: 'POST', body: {} })
      eq(
        'and the refusal did NOT poison the remembered fixture',
        (after.json as { ok: JsonValue }).ok,
        true,
      )
      const kept2 = await call(alt, '/boards')
      eq(
        'so a bare reset still replays alt',
        (kept2.json as { boards: { name: JsonValue }[] }).boards.map((b) => b.name),
        ['Alternate'],
      )
    } finally {
      alt.child.kill('SIGTERM')
    }

    // A flag the kit does not implement must stop the process, not be skipped.
    // Every fake here parses argv by scanning for its own flags, so an ignored
    // one meant a caller asked for one world and silently got the default: the
    // github fake replaced one that took --repo/--metadata/--commits, and a
    // launch line carrying those announced a healthy server seeded with v1.
    process.stdout.write('\n15. an argument the kit does not implement is refused\n')
    let refusedArgv = ''
    try {
      const bad = await launch({}, ['--repo', 'integ/x=dir', '--no-create-repos'])
      bad.child.kill('SIGTERM')
    } catch (err: unknown) {
      refusedArgv = (err as Error).message
    }
    check(
      'an unknown flag fails the launch',
      refusedArgv.includes('--repo') && refusedArgv.includes('--no-create-repos'),
      refusedArgv === '' ? 'launched ANYWAY' : (refusedArgv.split('\n')[0] ?? ''),
    )
    check(
      'and it names the flags the kit does take',
      refusedArgv.includes('--fixture') && refusedArgv.includes('--port'),
      refusedArgv.split('\n')[0] ?? '',
    )
    // The likelier slip than an unknown flag: `--port N alt` is `--fixture alt`
    // with the flag dropped, and skipping the bare word served the DEFAULT
    // fixture under a line that reads as asking for another one.
    let refusedWord = ''
    try {
      const stray = await launch({}, ['alt'])
      stray.child.kill('SIGTERM')
    } catch (err: unknown) {
      refusedWord = (err as Error).message
    }
    check(
      'a stray positional fails the launch too',
      refusedWord.includes('exited 1'),
      refusedWord === '' ? 'launched ANYWAY' : (refusedWord.split('\n')[0] ?? ''),
    )

    process.stdout.write('\n16. a tenant nobody seeded is refused, not crashed\n')
    // The failure this covers reached the caller as a 500 carrying whatever
    // the fake's own query threw, which reads as a crashed service: a
    // container healthcheck that probes with a credential marked the fake
    // permanently unhealthy. Both routes to an unseeded tenant are checked,
    // because they were two separate 500s with one cause.
    const ghost = await call(fake, '/boards', { run: 'p', tenant: 'never-seeded' })
    check('an unseeded tenant is 401, not 500', ghost.status === 401, JSON.stringify(ghost.json))
    check(
      'and the refusal names the tenant it did not find',
      JSON.stringify(ghost.json).includes('never-seeded'),
      JSON.stringify(ghost.json),
    )
    // Reading a tenant must not bring it into being. `of()` mints per-tenant
    // state for any legal name on first sight, so a check written against that
    // map would answer 401 once and then serve an empty world forever after.
    const again = await call(fake, '/boards', { run: 'p', tenant: 'never-seeded' })
    check('and asking twice is still 401', again.status === 401, JSON.stringify(again.json))
    const born = await call(fake, '/reset', {
      method: 'POST',
      body: { run: 'p', tenants: ['never-seeded'] },
    })
    check('seeding it is 200', born.status === 200, JSON.stringify(born.json))
    check(
      'and now the same request is served',
      (await call(fake, '/boards', { run: 'p', tenant: 'never-seeded' })).status === 200,
      JSON.stringify((await call(fake, '/boards', { run: 'p', tenant: 'never-seeded' })).json),
    )
    // A run is its own file, so seeding a tenant in one run says nothing about
    // the same name in another.
    const elsewhere = await call(fake, '/boards', { run: 'q', tenant: 'never-seeded' })
    check(
      'the same name in another run is still unseeded',
      elsewhere.status === 401,
      JSON.stringify(elsewhere.json),
    )

    process.stdout.write('\n17. a run can be addressed by URL, not just by header\n')
    // The header and the query parameter are only reachable by a caller that
    // builds its own requests. Every mount here hands a base URL to a vendor
    // SDK and never sees the request again, which is why the run axis went
    // unused and the tenant column was made to carry host isolation instead.
    // A path prefix is just part of the base URL, so it survives the trip.
    const seedU = await call(fake, '/reset', {
      method: 'POST',
      runInPath: 'u1',
      body: { tenants: ['shared'] },
    })
    check(
      'a reset under /_run/<id> resets THAT run',
      (seedU.json as { run: string }).run === 'u1',
      JSON.stringify(seedU.json),
    )
    await call(fake, '/reset', { method: 'POST', runInPath: 'u2', body: { tenants: ['shared'] } })
    // The same tenant name in both, which is the point: notion's bearer token
    // is echoed by `ntn auth token` and pinned by a golden, so it CANNOT be
    // minted per run. The run has to be the axis that separates two hosts.
    const wroteU1 = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      runInPath: 'u1',
      tenant: 'shared',
      body: { title: 'only-in-u1' },
    })
    check('a write into run u1 is 201', wroteU1.status === 201, JSON.stringify(wroteU1.json))
    check(
      'u1 sees it',
      titles(
        (await call(fake, '/boards/brd_1/cards', { runInPath: 'u1', tenant: 'shared' })).json,
      ).includes('only-in-u1'),
      JSON.stringify(
        titles(
          (await call(fake, '/boards/brd_1/cards', { runInPath: 'u1', tenant: 'shared' })).json,
        ),
      ),
    )
    check(
      'and u2 does NOT, under the very same tenant name',
      !titles(
        (await call(fake, '/boards/brd_1/cards', { runInPath: 'u2', tenant: 'shared' })).json,
      ).includes('only-in-u1'),
      JSON.stringify(
        titles(
          (await call(fake, '/boards/brd_1/cards', { runInPath: 'u2', tenant: 'shared' })).json,
        ),
      ),
    )
    const noPrefix = await call(fake, '/boards')
    check(
      'an unprefixed URL still means the default run',
      noPrefix.status === 200,
      JSON.stringify(noPrefix.json),
    )
    const badRun = await call(fake, '/boards', { runInPath: 'bad%2Fname' })
    check(
      'an illegal run in the path is 400, not 500',
      badRun.status === 400,
      JSON.stringify(badRun.json),
    )
    // decodeURIComponent throws a URIError on this, which is not a TenantError
    // and so reached the 500 envelope: a typed URL reported as a fake bug.
    // The kit keeps internal files under names a run cannot spell, and the
    // seeded templates now live in their own directory as well. Both rest on
    // checkName refusing a leading underscore, so that refusal is pinned here:
    // loosening the name rule would otherwise let a reset overwrite a cached
    // template and hand later runs the wrong database.
    for (const reserved of ['_seeded-0', '_build-0', '_template']) {
      const viaPath = await call(fake, '/boards', { runInPath: reserved })
      check(
        `a run named ${reserved} is refused in the path`,
        viaPath.status === 400,
        JSON.stringify(viaPath.json),
      )
      const viaBody = await call(fake, '/reset', { method: 'POST', body: { run: reserved } })
      check(`and refused in the /reset body`, viaBody.status === 400, JSON.stringify(viaBody.json))
    }
    const badEscape = await call(fake, '/boards', { runInPath: '%ZZ' })
    check(
      'a malformed percent escape in the run is 400, not 500',
      badEscape.status === 400,
      JSON.stringify(badEscape.json),
    )
    // The prefix fills in an ABSENT run only. Overwriting a malformed one
    // turned a request that owes a 400 into a successful reset.
    for (const bad of [12, '']) {
      const malformed = await call(fake, '/reset', {
        method: 'POST',
        runInPath: 'u1',
        body: { run: bad, tenants: ['shared'] },
      })
      check(
        `a malformed body run ${JSON.stringify(bad)} is still refused`,
        malformed.status === 400,
        JSON.stringify(malformed.json),
      )
    }
    // The router matched on the stripped path, but a handler reads ctx.url
    // directly. github renders that pathname into a response body and the http
    // fake looks rows up by it, so a prefix left on it is a wrong answer, not
    // just untidy output; it also put the harness's random run id into error
    // text, which a golden cannot match twice.
    const here = await call(fake, '/whereami?x=1', { runInPath: 'u1', tenant: 'shared' })
    check(
      'a handler sees the path WITHOUT the run prefix',
      (here.json as { path: string }).path === '/whereami',
      JSON.stringify(here.json),
    )
    check(
      'but a URL it mints to be followed BACK keeps the prefix',
      (here.json as { self: string }).self === '/_run/u1/whereami',
      JSON.stringify(here.json),
    )
    const bare = await call(fake, '/whereami?x=1')
    check(
      'and carries no prefix when the request arrived without one',
      (bare.json as { self: string }).self === '/whereami',
      JSON.stringify(bare.json),
    )
    check(
      'while still being told which run it is in, with the query intact',
      (here.json as { run: string }).run === 'u1' &&
        (here.json as { query: string }).query === '?x=1',
      JSON.stringify(here.json),
    )
    const clash = await call(fake, '/reset', {
      method: 'POST',
      runInPath: 'u1',
      body: { run: 'u2', tenants: ['shared'] },
    })
    check(
      'a body naming a different run than the prefix is refused',
      clash.status === 400,
      JSON.stringify(clash.json),
    )

    process.stdout.write('\n18. a run copied from the seeded template is complete\n')
    // A new run is served by copying a template that was itself seeded once,
    // rather than by seeding again. The hazard is SQLite's -wal: only the last
    // connection to close folds it back into the .db, so snapshotting a LIVE
    // run file captures a database missing its most recent commits. The
    // template is therefore built in a throwaway run that is disconnected
    // first, and this is what proves that worked: a copied run must be
    // indistinguishable from one that ran the seed itself.
    const copied = await call(fake, '/boards/brd_1/cards', { runInPath: 'w1', tenant: 'x' })
    check('a run never reset yet is not served', copied.status === 401, JSON.stringify(copied.json))
    await call(fake, '/reset', { method: 'POST', runInPath: 'w1', body: { tenants: ['x'] } })
    const fromTemplate = await call(fake, '/boards/brd_1/cards', { runInPath: 'w1', tenant: 'x' })
    const fromSeed = await call(fake, '/boards/brd_1/cards')
    check(
      'and once seeded it matches a run that seeded itself, exactly',
      JSON.stringify(fromTemplate.json) === JSON.stringify(fromSeed.json),
      `${JSON.stringify(fromTemplate.json)} vs ${JSON.stringify(fromSeed.json)}`,
    )
    // The row report has to survive too: a run served from a copy never ran
    // the seed that counts them, so /reset would answer an empty report.
    const report = await call(fake, '/reset', {
      method: 'POST',
      runInPath: 'w2',
      body: { tenants: ['x'] },
    })
    check(
      'and /reset still reports the rows it would have seeded',
      Object.keys(rowsOf(report.json, 'x') as Record<string, JsonValue>).length > 0,
      JSON.stringify(rowsOf(report.json, 'x')),
    )

    // The epoch is an input to the seed, so it is part of the template key.
    // Without it the SECOND epoch is served the FIRST one's rows: the template
    // is cached under (fixture, tenants, extras) and a seed that stamped a
    // timestamp stamped the first caller's clock into every later run.
    const stampOf = async (run: string, epoch: string): Promise<string> => {
      await call(fake, '/reset', {
        method: 'POST',
        runInPath: run,
        body: { tenants: ['stamped'], epoch },
      })
      const cards = await call(fake, '/boards/brd_1/cards', { runInPath: run, tenant: 'stamped' })
      const body = cards.json as Record<string, JsonValue> | null
      const rows = Array.isArray(body?.cards) ? body.cards : []
      const found = rows.find((r) => (r as Record<string, JsonValue>).id === 'crd_epoch')
      return String((found as Record<string, JsonValue> | undefined)?.title ?? 'missing')
    }
    const stampA = await stampOf('ep1', '2026-01-01T00:00:00Z')
    const stampB = await stampOf('ep2', '2031-07-04T00:00:00Z')
    const stampC = await stampOf('ep3', '2026-01-01T00:00:00Z')
    check('a seed reads the reset epoch', stampA === '2026-01-01T00:00:00Z', stampA)
    check(
      'a second epoch does not reuse the first template',
      stampB === '2031-07-04T00:00:00Z',
      stampB,
    )
    check('and the same epoch does reuse it', stampC === stampA, `${stampC} vs ${stampA}`)

    process.stdout.write('\n19. a seed that fails leaves nothing behind\n')
    const boom = await call(fake, '/reset', {
      method: 'POST',
      runInPath: 'v1',
      body: { tenants: ['boom'] },
    })
    check('a reset whose afterSeed throws is 500', boom.status === 500, JSON.stringify(boom.json))
    // The tenant must NOT count as seeded: it was marked at the START of the
    // reset once, which served a half-built world as a valid one.
    const afterBoom = await call(fake, '/boards', { runInPath: 'v1', tenant: 'boom' })
    check(
      'and the tenant it failed on is not served',
      afterBoom.status === 401,
      JSON.stringify(afterBoom.json),
    )
    // And the pool must not be wedged. The failed build's promise is evicted
    // so this retries the seed rather than replaying the rejection, which is
    // exactly why its throwaway client and files have to be cleaned up too.
    const recover = await call(fake, '/reset', {
      method: 'POST',
      runInPath: 'v2',
      body: { tenants: ['fine'] },
    })
    check('a later reset still works', recover.status === 200, JSON.stringify(recover.json))
    check(
      'and serves its data',
      (await call(fake, '/boards', { runInPath: 'v2', tenant: 'fine' })).status === 200,
      JSON.stringify((await call(fake, '/boards', { runInPath: 'v2', tenant: 'fine' })).json),
    )
    // Retried twice, because the first failure is the one that evicts and the
    // second is the one that would replay a remembered rejection.
    const boomAgain = await call(fake, '/reset', {
      method: 'POST',
      runInPath: 'v3',
      body: { tenants: ['boom'] },
    })
    check(
      'a repeat of the failing reset still reaches the seed',
      boomAgain.status === 500,
      JSON.stringify(boomAgain.json),
    )

    process.stdout.write('\n20. a request cannot preempt a run being installed\n')
    // The fake that opts OUT of the unknown-tenant refusal is the one at risk,
    // because nothing holds its requests while a reset runs. Building a ctx
    // calls pool.client(run), which CREATES the run from the schema-only
    // template; the reset then found that client already there and never
    // copied its seeded one, so the run stayed empty and the reset still
    // answered 200. Probed on github before the fix: 0 rows where 357 were
    // expected.
    const lazy = await launch({ SELFTEST_LAZY_TENANTS: '1' })
    try {
      const resetting = call(lazy, '/reset', {
        method: 'POST',
        runInPath: 'z1',
        body: { tenants: ['slow'] },
      })
      // Into the middle of the seed, which tenant `slow` holds open for 300ms.
      await new Promise((ok) => setTimeout(ok, 100))
      // /_kit/health describes the caller's own worlds, so the throwaway the
      // template is built in must never appear among them. It used to, for the
      // length of the seed, because it was registered in the same client map
      // runs() reads.
      const mid = await call(lazy, '/_kit/health')
      check(
        'health lists no internal build while one is running',
        (mid.json as { runs: string[] }).runs.every((r) => !r.startsWith('_')),
        JSON.stringify(mid.json),
      )
      const raced = await call(lazy, '/boards', { runInPath: 'z1', tenant: 'slow' })
      const done = await resetting
      check('the reset succeeds', done.status === 200, JSON.stringify(done.json))
      check(
        'the raced request waited for it rather than creating an empty run',
        raced.status === 200 && (raced.json as { boards: unknown[] }).boards.length === 2,
        JSON.stringify(raced.json),
      )
      check(
        'and the run really holds its data afterwards',
        titles((await call(lazy, '/boards/brd_1/cards', { runInPath: 'z1', tenant: 'slow' })).json)
          .length === 3,
        JSON.stringify(
          titles(
            (await call(lazy, '/boards/brd_1/cards', { runInPath: 'z1', tenant: 'slow' })).json,
          ),
        ),
      )
      // Opting out is still opting out: an unseeded tenant is served, not
      // refused, which is what dropbox needs and what a blanket refusal broke.
      const lazyMiss = await call(lazy, '/boards', { runInPath: 'z2', tenant: 'never' })
      check(
        'a fake that declares no unknownTenant still serves an unseeded tenant',
        lazyMiss.status === 200,
        JSON.stringify(lazyMiss.json),
      )
    } finally {
      lazy.child.kill('SIGTERM')
    }

    // 20. The fixture root is a LAUNCH argument, and moving it moves the whole
    // tree the fake reads: a harness pointing a fake at its own fixtures used
    // to bind-mount files into the checkout one at a time, and then whole
    // directories once fakes began seeding from `sourceDir`. What a REQUEST may
    // ask for is unchanged, which is the half that has to be re-proved: a
    // pathed name is still refused, now against the moved root.
    process.stdout.write('\n20. --fixture-root moves the tree without opening the name\n')
    const rootDir = mkdtempSync(join(tmpdir(), 'mirage-fixture-root-'))
    mkdirSync(join(rootDir, 'selftest'), { recursive: true })
    writeFileSync(
      join(rootDir, 'selftest', 'v1.json'),
      JSON.stringify({
        boards: [
          { id: 'brd_root', name: 'Rooted', cards: [{ id: 'crd_root', title: 'from-the-root' }] },
        ],
      }),
    )
    const rooted = await launch({}, ['--fixture-root', rootDir])
    try {
      const seeded = await call(rooted, '/reset', { method: 'POST', body: { fixture: 'v1' } })
      check('a reset under a moved root is 200', seeded.status === 200, JSON.stringify(seeded.json))
      eq(
        'and it seeded the fixture from THERE, not from the checkout',
        titles((await call(rooted, '/boards/brd_root/cards')).json),
        ['from-the-root'],
      )
      // The checkout's own v1 has brd_1 with three cards; if the root had
      // merged rather than moved, this would answer those three. The fake
      // answers an unknown board with an empty list rather than a 404, so the
      // emptiness is what says the board was never seeded.
      eq(
        'and the checkout fixture is not reachable from there',
        titles((await call(rooted, '/boards/brd_1/cards')).json),
        [],
      )
      // The hole #937 closed stays closed. `alt.json` exists in the CHECKOUT's
      // selftest directory and not under the moved root, so a name that walks
      // out of the moved root would find it -- and is refused before it can.
      const escape = await call(rooted, '/reset', {
        method: 'POST',
        body: { fixture: `../../${'fixtures'}/selftest/alt` },
      })
      check(
        'a pathed name is still 400 under a moved root',
        escape.status === 400,
        JSON.stringify(escape.json),
      )
    } finally {
      rooted.child.kill('SIGTERM')
      rmSync(rootDir, { recursive: true, force: true })
    }

    process.stdout.write(`\nselftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
