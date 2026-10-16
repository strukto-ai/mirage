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

import { ByteSpool } from '../../io/spool.ts'
import { googleResumable } from './client.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TokenManager,
  docsBase,
  calendarBase,
  driveBase,
  formsBase,
  driveUploadBase,
  refreshAccessToken,
  sheetsBase,
  slidesBase,
  tokenUrl,
} from './client.ts'
import {
  DOCS_API_BASE,
  CALENDAR_API_BASE,
  DRIVE_API_BASE,
  FORMS_API_BASE,
  DRIVE_UPLOAD_BASE,
  SHEETS_API_BASE,
  SLIDES_API_BASE,
  TOKEN_URL,
} from './constants.ts'

describe('refreshAccessToken — clientSecret optionality', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function fakeOk(body: object): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response) as unknown as typeof fetch
  }

  function bodyAsParams(fakeFetch: typeof fetch): URLSearchParams {
    const init = (fakeFetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as
      | RequestInit
      | undefined
    const raw = init?.body
    return new URLSearchParams(typeof raw === 'string' ? raw : '')
  }

  it('omits client_secret from the body when undefined (PKCE path)', async () => {
    const fakeFetch = fakeOk({ access_token: 'atk', expires_in: 3600 })
    globalThis.fetch = fakeFetch
    await refreshAccessToken({ clientId: 'id', refreshToken: 'rt' })
    const params = bodyAsParams(fakeFetch)
    expect(params.has('client_secret')).toBe(false)
    expect(params.get('client_id')).toBe('id')
    expect(params.get('refresh_token')).toBe('rt')
    expect(params.get('grant_type')).toBe('refresh_token')
  })

  it('omits client_secret when explicitly empty string', async () => {
    const fakeFetch = fakeOk({ access_token: 'atk', expires_in: 3600 })
    globalThis.fetch = fakeFetch
    await refreshAccessToken({ clientId: 'id', clientSecret: '', refreshToken: 'rt' })
    expect(bodyAsParams(fakeFetch).has('client_secret')).toBe(false)
  })

  it('includes client_secret when supplied (Node-style backwards compat)', async () => {
    const fakeFetch = fakeOk({ access_token: 'atk', expires_in: 3600 })
    globalThis.fetch = fakeFetch
    await refreshAccessToken({ clientId: 'id', clientSecret: 'secret', refreshToken: 'rt' })
    expect(bodyAsParams(fakeFetch).get('client_secret')).toBe('secret')
  })

  it('returns the token + expires tuple unchanged', async () => {
    globalThis.fetch = fakeOk({ access_token: 'atk', expires_in: 1234 })
    const [tok, exp] = await refreshAccessToken({ clientId: 'id', refreshToken: 'rt' })
    expect(tok).toBe('atk')
    expect(exp).toBe(1234)
  })
})

describe('TokenManager.refreshFn delegation', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('uses refreshFn when provided and never hits Google', async () => {
    const networkSpy = vi.fn()
    globalThis.fetch = networkSpy as unknown as typeof fetch
    const refreshFn = vi.fn().mockResolvedValue({ accessToken: 'proxy-tok', expiresIn: 3600 })
    const tm = new TokenManager({ clientId: 'id', refreshToken: 'rt', refreshFn })
    const got = await tm.getToken()
    expect(got).toBe('proxy-tok')
    expect(refreshFn).toHaveBeenCalledTimes(1)
    expect(refreshFn).toHaveBeenCalledWith('rt')
    expect(networkSpy).not.toHaveBeenCalled()
  })

  it('falls back to Google when refreshFn is absent', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ access_token: 'direct-tok', expires_in: 3600 }),
      text: () => Promise.resolve(JSON.stringify({ access_token: 'direct-tok', expires_in: 3600 })),
    } as unknown as Response) as unknown as typeof fetch
    globalThis.fetch = fakeFetch
    const tm = new TokenManager({ clientId: 'id', clientSecret: 's', refreshToken: 'rt' })
    const got = await tm.getToken()
    expect(got).toBe('direct-tok')
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })

  it('caches the token until expiry — second call reuses without re-invoking refreshFn', async () => {
    const refreshFn = vi.fn().mockResolvedValue({ accessToken: 'cached-tok', expiresIn: 3600 })
    const tm = new TokenManager({ clientId: 'id', refreshToken: 'rt', refreshFn })
    await tm.getToken()
    await tm.getToken()
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })
})

