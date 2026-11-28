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
import type { FaultReport } from '../typescript/fault.ts'
import { HOLDS_PATH } from '../typescript/hold.ts'
import { SETUP_HEADER } from '../typescript/http.ts'
import { REQUESTS_PATH } from '../typescript/request.ts'
import type { RequestReport } from '../typescript/request.ts'
import { start } from '../typescript/serve.ts'
import type { JsonValue } from '../typescript/types.ts'
import { selftestFake } from './fake.ts'

const CARDS: [string, string] = ['GET', '/boards/:board/cards']
const NEW_CARD: [string, string] = ['POST', '/boards/:board/cards']

export async function runHoldTests(): Promise<void> {
  const started = await start(selftestFake, 0)
  const { runtime, endpoint } = started
  const under = (run: string, path: string): string => `${endpoint}/_run/${run}${path}`
  const kit = (
    run: string,
    path: string,
    method: string,
    body?: JsonValue,
    tenant = 's1',
  ): Promise<Response> =>
    fetch(under(run, path), {
      method,
      headers: { 'Content-Type': 'application/json', 'x-mirage-tenant': tenant },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const hold = async (run: string, ...routes: [string, string][]): Promise<number> => {
    const res = await kit(run, HOLDS_PATH, 'POST', { routes })
    assert.equal(res.status, 200)
    return ((await res.json()) as { hold: number }).hold
  }
  const caught = async (run: string, id: number): Promise<JsonValue> =>
    (await kit(run, `${HOLDS_PATH}/${String(id)}`, 'GET')).json() as Promise<JsonValue>
  const release = (run: string, id: number, body?: JsonValue): Promise<Response> =>
    kit(run, `${HOLDS_PATH}/${String(id)}`, 'DELETE', body)
  const titles = async (run: string, tenant = 's1'): Promise<string[]> => {
    const res = await fetch(under(run, '/boards/brd_1/cards'), {
      headers: { 'x-mirage-tenant': tenant, [SETUP_HEADER]: '1' },
    })
    return ((await res.json()) as { cards: { title: string }[] }).cards.map((c) => c.title)
  }
  const create = (run: string, title: string, setup = false): Promise<Response> =>
    fetch(under(run, '/boards/brd_1/cards'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mirage-tenant': 's1',
        ...(setup ? { [SETUP_HEADER]: '1' } : {}),
      },
      body: JSON.stringify({ title }),
    })
  try {
    await runtime.reset({ run: 'a', tenants: ['s1', 's2'] })
    const before = await titles('a')

    const id = await hold('a', NEW_CARD)
    const held = create('a', 'held')
    assert.deepEqual(
      await caught('a', id),
      { method: 'POST', route: '/boards/:board/cards', path: '/boards/brd_1/cards' },
      'a hold answers the request it caught',
    )
    assert.equal((await create('a', 'theirs', true)).status, 201, 'a write runs while one is held')
    assert.deepEqual(await titles('a'), [...before, 'theirs'], 'the held request has not run')
    assert.deepEqual(await (await release('a', id)).json(), { caught: true })
    assert.equal((await held).status, 201)
    assert.deepEqual(
      await titles('a'),
      [...before, 'theirs', 'held'],
      'a release runs the held request on the world the test left',
    )

    const refused = await hold('a', NEW_CARD)
    const answered = create('a', 'never')
    await caught('a', refused)
    await release('a', refused, { status: 500 })
    assert.equal((await answered).status, 500, 'a release with a status answers with it instead')
    assert.deepEqual(await titles('a'), [...before, 'theirs', 'held'], 'and the request never ran')

    const either = await hold('a', CARDS, NEW_CARD)
    const listing = fetch(under('a', '/boards/brd_1/cards'), {
      headers: { 'x-mirage-tenant': 's1' },
    })
    assert.equal(
      ((await caught('a', either)) as { method: string }).method,
      'GET',
      'a hold catches the first request to any route it names',
    )
    assert.equal((await create('a', 'after')).status, 201, 'and only that one')
    await release('a', either)
    assert.equal((await listing).status, 200)

    const queryHold = await kit('a', HOLDS_PATH, 'POST', { routes: [CARDS], query: 'limit=1' })
    const byQuery = ((await queryHold.json()) as { hold: number }).hold
    const plain = await fetch(under('a', '/boards/brd_1/cards'), {
      headers: { 'x-mirage-tenant': 's1' },
    })
    assert.equal(plain.status, 200, 'a hold with a query lets a request without it go on')
    const limited = fetch(under('a', '/boards/brd_1/cards?limit=1'), {
      headers: { 'x-mirage-tenant': 's1' },
    })
    assert.equal(
      ((await caught('a', byQuery)) as { path: string }).path,
      '/boards/brd_1/cards',
      'and catches the one asked with exactly it',
    )
    await release('a', byQuery)
    assert.equal((await limited).status, 200)
    assert.equal(
      (await kit('a', HOLDS_PATH, 'POST', { routes: [CARDS], query: '?limit=1' })).status,
      400,
      'a hold query spelled with its ? is refused',
    )

    const faulted = await hold('a', CARDS)
    const late = fetch(under('a', '/boards/brd_1/cards'), { headers: { 'x-mirage-tenant': 's1' } })
    await caught('a', faulted)
    await kit('a', FAULTS_PATH, 'POST', {
      plans: [{ method: 'GET', route: CARDS[1], status: 503 }],
    })
    await release('a', faulted)
    assert.equal(
      (await late).status,
      503,
      'a fault armed while a request is held is the one it meets',
    )

    const unused = await hold('a', CARDS)
    assert.deepEqual(
      await (await release('a', unused)).json(),
      { caught: false },
      'a release of a hold that caught nothing disarms it',
    )
    assert.equal((await kit('a', `${HOLDS_PATH}/${String(unused)}`, 'GET')).status, 404)

    const waiting = await hold('a', CARDS)
    const wait = kit('a', `${HOLDS_PATH}/${String(waiting)}`, 'GET')
    await runtime.reset({ run: 'a', tenants: ['s1'] })
    assert.equal((await wait).status, 404, 'a reset ends a wait on a hold it forgot')

    const dropped = await hold('a', CARDS)
    const stranded = fetch(under('a', '/boards/brd_1/cards'), {
      headers: { 'x-mirage-tenant': 's1' },
    })
    await caught('a', dropped)
    await runtime.drop('a')
    await assert.rejects(stranded, 'the run ending lets a held request go unanswered')

    await runtime.reset({ run: 'a', tenants: ['s1', 's2'] })
    const armed = await hold('a', CARDS)
    const other = await fetch(under('a', '/boards/brd_1/cards'), {
      headers: { 'x-mirage-tenant': 's2' },
    })
    assert.equal(other.status, 200, "one tenant's hold never catches another's request")
    const setup = await fetch(under('a', '/boards/brd_1/cards'), {
      headers: { 'x-mirage-tenant': 's1', [SETUP_HEADER]: '1' },
    })
    assert.equal(setup.status, 200, 'a setup request is never held')
    assert.deepEqual(await (await release('a', armed)).json(), { caught: false })

    await kit('a', REQUESTS_PATH, 'POST', {})
    await kit('a', FAULTS_PATH, 'POST', {
      plans: [{ method: 'GET', route: CARDS[1], status: 503 }],
    })
    assert.equal((await titles('a')).length > 0, true, 'a setup request is never faulted')
    const listed = (await (await kit('a', REQUESTS_PATH, 'GET')).json()) as {
      requests: RequestReport[]
    }
    assert.deepEqual(listed.requests, [], 'nor listed')

    const text = '{"position":1152922976252290886}'
    await kit('a', FAULTS_PATH, 'DELETE')
    await kit('a', FAULTS_PATH, 'POST', {
      plans: [{ method: 'GET', route: CARDS[1], status: 200, text }],
    })
    const raw = await fetch(under('a', '/boards/brd_1/cards'), {
      headers: { 'x-mirage-tenant': 's1' },
    })
    assert.equal(await raw.text(), text, 'a fault text is sent as written')
    assert.equal(raw.headers.get('content-type'), 'application/json')
    await kit('a', FAULTS_PATH, 'POST', {
      plans: [
        {
          method: 'GET',
          route: CARDS[1],
          status: 200,
          text,
          headers: { 'content-type': 'text/plain' },
        },
      ],
    })
    const typed = await fetch(under('a', '/boards/brd_1/cards'), {
      headers: { 'x-mirage-tenant': 's1' },
    })
    await typed.text()
    assert.equal(
      typed.headers.get('content-type'),
      'text/plain',
      "a plan's own type replaces the default in any case",
    )

    await kit('a', FAULTS_PATH, 'POST', {
      plans: [
        { method: 'GET', route: CARDS[1], path: '/boards/brd_2/cards', status: 403, times: 9 },
      ],
    })
    const one = (board: string): Promise<Response> =>
      fetch(under('a', `/boards/${board}/cards`), { headers: { 'x-mirage-tenant': 's1' } })
    assert.deepEqual(
      [(await one('brd_1')).status, (await one('brd_2')).status, (await one('brd_2')).status],
      [200, 403, 403],
      'a plan that names a path answers only requests to it',
    )
    const scoped = (await (await kit('a', FAULTS_PATH, 'GET')).json()) as { plans: FaultReport[] }
    assert.deepEqual(
      scoped.plans.at(-1),
      { method: 'GET', route: CARDS[1], path: '/boards/brd_2/cards', times: 9, served: 2 },
      'the report names the path a plan answers',
    )

    await kit('a', FAULTS_PATH, 'DELETE')
    await kit('a', FAULTS_PATH, 'POST', {
      plans: [{ method: 'GET', route: CARDS[1], query: '', status: 403, times: 9 }],
    })
    const asked = (query: string): Promise<Response> =>
      fetch(under('a', `/boards/brd_1/cards${query}`), { headers: { 'x-mirage-tenant': 's1' } })
    assert.deepEqual(
      [(await asked('?limit=1')).status, (await asked('')).status],
      [200, 403],
      'a plan that names a query answers only requests asked with exactly it',
    )
    const queried = (await (await kit('a', FAULTS_PATH, 'GET')).json()) as {
      plans: FaultReport[]
    }
    assert.deepEqual(
      queried.plans.at(-1),
      { method: 'GET', route: CARDS[1], query: '', times: 9, served: 1 },
      'the report names the query a plan answers',
    )
    assert.equal(
      (
        await kit('a', FAULTS_PATH, 'POST', {
          plans: [{ method: 'GET', route: CARDS[1], query: '?limit=1', status: 403 }],
        })
      ).status,
      400,
      'a fault query spelled with its ? is refused',
    )

    const badBodies: [JsonValue, string][] = [
      [{ routes: [] }, 'no routes'],
      [{ routes: [['GET', '/nowhere']] }, 'a route the fake does not declare'],
      [{ routes: [['GET']] }, 'a pair that is not one'],
    ]
    for (const [body, why] of badBodies) {
      assert.equal((await kit('a', HOLDS_PATH, 'POST', body)).status, 400, why)
    }
    const kept = await hold('a', CARDS)
    assert.equal(
      (await release('a', kept, { status: 100 })).status,
      400,
      'a release status that is not a final one is refused',
    )
    assert.equal(
      (
        await kit('a', FAULTS_PATH, 'POST', {
          plans: [{ method: 'GET', route: CARDS[1], status: 200, text, body: {} }],
        })
      ).status,
      400,
      'a fault plan with a body and a text is refused',
    )
  } finally {
    await started.close()
  }
  process.stdout.write('hold regressions passed\n')
}
