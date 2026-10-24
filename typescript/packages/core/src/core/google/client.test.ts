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
  READ_RETRY,
  TokenManager,
  docsBase,
  calendarBase,
  driveBase,
  formsBase,
  driveUploadBase,
  googleDelete,
  googleGet,
  googleGetBytes,
  googleGetStream,
  googlePatch,
  googlePost,
  googleRequest,
  googleSendBytes,
  refreshAccessToken,
  sheetsBase,
  slidesBase,
  tokenUrl,
  transient,
} from './client.ts'
import { appendValues, updateValues } from '../gsheets/write.ts'
import { ManualClock, SystemClock } from '../../utils/clock.ts'
import { TokenManager as OAuthTokenManager } from '../api/oauth.ts'

import {
  DOCS_API_BASE,
  CALENDAR_API_BASE,
  DRIVE_API_BASE,
  FORMS_API_BASE,
  DRIVE_UPLOAD_BASE,
  MAX_RETRIES,
  SHEETS_API_BASE,
  SLIDES_API_BASE,
  TOKEN_BUFFER_SECONDS,
  TOKEN_URL,
} from './constants.ts'

class WaitLog extends ManualClock {
  constructor(private readonly waits: number[]) {
    super()
  }

  override async sleep(seconds: number): Promise<void> {
    this.waits.push(seconds)
    await super.sleep(seconds)
  }
}

class SeededTokenManager extends OAuthTokenManager {
  constructor() {
    super()
    this.seed('minted', Number.POSITIVE_INFINITY)
  }

  protected refreshPair(): Promise<[string, number]> {
    return Promise.reject(new Error('a seeded token never refreshes'))
  }
}

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

  it('refreshes when the token expires on its clock', async () => {
    const clock = new ManualClock(1_000)
    const refreshFn = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: 'token-1', expiresIn: 3600 })
      .mockResolvedValueOnce({ accessToken: 'token-2', expiresIn: 3600 })
    const tm = new TokenManager({ clientId: 'id', refreshToken: 'rt', refreshFn }, clock)
    expect(await tm.getToken()).toBe('token-1')
    clock.advance(3600 - TOKEN_BUFFER_SECONDS - 1)
    expect(await tm.getToken()).toBe('token-1')
    clock.advance(1)
    expect(await tm.getToken()).toBe('token-2')
  })

  it('binding another clock drops a refreshed token', async () => {
    const refreshFn = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: 'token-1', expiresIn: 3600 })
      .mockResolvedValueOnce({ accessToken: 'token-2', expiresIn: 3600 })
    const tm = new TokenManager({ clientId: 'id', refreshToken: 'rt', refreshFn })
    expect(await tm.getToken()).toBe('token-1')
    tm.bindClock(tm.clock)
    expect(await tm.getToken()).toBe('token-1')
    tm.bindClock(new ManualClock())
    expect(await tm.getToken()).toBe('token-2')
  })

  it('binding another system clock keeps a refreshed token', async () => {
    const refreshFn = vi.fn().mockResolvedValue({ accessToken: 'token-1', expiresIn: 3600 })
    const tm = new TokenManager({ clientId: 'id', refreshToken: 'rt', refreshFn })
    expect(await tm.getToken()).toBe('token-1')
    tm.bindClock(new SystemClock())
    expect(await tm.getToken()).toBe('token-1')
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('binding another clock keeps a seeded token', async () => {
    const tm = new SeededTokenManager()
    tm.bindClock(new ManualClock())
    expect(await tm.getToken()).toBe('minted')
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

const FILES = 'https://drive.test/drive/v3/files'

function reason(code: number, why: string): string {
  return JSON.stringify({
    error: { code, message: why, errors: [{ domain: 'usageLimits', reason: why }] },
  })
}

function reply(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

type Call = (tm: TokenManager) => Promise<unknown>

const READS: [string, Call][] = [
  ['googleGet', (tm) => googleGet(tm, FILES)],
  ['googleGetBytes', (tm) => googleGetBytes(tm, FILES)],
  [
    'googleGetStream',
    async (tm) => {
      for await (const _chunk of googleGetStream(tm, FILES)) void _chunk
    },
  ],
]

const WRITES: [string, Call][] = [
  ['googlePost', (tm) => googlePost(tm, FILES, { name: 'a' })],
  ['googlePatch', (tm) => googlePatch(tm, FILES, { name: 'a' })],
  [
    'googleSendBytes',
    (tm) => googleSendBytes(tm, 'POST', FILES, new Uint8Array([1]), 'text/plain'),
  ],
  ['googleDelete', (tm) => googleDelete(tm, FILES)],
  ['appendValues', (tm) => appendValues(tm, 's1', 'A1', '[[1]]')],
  ['updateValues', (tm) => updateValues(tm, 's1', 'A1', '[[1]]')],
]

function dropped(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('terminated'))
      },
    }),
  )
}

function serve(...replies: (Response | Error)[]): ReturnType<typeof vi.fn> {
  const fake = vi.fn()
  for (const r of replies) {
    if (r instanceof Error) fake.mockRejectedValueOnce(r)
    else fake.mockResolvedValueOnce(r)
  }
  globalThis.fetch = fake as unknown as typeof fetch
  return fake
}