describe('api base helpers', () => {
  it('default to the real google hosts', () => {
    const tm = new TokenManager({ clientId: 'cid', refreshToken: 'rt' })
    expect(driveBase(tm)).toBe(DRIVE_API_BASE)
    expect(driveUploadBase(tm)).toBe(DRIVE_UPLOAD_BASE)
    expect(docsBase(tm)).toBe(DOCS_API_BASE)
    expect(slidesBase(tm)).toBe(SLIDES_API_BASE)
    expect(sheetsBase(tm)).toBe(SHEETS_API_BASE)
    expect(calendarBase(tm)).toBe(CALENDAR_API_BASE)
    expect(formsBase(tm)).toBe(FORMS_API_BASE)
    expect(tokenUrl(tm.config)).toBe(TOKEN_URL)
  })

  it('apiBase override rewrites every service', () => {
    const tm = new TokenManager({
      clientId: 'cid',
      refreshToken: 'rt',
      apiBase: 'http://127.0.0.1:19999',
    })
    expect(driveBase(tm)).toBe('http://127.0.0.1:19999/drive/v3')
    expect(driveUploadBase(tm)).toBe('http://127.0.0.1:19999/upload/drive/v3')
    expect(docsBase(tm)).toBe('http://127.0.0.1:19999/v1')
    expect(slidesBase(tm)).toBe('http://127.0.0.1:19999/v1')
    expect(sheetsBase(tm)).toBe('http://127.0.0.1:19999/v4')
    expect(calendarBase(tm)).toBe('http://127.0.0.1:19999/calendar/v3')
    expect(formsBase(tm)).toBe('http://127.0.0.1:19999/v1')
    expect(tokenUrl(tm.config)).toBe('http://127.0.0.1:19999/token')
  })
})

describe('TokenManager.accessToken short-circuit', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('a supplied token skips the refresh grant entirely', async () => {
    const networkSpy = vi.fn()
    globalThis.fetch = networkSpy as unknown as typeof fetch
    const tm = new TokenManager({ accessToken: 'sa-token' })
    expect(await tm.getToken()).toBe('sa-token')
    expect(networkSpy).not.toHaveBeenCalled()
  })

  // The provider owns the refresh, so caching its answer here would outlive
  // the rotation it just performed.
  it('a provider is called every request, never cached', async () => {
    const tokens = ['tok-1', 'tok-2', 'tok-3']
    const tm = new TokenManager({ accessToken: () => tokens.shift() ?? '' })
    expect([await tm.getToken(), await tm.getToken(), await tm.getToken()]).toEqual([
      'tok-1',
      'tok-2',
      'tok-3',
    ])
  })

  it('the refresh grant names what it is missing', async () => {
    await expect(refreshAccessToken({ accessToken: 'tok' })).rejects.toThrow(
      /needs clientId and refreshToken/,
    )
  })
})

it.each([true, false])('resumable upload honors acknowledged ranges: %s', async (advance) => {
  const tm = new TokenManager({ clientId: 'c', refreshToken: 'r' })
  vi.spyOn(tm, 'getToken').mockResolvedValue('token')
  const total = 8 * 1024 * 1024 + 17
  const spool = new ByteSpool()
  await spool.append(new Uint8Array(total))
  const fake = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, { status: 200, headers: { Location: 'https://example.test/upload' } }),
    )
    .mockResolvedValueOnce(
      new Response(null, { status: 308, headers: advance ? { Range: 'bytes=0-4194303' } : {} }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'done' }), { status: 200 }))
  const previous = globalThis.fetch
  globalThis.fetch = fake
  try {
    const result = googleResumable(
      tm,
      'POST',
      'https://example.test/start',
      {},
      spool,
      'text/plain',
      {},
    )
    if (advance) {
      await expect(result).resolves.toEqual({ id: 'done' })
      const calls = fake.mock.calls as [string, RequestInit][]
      expect((calls[1]?.[1].body as Uint8Array).length).toBe(8 * 1024 * 1024)
      expect((calls[2]?.[1].body as Uint8Array).length).toBe(total - 4 * 1024 * 1024)
      expect(calls[2]?.[1].headers).toMatchObject({
        'Content-Range': `bytes 4194304-${String(total - 1)}/${String(total)}`,
      })
    } else await expect(result).rejects.toThrow('no progress')
  } finally {
    globalThis.fetch = previous
    await spool.close()
  }
})
