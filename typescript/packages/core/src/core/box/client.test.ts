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
import { boxUploadSession } from './client.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoxTokenManager, boxGetBytes, conflictOf } from './client.ts'
import { BOX_TOKEN_URL } from './constants.ts'
import { ManualClock } from '../../utils/clock.ts'
import type { ByteWindow } from '../../utils/ranges.ts'

const CCG_CONFIG = { clientId: 'cid', clientSecret: 'csec', enterpriseId: '123456' }

function stubToken(token: string, expiresIn: number): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
        status: 200,
      }),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('BoxTokenManager client credentials grant', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mints a service-account token with the enterprise subject', async () => {
    const fetchMock = stubToken('tok1', 3600)
    const tm = new BoxTokenManager(CCG_CONFIG)
    expect(await tm.getToken()).toBe('tok1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(BOX_TOKEN_URL)
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('client_id')).toBe('cid')
    expect(body.get('client_secret')).toBe('csec')
    expect(body.get('box_subject_type')).toBe('enterprise')
    expect(body.get('box_subject_id')).toBe('123456')
  })

  it('caches the token until expiry', async () => {
    const fetchMock = stubToken('tok1', 3600)
    const tm = new BoxTokenManager(CCG_CONFIG)
    await tm.getToken()
    await tm.getToken()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-fetches once the token is past the expiry buffer', async () => {
    const fetchMock = stubToken('tok1', 100)
    const tm = new BoxTokenManager(CCG_CONFIG)
    await tm.getToken()
    await tm.getToken()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('requires clientSecret with enterpriseId', () => {
    expect(() => new BoxTokenManager({ clientId: 'cid', enterpriseId: '123456' })).toThrow(
      'clientSecret is required when using enterpriseId',
    )
  })

  it('requires clientId with enterpriseId', () => {
    expect(() => new BoxTokenManager({ clientSecret: 'csec', enterpriseId: '123456' })).toThrow(
      'clientId is required when using enterpriseId',
    )
  })

  it('mentions the ccg option when no auth material is given', () => {
    expect(() => new BoxTokenManager({})).toThrow('enterpriseId')
  })

  it('prefers the developer token over ccg when both are set', async () => {
    const fetchMock = stubToken('unused', 3600)
    const tm = new BoxTokenManager({ ...CCG_CONFIG, accessToken: 'devtok' })
    expect(await tm.getToken()).toBe('devtok')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces ccg token endpoint failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('invalid_client', { status: 400 })),
    )
    const tm = new BoxTokenManager(CCG_CONFIG)
    await expect(tm.getToken()).rejects.toThrow('Box CCG token → 400')
  })
})

const BODY = '0123456789'

function bytesResponse(status: number, body: string): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(body, { status })))
}

async function getBytes(
  status: number,
  body: string,
  window?: ByteWindow,
): Promise<{ out: Uint8Array; sent: Record<string, string> }> {
  const fetch = bytesResponse(status, body)
  vi.stubGlobal('fetch', fetch)
  const tm = new BoxTokenManager({ ...CCG_CONFIG, accessToken: 'devtok' })
  const out = await boxGetBytes(tm, 'https://api.box.com/2.0/files/1/content', undefined, window)
  const init = vi.mocked(fetch).mock.calls[0]?.[1]
  return { out, sent: (init?.headers ?? {}) as Record<string, string> }
}

describe('boxGetBytes', () => {
  it('sends the window as a Range header', async () => {
    const { sent } = await getBytes(206, '234', { offset: 2, size: 3 })
    expect(sent.Range).toBe('bytes=2-4')
  })

  it('trusts a 206 body as already the window', async () => {
    const { out } = await getBytes(206, '234', { offset: 2, size: 3 })
    expect(new TextDecoder().decode(out)).toBe('234')
  })

  // Box redirects content downloads to a CDN, which may answer the whole
  // object to a Range request. Before this was handled the caller got every
  // byte for what it asked to be a window.
  it('slices locally when the server ignores the range', async () => {
    const { out } = await getBytes(200, BODY, { offset: 2, size: 3 })
    expect(new TextDecoder().decode(out)).toBe('234')
  })

  it('sends no Range and reads whole when no window is asked for', async () => {
    const { out, sent } = await getBytes(200, BODY)
    expect(new TextDecoder().decode(out)).toBe(BODY)
    expect(sent.Range).toBeUndefined()
  })
})

