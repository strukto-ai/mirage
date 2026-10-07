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
  dropboxUpload,
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

  it('sends no Range and reads whole when no window is asked for', async () => {
    const { out, sent } = await download(200, BODY)
    expect(new TextDecoder().decode(out)).toBe(BODY)
    expect(sent.Range).toBeUndefined()
  })
})

const RESULT = JSON.stringify({ name: 'a.txt', content_hash: 'abc123' })

describe('dropboxDownload result header', () => {
  it.each([
    ['whole', 200, undefined, { 'Dropbox-API-Result': RESULT }, RESULT],
    ['ranged', 206, { offset: 2, size: 3 }, { 'Dropbox-API-Result': RESULT }, RESULT],
    ['absent', 200, undefined, {}, null],
  ] as const)(
    'hands back its Dropbox-API-Result (%s)',
    async (_id, status, window, headers, want) => {
      vi.stubGlobal('fetch', respond(status, '234', headers))
      const [, result] = await dropboxDownload(tokenManager(), '/a.txt', window)
      expect(result).toBe(want)
    },
  )
})

describe('dropboxDownloadStream', () => {
  // A plain lower-cased record, as bytes_response hands its own, before the
  // first chunk, so a consumer that stops early still leaves the read stamped.
  it('hands its response headers to onResponse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('hello', { headers: { 'Dropbox-API-Result': RESULT } })),
      ),
    )
    const events: (Record<string, string> | string)[] = []
    for await (const c of dropboxDownloadStream(tokenManager(), '/a.txt', (h) => events.push(h))) {
      events.push(new TextDecoder().decode(c))
    }
    expect(events[0] instanceof Headers).toBe(false)
    expect((events[0] as Record<string, string>)['dropbox-api-result']).toBe(RESULT)
    expect(events.slice(1)).toEqual(['hello'])
  })
})

describe('dropboxRpc', () => {
  it.each([
    ['null', 'null'],
    ['number', '{"error_summary":5}'],
    ['not-object', '["path/not_found/.."]'],
    ['not-json', 'oops'],
  ])('leaves the summary empty for a 409 body without one (%s)', async (_id, body) => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(body, { status: 409 })))
    await expect(dropboxRpc(tokenManager(), '/files/get_metadata', {})).rejects.toMatchObject({
      status: 409,
      summary: '',
    })
  })
})

describe('dropboxUpload', () => {
  async function upload(body: string, contentType: string): Promise<unknown> {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': contentType } }),
      ),
    )
    return dropboxUpload(tokenManager(), '/a.txt', new TextEncoder().encode('hello'))
  }

  it('hands back the stored file metadata', async () => {
    const entry = { '.tag': 'file', name: 'a.txt', size: 5, content_hash: 'h5' }
    expect(await upload(JSON.stringify(entry), 'application/json')).toEqual(entry)
  })

  it('hands a non-JSON body back unchecked, without raising', async () => {
    // The upload has landed; an unreadable reply must not raise. The
    // writer's uploadToken reads it as no metadata.
    expect(await upload('not json', 'text/plain')).toBe('not json')
  })
})
