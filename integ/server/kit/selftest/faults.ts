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
import { start } from '../typescript/serve.ts'
import type { JsonValue } from '../typescript/types.ts'
import { selftestFake } from './fake.ts'

export async function runFaultTests(): Promise<void> {
  const started = await start(selftestFake, 0)
  const { runtime, endpoint } = started
  const under = (run: string, path: string): string => `${endpoint}/_run/${run}${path}`
  const arm = async (run: string, body: JsonValue, tenant = 's1'): Promise<Response> =>
    fetch(under(run, FAULTS_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mirage-tenant': tenant },
      body: JSON.stringify(body),
    })
  const listed = async (run: string, tenant = 's1', method = 'GET'): Promise<FaultReport[]> => {
    const res = await fetch(under(run, FAULTS_PATH), {
      method,
      headers: { 'x-mirage-tenant': tenant },
    })
    assert.equal(res.status, 200)
    return ((await res.json()) as { plans: FaultReport[] }).plans
  }
  const cards = (run: string, tenant = 's1', signal?: AbortSignal): Promise<Response> =>
    fetch(under(run, '/boards/brd_1/cards'), {
      headers: { 'x-mirage-tenant': tenant },
      ...(signal === undefined ? {} : { signal }),
    })
  try {
    for (const run of ['a', 'b']) await runtime.reset({ run, tenants: ['s1', 's2'] })

    const armed = await arm('a', {
      plans: [
        {
          method: 'get',
          route: '/boards/:board/cards',
          times: 2,
          status: 429,
          headers: { 'Retry-After': '7' },
        },
      ],
    })
    assert.equal(armed.status, 200)
    for (let i = 0; i < 2; i += 1) {
      const limited = await cards('a')
      assert.equal(limited.status, 429, 'an armed route answers the plan')
      assert.equal(limited.headers.get('retry-after'), '7')
      assert.deepEqual(await limited.json(), { error: 'injected_fault', status: 429 })
    }
    assert.equal((await cards('a')).status, 200, 'a spent plan lets the route run')
    assert.deepEqual(await listed('a'), [
      { method: 'GET', route: '/boards/:board/cards', times: 2, served: 2 },
    ])

    await arm('a', { plans: [{ method: 'GET', route: '/boards/:board/cards', status: 500 }] })
    assert.equal((await cards('a', 's2')).status, 200, 'another tenant is not faulted')
    assert.equal((await cards('b')).status, 200, 'another run is not faulted')
    assert.equal(
      (await fetch(under('a', '/boards'), { headers: { 'x-mirage-tenant': 's1' } })).status,
      200,
      'another route is not faulted',
    )
    assert.equal((await cards('a')).status, 500)

    const cleared = await listed('a', 's1', 'DELETE')
    assert.deepEqual(
      cleared.map((p) => p.served),
      [2, 1],
      'DELETE answers what it disarmed',
    )
    assert.deepEqual(await listed('a'), [])

    await arm('a', {
      plans: [
        {
          method: 'POST',
          route: '/boards/:board/cards',
          status: 503,
          body: { message: 'later' },
        },
      ],
    })
    const before = await runtime.pool.client('a').card.count({ where: { tenant: 's1' } })
    const write = await fetch(under('a', '/boards/brd_1/cards'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mirage-tenant': 's1' },
      body: JSON.stringify({ title: 'never' }),
    })
    assert.equal(write.status, 503)
    assert.deepEqual(await write.json(), { message: 'later' })
    assert.equal(
      await runtime.pool.client('a').card.count({ where: { tenant: 's1' } }),
      before,
      'a faulted write never reaches its handler',
    )

    await arm('a', {
      plans: [{ method: 'GET', route: '/boards/:board/cards', delay_ms: 5_000 }],
    })
    await assert.rejects(
      cards('a', 's1', AbortSignal.timeout(100)),
      { name: 'TimeoutError' },
      'a hang outlasts the client timeout',
    )
    await arm('a', { plans: [{ method: 'GET', route: '/boards/:board/cards', delay_ms: 0 }] })
    await assert.rejects(cards('a'), 'no status closes the socket unanswered')
    await arm('a', {
      plans: [{ method: 'GET', route: '/boards/:board/cards', status: 503, delay_ms: 150 }],
    })
    const slowStart = performance.now()
    assert.equal((await cards('a')).status, 503)
    assert(performance.now() - slowStart >= 140, 'a delayed reply waits before answering')

    await arm('a', { plans: [{ method: 'GET', route: '/boards/:board/cards', status: 500 }] })
    await runtime.reset({ run: 'a', tenants: ['s1'] })
    assert.deepEqual(await listed('a'), [], 'a reset of the tenant disarms it')
    assert.equal((await cards('a')).status, 200)

    const refused = [
      [{ plans: [{ method: 'GET', route: '/boards/:id/cards', status: 500 }] }, 'unknown route'],
      [{ plans: [{ method: 'GET', route: '/boards/:board/cards' }] }, 'no status or delay'],
      [
        { plans: [{ method: 'GET', route: '/boards/:board/cards', delay_ms: 1, body: {} }] },
        'body',
      ],
      [{ plans: [{ method: 'GET', route: '/boards/:board/cards', status: 700 }] }, 'status'],
      [{ plans: [{ method: 'GET', route: '/boards/:board/cards', delay_ms: 2 ** 31 }] }, 'delay'],
      [
        { plans: [{ method: 'GET', route: '/boards/:board/cards', times: 0, status: 500 }] },
        'times',
      ],
      [{ plans: [{ method: 'GET', route: '/boards/:board/cards', status: 500, why: 1 }] }, 'field'],
      [{ plan: [] }, 'body field'],
    ] as const
    for (const [body, why] of refused) {
      const res = await arm('a', body as unknown as JsonValue)
      assert.equal(res.status, 400, `refused: ${why}`)
      assert.equal(((await res.json()) as { error: string }).error, 'bad_faults')
    }
    const mixed = await arm('a', {
      plans: [
        { method: 'GET', route: '/boards/:board/cards', status: 500 },
        { method: 'GET', route: '/nowhere', status: 500 },
      ],
    })
    assert.equal(mixed.status, 400)
    assert.deepEqual(await listed('a'), [], 'a refused list arms none of its plans')
    const malformed = await fetch(under('a', FAULTS_PATH), { method: 'POST', body: '{' })
    assert.equal(malformed.status, 400, 'a malformed body is the caller error')
    assert.equal(
      (await fetch(under('a', FAULTS_PATH), { method: 'PUT' })).status,
      405,
      'another method on the hook is refused by the kit, not the fake',
    )
  } finally {
    await started.close()
  }
  process.stdout.write('fault plan regressions passed\n')
}
