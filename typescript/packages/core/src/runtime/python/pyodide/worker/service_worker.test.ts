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

import { describe, expect, it } from 'vitest'
import { serviceWorker } from '../../../../../tests/runtime/python/pyodide/fixtures/service_worker.ts'
import { FORMAT, PARAM } from './transport.ts'

const PAGE = 'https://app.test/index.html'

function answer(id: string, body: string, format: string): Request {
  return new Request(`${PAGE}?${PARAM}=answer&id=${id}`, {
    method: 'POST',
    body,
    headers: { [FORMAT]: format },
  })
}

describe('the pyodide service worker', () => {
  it('lets every request without the bridge parameter through', () => {
    const sw = serviceWorker()
    expect(sw.fetch(new Request(PAGE))).toBeNull()
    expect(sw.fetch(new Request('https://cdn.test/pyodide.mjs?id=1'))).toBeNull()
  })

  it('answers a ping with the bridge header a page without it lacks', async () => {
    const response = await serviceWorker().fetch(new Request(`${PAGE}?${PARAM}=ping`))
    expect(response?.headers.has(FORMAT)).toBe(true)
  })

  it('hands an answer to the request waiting under its id, whichever arrives first', async () => {
    const sw = serviceWorker()
    await sw.fetch(answer('early', '"before"', '0'))
    const late = sw.fetch(new Request(`${PAGE}?${PARAM}=wait&id=late`))
    const early = await sw.fetch(new Request(`${PAGE}?${PARAM}=wait&id=early`))
    await sw.fetch(answer('late', 'after', '1'))
    expect(await early?.text()).toBe('"before"')
    expect(early?.headers.get(FORMAT)).toBe('0')
    const waited = await late
    expect(await waited?.text()).toBe('after')
    expect(waited?.headers.get(FORMAT)).toBe('1')
  })

  it('claims the page when it activates and when the page asks', () => {
    const sw = serviceWorker()
    sw.activate()
    sw.message('claim')
    sw.message('other')
    expect(sw.claims).toBe(2)
  })

  it('takes over at once when first installed, and an update waits for the pages it would take', () => {
    const first = serviceWorker()
    first.install()
    expect(first.skips).toBe(1)
    const update = serviceWorker(true)
    update.install()
    expect(update.skips).toBe(0)
  })
})