describe('conflictOf', () => {
  it.each([
    [
      'list',
      '{"code":"item_name_in_use","context_info":{"conflicts":[{"type":"folder"}]}}',
      'folder',
    ],
    ['object', '{"context_info":{"conflicts":{"type":"file"}}}', 'file'],
    ['empty', '{"context_info":{"conflicts":[]}}', null],
    ['html', '<html>502 Bad Gateway</html>', null],
    ['deep', '{"a":'.repeat(100000), null],
  ])('reads the item a 409 names: %s', (_name, text, kind) => {
    expect(conflictOf(text)).toBe(kind)
  })
})

it.each([false, true])(
  'upload session commits conditionally and aborts on failure: %s',
  async (fail) => {
    const spool = new ByteSpool()
    await spool.append(new TextEncoder().encode('abcdefg'))
    const base = 'https://example.test/session'
    const fake = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          part_size: 4,
          session_endpoints: { upload_part: base + '/part', commit: base + '/commit', abort: base },
        }),
      )
      .mockResolvedValueOnce(Response.json({ part: { part_id: '1', offset: 0, size: 4 } }))
      .mockResolvedValueOnce(Response.json({ part: { part_id: '2', offset: 4, size: 3 } }))
      .mockResolvedValueOnce(
        Response.json({ entries: [{ id: 'done' }] }, { status: fail ? 500 : 201 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const previous = globalThis.fetch
    globalThis.fetch = fake
    try {
      const result = boxUploadSession(
        new BoxTokenManager({ accessToken: 'token' }),
        base,
        {},
        spool,
        '"version"',
      )
      if (fail) await expect(result).rejects.toThrow()
      else await expect(result).resolves.toEqual({ entries: [{ id: 'done' }] })
      const calls = fake.mock.calls as [string, RequestInit][]
      expect(new TextDecoder().decode(calls[1]?.[1].body as Uint8Array)).toBe('abcd')
      expect(new TextDecoder().decode(calls[2]?.[1].body as Uint8Array)).toBe('efg')
      expect(calls[3]?.[1].headers).toMatchObject({
        'If-Match': '"version"',
        Digest: 'sha=L7XhNBn8iSRoZeejJPR27GJOh0A=',
      })
      expect(calls.length).toBe(fail ? 5 : 4)
    } finally {
      globalThis.fetch = previous
      await spool.close()
    }
  },
)

it('upload session waits out a pending commit on its clock', async () => {
  const clock = new ManualClock()
  const tm = new BoxTokenManager({ accessToken: 'token' })
  tm.bindClock(clock, 'ws')
  const spool = new ByteSpool()
  await spool.append(new TextEncoder().encode('abc'))
  const base = 'https://example.test/session'
  const fake = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        part_size: 4,
        session_endpoints: { upload_part: base + '/part', commit: base + '/commit', abort: base },
      }),
    )
    .mockResolvedValueOnce(Response.json({ part: { part_id: '1', offset: 0, size: 3 } }))
    .mockResolvedValueOnce(new Response(null, { status: 202, headers: { 'Retry-After': '7' } }))
    .mockResolvedValueOnce(Response.json({ entries: [{ id: 'done' }] }, { status: 201 }))
  const previous = globalThis.fetch
  globalThis.fetch = fake
  try {
    await expect(boxUploadSession(tm, base, {}, spool)).resolves.toEqual({
      entries: [{ id: 'done' }],
    })
    expect(clock.monotonic()).toBe(7)
  } finally {
    globalThis.fetch = previous
    await spool.close()
  }
})
