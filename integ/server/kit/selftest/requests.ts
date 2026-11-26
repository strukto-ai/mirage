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
import { request } from 'node:http'
import { FAULTS_PATH } from '../typescript/fault.ts'
import { REQUESTS_PATH } from '../typescript/request.ts'
import type { RequestReport } from '../typescript/request.ts'
import { start } from '../typescript/serve.ts'
import { selftestFake } from './fake.ts'

const CARDS = { method: 'GET', route: '/boards/:board/cards', path: '/boards/brd_1/cards' }
const BOARDS = { method: 'GET', route: '/boards', path: '/boards' }
const NEW_CARD = { method: 'POST', route: '/boards/:board/cards', path: '/boards/brd_1/cards' }

export async function runRequestTests(): Promise<void> {
  const started = await start(selftestFake, 0)
  const { runtime, endpoint } = started
  const under = (run: string, path: string): string => `${endpoint}/_run/${run}${path}`
  const ask = (run: string, path: string, tenant = 's1', method = 'GET'): Promise<Response> =>
    fetch(under(run, path), { method, headers: { 'x-mirage-tenant': tenant } })
  const requests = async (run: string, tenant = 's1', method = 'GET'): Promise<RequestReport[]> => {
    const res = await ask(run, REQUESTS_PATH, tenant, method)
    assert.equal(res.status, 200)
    return ((await res.json()) as { requests: RequestReport[] }).requests
  }
  try {
    for (const run of ['a', 'b']) await runtime.reset({ run, tenants: ['s1', 's2'] })

    await ask('a', '/boards')
    assert.deepEqual(await requests('a'), [], 'nothing is kept before a start')

    assert.deepEqual(await requests('a', 's1', 'POST'), [])
    await ask('a', '/boards/brd_1/cards?limit=1')
    await ask('a', '/boards')
    await ask('a', '/boards', 's2')
    await ask('b', '/boards')
    await ask('a', '/nowhere')
    assert.deepEqual(
      await requests('a'),
      [CARDS, BOARDS],
      'a tenant lists its own routed requests in order, with no query and none to the kit',
    )
    assert.deepEqual(await requests('a', 's2'), [], 'another tenant started nothing')

    const armed = await fetch(under('a', FAULTS_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mirage-tenant': 's1' },
      body: JSON.stringify({
        plans: [{ method: 'GET', route: '/boards/:board/cards', status: 500 }],
      }),
    })
    assert.equal(armed.status, 200)
    assert.equal((await ask('a', '/boards/brd_1/cards')).status, 500)
    assert.deepEqual(await requests('a'), [CARDS, BOARDS, CARDS], 'a faulted request is listed')

    assert.deepEqual(await requests('a', 's1', 'POST'), [], 'starting again empties it')
    await ask('a', '/boards')
    assert.deepEqual(await requests('a', 's1', 'DELETE'), [BOARDS], 'DELETE answers what it kept')
    await ask('a', '/boards')
    assert.deepEqual(await requests('a'), [], 'nothing is kept after a stop')

    await requests('a', 's1', 'POST')
    const seen = new Promise<void>((resolve) => {
      started.server.once('request', () => {
        resolve()
      })
    })
    const upload = request(under('a', '/boards/brd_1/cards'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mirage-tenant': 's1' },
    })
    const uploaded = new Promise<number>((resolve, reject) => {
      upload.on('response', (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      upload.on('error', reject)
    })
    upload.write('{"title":')
    await seen
    await ask('a', '/boards')
    upload.end('"slow"}')
    assert.equal(await uploaded, 201)
    assert.deepEqual(
      await requests('a'),
      [NEW_CARD, BOARDS],
      'an upload still sending when a later GET is answered is listed first',
    )

    await requests('a', 's1', 'POST')
    await ask('a', '/boards')
    await runtime.reset({ run: 'a', tenants: ['s1'] })
    await ask('a', '/boards')
    assert.deepEqual(await requests('a'), [], 'a reset of the tenant stops it')

    assert.equal(
      (await ask('a', REQUESTS_PATH, 's1', 'PUT')).status,
      405,
      'another method on the hook is refused by the kit, not the fake',
    )
  } finally {
    await started.close()
  }
  process.stdout.write('request list regressions passed\n')
}
