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

import assert from 'node:assert/strict'
import { FAULTS_PATH } from '../typescript/fault.ts'
import { start } from '../typescript/serve.ts'
import type { RunSnapshot } from '../typescript/snapshot.ts'
import type { JsonValue } from '../typescript/types.ts'
import { selftestFake } from './fake.ts'

interface Card {
  id: string
  title: string
  createdAt: string | null
}

export async function runSnapshotTests(): Promise<void> {
  const started = await start(selftestFake, 0)
  const { runtime, endpoint } = started
  const send = (path: string, method = 'GET', body?: JsonValue, tenant = 's1'): Promise<Response> =>
    fetch(`${endpoint}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-mirage-tenant': tenant },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const create = async (run: string, title: string): Promise<Card> => {
    const res = await send(`/_run/${run}/boards/brd_1/cards`, 'POST', { title })
    assert.equal(res.status, 201)
    return (await res.json()) as Card
  }
  const titles = async (run: string, tenant = 's1'): Promise<string[]> => {
    const res = await send(`/_run/${run}/boards/brd_1/cards`, 'GET', undefined, tenant)
    assert.equal(res.status, 200)
    return ((await res.json()) as { cards: Card[] }).cards.map((c) => c.title)
  }
  const snapshot = async (run: string): Promise<RunSnapshot> => {
    const res = await send(`/_kit/runs/${run}/snapshot`)
    assert.equal(res.status, 200)
    return (await res.json()) as RunSnapshot
  }
  const load = (run: string, body: JsonValue): Promise<Response> =>
    send(`/_kit/runs/${run}/load`, 'POST', body)
  const clone = (run: string, into: JsonValue): Promise<Response> =>
    send(`/_kit/runs/${run}/clone`, 'POST', { run: into })
  try {
    await runtime.reset({ run: 'a', tenants: ['s1', 's2'] })
    await create('a', 'one')
    const taken = await snapshot('a')
    assert.equal(taken.service, 'selftest')
    assert.deepEqual(Object.keys(taken.tenants), ['s1', 's2'])
    assert.equal(taken.tenants.s1?.seeded, true)
    assert.equal(taken.fixture, 'v1')
    const at = await titles('a')
    assert.deepEqual(at.slice(-1), ['one'], 'a snapshot holds the write just before it')

    const lost = await create('a', 'two')
    assert.equal((await load('a', taken as unknown as JsonValue)).status, 200)
    assert.deepEqual(await titles('a'), at, 'a load puts the run back as it was')
    const next = await create('a', 'three')
    assert.deepEqual(
      [next.id, next.createdAt],
      [lost.id, lost.createdAt],
      'a loaded run mints and stamps what the snapshotted one would have next',
    )
    assert.deepEqual(await titles('a', 's2'), at.slice(0, -1), 'every tenant is loaded')

    const cloned = await clone('a', 'b')
    assert.equal(cloned.status, 201)
    assert.deepEqual(await cloned.json(), { ok: true, run: 'b', tenants: ['s1', 's2'] })
    await create('b', 'only-b')
    await create('a', 'only-a')
    assert.deepEqual(await titles('b'), [...at, 'three', 'only-b'])
    assert.deepEqual(await titles('a'), [...at, 'three', 'only-a'], 'a clone diverges alone')

    assert.equal((await clone('a', 'b')).status, 409, 'a clone never replaces a run')
    assert.equal((await clone('a', 'a')).status, 409)
    assert.equal((await clone('nope', 'c')).status, 404)
    assert.equal((await send('/_kit/runs/nope/snapshot')).status, 404)
    assert.equal((await clone('a', '../x')).status, 400)
    assert.equal((await send('/_kit/runs/a/clone', 'POST', { into: 'c' })).status, 400)

    assert.equal((await load('c', taken as unknown as JsonValue)).status, 200, 'a load makes a run')
    assert.deepEqual(await titles('c'), at)
    assert.equal(
      (await send('/_run/c/boards/brd_1/cards', 'GET', undefined, 'zz')).status,
      401,
      'a loaded run still refuses a tenant no reset seeded',
    )

    const before = await titles('a')
    for (const bad of [
      { ...taken, service: 'other' },
      { ...taken, schema: '0'.repeat(64) },
      { ...taken, db: Buffer.from('not a database').toString('base64') },
      { ...taken, extra: 1 },
      { ...taken, fixture: '../../etc/passwd' },
      { ...taken, tenants: { s1: { ...taken.tenants.s1, clock: { base_ms: 0, ticks: -1 } } } },
      'garbage',
    ]) {
      const res = await load('a', bad as JsonValue)
      assert.equal(res.status, 400, JSON.stringify(await res.json()))
    }
    assert.deepEqual(await titles('a'), before, 'a refused load leaves the run as it was')

    const armed = await send(`/_run/a${FAULTS_PATH}`, 'POST', {
      plans: [{ method: 'GET', route: '/boards/:board/cards', times: 2, status: 429 }],
    })
    assert.equal(armed.status, 200)
    assert.equal((await send('/_run/a/boards/brd_1/cards')).status, 429)
    const resets = async (): Promise<{ tenants: string[] }[]> =>
      (await (await send('/_run/b/_selftest/resets')).json()) as { tenants: string[] }[]
    const seen = (await resets()).length
    assert.equal((await clone('a', 'd')).status, 201)
    const told = await resets()
    assert.equal(told.length, seen + 1, 'a load tells the fake its rows were replaced')
    assert.deepEqual(told.at(-1)?.tenants, ['s1', 's2'])
    assert.equal(
      (await send('/_run/d/boards/brd_1/cards')).status,
      429,
      'a clone keeps the plans armed',
    )
    assert.equal((await send('/_run/d/boards/brd_1/cards')).status, 200, 'and what each served')
    assert.equal(
      (await send('/_run/a/boards/brd_1/cards')).status,
      429,
      'the original keeps its own',
    )

    assert.equal((await send('/_run/x/_kit/runs/a/snapshot')).status, 400, 'contradictory run')
    assert.equal((await send('/_kit/runs/a/snapshot', 'POST')).status, 404, 'snapshot is a GET')
    await runtime.drop('c')
    assert.equal((await send('/_kit/runs/c/snapshot')).status, 404, 'a dropped run has none')
    process.stdout.write('  ok   snapshot, load and clone\n')
  } finally {
    await started.close()
  }
}
