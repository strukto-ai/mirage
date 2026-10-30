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
import { TokenManager } from '../google/client.ts'
import { appendValues, updateValues } from './write.ts'

const APPEND_URL =
  'http://sheets.local/v4/spreadsheets/sid/values/Tab!A1:append?valueInputOption=USER_ENTERED'
const UPDATE_URL =
  'http://sheets.local/v4/spreadsheets/sid/values/Tab!A1?valueInputOption=USER_ENTERED'

function manager(): TokenManager {
  return new TokenManager({
    clientId: 'id',
    refreshToken: 'rt',
    apiBase: 'http://sheets.local',
    refreshFn: vi.fn().mockResolvedValue({ accessToken: 'tok-1', expiresIn: 3600 }),
  })
}

function respond(status: number, body: string): typeof globalThis.fetch {
  return vi.fn(() =>
    Promise.resolve({
      ok: status < 400,
      status,
      statusText: String(status),
      text: () => Promise.resolve(body),
    }),
  ) as unknown as typeof globalThis.fetch
}

function sentInit(fetch: typeof globalThis.fetch): RequestInit | undefined {
  return vi.mocked(fetch).mock.calls[0]?.[1]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('appendValues', () => {
  it('POSTs the values under auth and returns the parsed reply', async () => {
    const fetch = respond(200, '{"updates":{"updatedCells":2}}')
    vi.stubGlobal('fetch', fetch)
    const out = await appendValues(manager(), 'sid', 'Tab!A1', '[["a","b"]]')
    expect(out).toEqual({ updates: { updatedCells: 2 } })
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(APPEND_URL)
    const init = sentInit(fetch)
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-1')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init?.body as string)).toEqual({ values: [['a', 'b']] })
  })

  it('reports the response body through the shared Google error', async () => {
    vi.stubGlobal('fetch', respond(400, 'boom'))
    await expect(appendValues(manager(), 'sid', 'Tab!A1', '[[1]]')).rejects.toThrow('boom')
  })

  it('refuses malformed values before any request goes out', async () => {
    const fetch = respond(200, '{}')
    vi.stubGlobal('fetch', fetch)
    await expect(appendValues(manager(), 'sid', 'Tab!A1', 'not json')).rejects.toThrow(
      /^Invalid JSON: /,
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('updateValues', () => {
  it('PUTs the values under auth and returns the parsed reply', async () => {
    const fetch = respond(200, '{"updatedCells":1}')
    vi.stubGlobal('fetch', fetch)
    const out = await updateValues(manager(), 'sid', 'Tab!A1', '[["x"]]')
    expect(out).toEqual({ updatedCells: 1 })
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(UPDATE_URL)
    const init = sentInit(fetch)
    expect(init?.method).toBe('PUT')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-1')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init?.body as string)).toEqual({ values: [['x']] })
  })

  it('reports the response body through the shared Google error', async () => {
    vi.stubGlobal('fetch', respond(500, 'nope'))
    await expect(updateValues(manager(), 'sid', 'Tab!A1', '[[1]]')).rejects.toThrow('nope')
  })

  it('refuses malformed values before any request goes out', async () => {
    const fetch = respond(200, '{}')
    vi.stubGlobal('fetch', fetch)
    await expect(updateValues(manager(), 'sid', 'Tab!A1', '{oops')).rejects.toThrow(
      /^Invalid JSON: /,
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})
