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
import {
  DropboxTokenManager,
  dropboxDownload,
  dropboxDownloadStream,
  dropboxRpc,
} from './client.ts'
import type { ByteWindow } from '../../utils/ranges.ts'

const BODY = '0123456789'

function tokenManager(): DropboxTokenManager {
  return new DropboxTokenManager({
    clientId: 'c',
    clientSecret: 's',
    refreshToken: 'r',
    refreshFn: () => Promise.resolve({ accessToken: 'tok', expiresIn: 3600 }),
  })
}

function respond(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): typeof globalThis.fetch {
  return vi.fn(() =>
    Promise.resolve({
      ok: status < 400,
      status,
      headers: new Headers(headers),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
      text: () => Promise.resolve(''),
    }),
  ) as unknown as typeof globalThis.fetch
}

async function download(
  status: number,
  body: string,
  window?: ByteWindow,
): Promise<{ out: Uint8Array; sent: Record<string, string> }> {
  const fetch = respond(status, body)
  vi.stubGlobal('fetch', fetch)
  const [out] = await dropboxDownload(tokenManager(), '/a.txt', window)
  const init = vi.mocked(fetch).mock.calls[0]?.[1]
  return { out, sent: (init?.headers ?? {}) as Record<string, string> }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dropboxDownload', () => {
  it('sends the window as a Range header', async () => {
    const { sent } = await download(206, '234', { offset: 2, size: 3 })
    expect(sent.Range).toBe('bytes=2-4')
  })

  it('trusts a 206 body as already the window', async () => {
    const { out } = await download(206, '234', { offset: 2, size: 3 })
    expect(new TextDecoder().decode(out)).toBe('234')
  })

  // RFC 9110 lets a server answer a Range request with the whole
  // representation. Before this was handled the caller got every byte for
  // what it asked to be a window.
  it('slices locally when the server ignores the range', async () => {
    const { out } = await download(200, BODY, { offset: 2, size: 3 })
    expect(new TextDecoder().decode(out)).toBe('234')
  })

  // A header is a ByteString. From DEL (U+007F) up, every UTF-16 unit goes
  // as \uXXXX, an astral character as its two surrogates; `~` (U+007E) is
  // the last character sent raw. Python's json.dumps escapes the same
  // characters.
  it('escapes the Dropbox-API-Arg path from DEL up', async () => {
    const fetch = respond(200, BODY)
    vi.stubGlobal('fetch', fetch)
    await dropboxDownload(tokenManager(), '/~\u007f\u00e9\u4e2d\u{1f600}')
    const init = vi.mocked(fetch).mock.calls[0]?.[1]
    const sent = (init?.headers ?? {}) as Record<string, string>
    expect(sent['Dropbox-API-Arg']).toBe(String.raw`{"path":"/~\u007f\u00e9\u4e2d\ud83d\ude00"}`)
  })

  it('sends no Range and reads whole when no window is asked for', async () => {
    const { out, sent } = await download(200, BODY)
    expect(new TextDecoder().decode(out)).toBe(BODY)
    expect(sent.Range).toBeUndefined()
  })
})

const RESULT = JSON.stringify({ name: 'a.txt', content_hash: 'abc123' })

async function resultOf(
  status: number,
  window: ByteWindow | undefined,
  headers: Record<string, string>,
): Promise<string | null> {
  vi.stubGlobal('fetch', respond(status, '234', headers))
  const [, result] = await dropboxDownload(tokenManager(), '/a.txt', window)
  return result
}

describe('dropboxDownload result header', () => {
  // A ranged (206) download names the file's metadata too, so a windowed
  // read stamps the same token a whole one does.
  it.each([
    ['whole', 200, undefined],
    ['ranged', 206, { offset: 2, size: 3 }],
  ] as const)('hands back its Dropbox-API-Result (%s)', async (_id, status, window) => {
    expect(await resultOf(status, window, { 'Dropbox-API-Result': RESULT })).toBe(RESULT)
  })

  it('hands back null when the response carries none', async () => {
    expect(await resultOf(200, undefined, {})).toBeNull()
  })
})

describe('dropboxDownloadStream', () => {
  // Before the first chunk: a consumer that stops early still leaves the
  // read stamped.
  it('hands its response headers to onResponse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('hello', { headers: { 'Dropbox-API-Result': RESULT } })),
      ),
    )
    const events: (string | null)[] = []
    for await (const c of dropboxDownloadStream(tokenManager(), '/a.txt', (h) =>
      events.push(h['dropbox-api-result'] ?? null),
    ))
      events.push(new TextDecoder().decode(c))
    expect(events).toEqual([RESULT, 'hello'])
  })

  // A plain record with lower-cased names, as bytes_response hands its own.
  it('hands a plain lower-cased record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('x', { headers: { 'Dropbox-API-Result': RESULT } })),
      ),
    )
    const handed: Record<string, string>[] = []
    for await (const _ of dropboxDownloadStream(tokenManager(), '/a.txt', (h) => handed.push(h)))
      void _
    expect(handed[0] instanceof Headers).toBe(false)
    expect(Object.keys(handed[0] ?? {})).toContain('dropbox-api-result')
  })
})

describe('dropboxRpc', () => {
  // The point stat tells a miss from a refusal by this summary alone, so a
  // 409 body's error_summary has to reach DropboxApiError intact.
  it('keeps a 409 body summary for the miss check', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error_summary: 'path/not_found/..' }), { status: 409 }),
      ),
    )
    await expect(dropboxRpc(tokenManager(), '/files/get_metadata', {})).rejects.toMatchObject({
      status: 409,
      summary: 'path/not_found/..',
    })
  })

  // A 409 body without a string error_summary is no verdict: the summary is
  // '', so no caller reads it as a miss or trips on a non-string.
  it.each([
    ['null-body', 'null'],
    ['null-summary', '{"error_summary":null}'],
    ['number-summary', '{"error_summary":5}'],
    ['not-object', '["path/not_found/.."]'],
    ['not-json', 'oops'],
  ])('leaves the summary empty for a 409 body (%s)', async (_id, body) => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(body, { status: 409 })))
    await expect(dropboxRpc(tokenManager(), '/files/get_metadata', {})).rejects.toMatchObject({
      status: 409,
      summary: '',
    })
  })
})
