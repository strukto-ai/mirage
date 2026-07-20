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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DOCS_API_BASE,
  DRIVE_API_BASE,
  DRIVE_UPLOAD_BASE,
  GMAIL_API_BASE,
  SHEETS_API_BASE,
  SLIDES_API_BASE,
  TOKEN_URL,
  TokenManager,
  docsBase,
  driveBase,
  driveUploadBase,
  gmailBase,
  refreshAccessToken,
  sheetsBase,
  slidesBase,
  tokenUrl,
} from './_client.ts'

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
      text: () => Promise.resolve(''),
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
    expect(gmailBase(tm)).toBe(GMAIL_API_BASE)
    expect(tokenUrl()).toBe(TOKEN_URL)
  })
})