describe('google retry policy', () => {
  let previous: typeof fetch
  let tm: TokenManager
  let waits: number[]

  beforeEach(() => {
    previous = globalThis.fetch
    waits = []
    tm = new TokenManager({ clientId: 'c', refreshToken: 'r' }, new WaitLog(waits))
    vi.spyOn(tm, 'getToken').mockResolvedValue('tok')
  })

  afterEach(() => {
    globalThis.fetch = previous
  })

  it('a 403 waits only for a rate-limit reason', () => {
    expect(transient(403, reason(403, 'userRateLimitExceeded'))).toBe(true)
    expect(transient(403, reason(403, 'rateLimitExceeded'))).toBe(true)
    expect(transient(403, reason(403, 'insufficientFilePermissions'))).toBe(false)
    expect(transient(403, reason(403, 'dailyLimitExceeded'))).toBe(false)
    expect(transient(403, 'Forbidden')).toBe(false)
    expect(transient(403, '{"error": "denied"}')).toBe(false)
    expect(transient(403, '{"error": {"errors": [{"reason": ["x"]}]}}')).toBe(false)
    expect(transient(429, '')).toBe(true)
    expect(transient(503, '')).toBe(true)
  })

  it.each(READS)('%s retries a 5xx and a dropped connection', async (_name, call) => {
    const fake = serve(
      reply(503, '', { 'Retry-After': '2' }),
      new TypeError('fetch failed'),
      reply(200, '{}'),
    )
    await call(tm)
    expect(fake).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([2, 2])
  })

  it.each(WRITES)('%s retries a throttle but never a 5xx', async (_name, call) => {
    const fake = serve(
      reply(429, '', { 'Retry-After': '0' }),
      reply(403, reason(403, 'userRateLimitExceeded'), { 'Retry-After': '0' }),
      reply(503),
    )
    await expect(call(tm)).rejects.toMatchObject({ status: 503 })
    expect(fake).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([0, 0])
  })

  it.each(WRITES)('%s never retries a dropped connection', async (_name, call) => {
    const fake = serve(new TypeError('fetch failed'))
    await expect(call(tm)).rejects.toThrow('fetch failed')
    expect(fake).toHaveBeenCalledTimes(1)
  })

  it.each([...READS, ...WRITES])('%s treats a permission 403 as final', async (_name, call) => {
    const fake = serve(reply(403, reason(403, 'insufficientFilePermissions')))
    await expect(call(tm)).rejects.toMatchObject({ status: 403 })
    expect(fake).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
  })

  it.each([
    ['GET', undefined],
    ['HEAD', undefined],
    ['POST', READ_RETRY],
  ] as [string, typeof READ_RETRY | undefined][])(
    'the request door retries a read by method: %s',
    async (method, retry) => {
      const fake = serve(reply(503), reply(200, '{"ok":true}'))
      await expect(googleRequest(tm, method, FILES, { retry })).resolves.toEqual({ ok: true })
      expect(fake).toHaveBeenCalledTimes(2)
    },
  )

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    'the request door never retries a write 5xx: %s',
    async (method) => {
      const fake = serve(reply(503), reply(200, '{"ok":true}'))
      await expect(googleRequest(tm, method, FILES)).rejects.toMatchObject({ status: 503 })
      expect(fake).toHaveBeenCalledOnce()
    },
  )

  it('a persistent 5xx surfaces after the budget', async () => {
    const fake = serve(
      ...Array.from({ length: MAX_RETRIES + 1 }, () =>
        reply(500, '{"error": {"message": "boom"}}'),
      ),
    )
    await expect(googleGet(tm, FILES)).rejects.toMatchObject({ status: 500 })
    expect(fake).toHaveBeenCalledTimes(MAX_RETRIES + 1)
    expect(waits).toEqual([1, 2, 4])
  })

  it('a read timeout is retried', async () => {
    serve(new DOMException('timed out', 'TimeoutError'), reply(200, '{"files":[]}'))
    await expect(googleGet(tm, FILES)).resolves.toEqual({ files: [] })
    expect(waits).toEqual([1])
  })

  it('the token exchange retries a 5xx', async () => {
    serve(
      reply(503, '', { 'Retry-After': '3' }),
      reply(200, '{"access_token":"t","expires_in":60}'),
    )
    const record = (seconds: number): Promise<void> => {
      waits.push(seconds)
      return Promise.resolve()
    }
    await expect(refreshAccessToken({ clientId: 'c', refreshToken: 'r' }, record)).resolves.toEqual(
      ['t', 60],
    )
    expect(waits).toEqual([3])
  })

  it('the token exchange and an upload start retry a body that drops', async () => {
    serve(dropped(), reply(200, '{"access_token":"t","expires_in":60}'))
    await expect(
      refreshAccessToken({ clientId: 'c', refreshToken: 'r' }, (seconds) =>
        tm.clock.sleep(seconds),
      ),
    ).resolves.toEqual(['t', 60])
    const spool = new ByteSpool()
    await spool.append(new TextEncoder().encode('abc'))
    const fake = serve(
      dropped(),
      reply(200, '', { Location: 'https://example.test/upload' }),
      reply(200, '{"id":"up"}'),
    )
    try {
      await expect(
        googleResumable(tm, 'POST', 'https://example.test/start', {}, spool, 'text/plain', {}),
      ).resolves.toEqual({ id: 'up' })
      expect(fake).toHaveBeenCalledTimes(3)
    } finally {
      await spool.close()
    }
  })

  it('a resumable upload retries its start but not a chunk', async () => {
    const spool = new ByteSpool()
    await spool.append(new TextEncoder().encode('abc'))
    const fake = serve(
      reply(503, '', { 'Retry-After': '1' }),
      reply(200, '', { Location: 'https://example.test/upload' }),
      reply(503),
    )
    try {
      await expect(
        googleResumable(tm, 'POST', 'https://example.test/start', {}, spool, 'text/plain', {}),
      ).rejects.toMatchObject({ status: 503 })
      const methods = (fake.mock.calls as [string, RequestInit][]).map((c) => c[1].method)
      expect(methods).toEqual(['POST', 'POST', 'PUT'])
      expect(waits).toEqual([1])
    } finally {
      await spool.close()
    }
  })
})
