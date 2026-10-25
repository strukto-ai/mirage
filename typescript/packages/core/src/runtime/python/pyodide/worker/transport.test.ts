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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { serviceWorker } from '../../../../../tests/runtime/python/pyodide/fixtures/service_worker.ts'
import { enoent } from '../../../../errors/fs.ts'
import { answerOverBridge, bridged, FORMAT, PARAM, requestOverBridge } from './transport.ts'
import type { VfsRequest } from './types.ts'

const PAGE = 'https://app.test/index.html'
const ID = '00000000-0000-4000-8000-000000000001'

interface Held {
  status: number
  body: ArrayBuffer
  format: string | null
}

// A synchronous request answered from what the test already took from the
// service worker; a real one blocks until the service worker answers.
function xhrAnswering(held: Held): unknown {
  return class {
    status = 0
    response: ArrayBuffer | null = null
    responseType = ''
    open(_method: string, url: string, async: boolean): void {
      expect(url).toBe(`${PAGE}?${PARAM}=wait&id=${ID}`)
      expect(async).toBe(false)
    }
    send(): void {
      this.status = held.status
      this.response = held.body
    }
    getResponseHeader(name: string): string | null {
      return name === FORMAT ? held.format : null
    }
  }
}

/** One call carried the way a worker without shared memory makes it. */
async function bridgedCall(operation: () => Promise<unknown>): Promise<unknown> {
  const sw = serviceWorker()
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => sw.fetch(new Request(url, init)))
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(ID)
  await answerOverBridge(PAGE, ID, operation)
  const waited = await sw.fetch(new Request(`${PAGE}?${PARAM}=wait&id=${ID}`))
  if (waited === null) throw new Error('the service worker let the wait through')
  vi.stubGlobal(
    'XMLHttpRequest',
    xhrAnswering({
      status: waited.status,
      body: await waited.arrayBuffer(),
      format: waited.headers.get(FORMAT),
    }),
  )
  const posted: VfsRequest[] = []
  const value = requestOverBridge(
    (message) => posted.push(message),
    { op: 'stat', path: '/a' },
    PAGE,
  )
  expect(posted).toEqual([{ op: 'stat', path: '/a', kind: 'vfs', id: ID }])
  return value
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the service worker bridge', () => {
  it('carries a value and raw bytes from the host to the worker', async () => {
    expect(await bridgedCall(() => Promise.resolve({ size: 3, isDir: false }))).toEqual({
      size: 3,
      isDir: false,
    })
    expect(await bridgedCall(() => Promise.resolve(new Uint8Array([0, 255, 7])))).toEqual(
      new Uint8Array([0, 255, 7]),
    )
    expect(await bridgedCall(() => Promise.resolve(undefined))).toBeUndefined()
  })

  it('raises the host failure in the worker with its errno', async () => {
    const call = bridgedCall(() => Promise.reject(enoent('/a')))
    await expect(call).rejects.toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('fails the call when no service worker answers it', () => {
    vi.stubGlobal(
      'XMLHttpRequest',
      xhrAnswering({ status: 404, body: new ArrayBuffer(0), format: null }),
    )
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(ID)
    expect(() => requestOverBridge(() => undefined, { op: 'stat', path: '/a' }, PAGE)).toThrow(
      'pyodide filesystem bridge answered 404',
    )
  })

  it('tells a page its service worker answers from one whose server ignores the parameter', async () => {
    const sw = serviceWorker()
    vi.stubGlobal('fetch', (url: string) => sw.fetch(new Request(url)))
    expect(await bridged(PAGE)).toBe(true)
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<!doctype html>')))
    expect(await bridged(PAGE)).toBe(false)
  })
})
