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
import { downloadFile, fileBlobName } from './files.ts'

const BODY = '0123456789'

function respond(status: number, body: string): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(body, { status })))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('downloadFile', () => {
  it('sends the window as a Range header', async () => {
    const fetch = respond(206, '234')
    vi.stubGlobal('fetch', fetch)
    await downloadFile('https://cdn.example/a.csv', 2, 3)
    const init = vi.mocked(fetch).mock.calls[0]?.[1]
    expect((init?.headers as Record<string, string>).Range).toBe('bytes=2-4')
  })

  // A CDN may legally ignore Range and answer 200 with the whole file. Before
  // this was handled the caller got every byte for what it asked to be a
  // window, which over FUSE is a read far longer than the buffer it was given.
  it('slices locally when the server ignores the range and answers 200', async () => {
    vi.stubGlobal('fetch', respond(200, BODY))
    const out = await downloadFile('https://cdn.example/a.csv', 2, 3)
    expect(new TextDecoder().decode(out)).toBe('234')
  })

  it('trusts a 206 body as already the window', async () => {
    vi.stubGlobal('fetch', respond(206, '234'))
    const out = await downloadFile('https://cdn.example/a.csv', 2, 3)
    expect(new TextDecoder().decode(out)).toBe('234')
  })

  it('reads the whole file when no window is asked for', async () => {
    const fetch = respond(200, BODY)
    vi.stubGlobal('fetch', fetch)
    const out = await downloadFile('https://cdn.example/a.csv')
    expect(new TextDecoder().decode(out)).toBe(BODY)
    const init = vi.mocked(fetch).mock.calls[0]?.[1]
    expect((init?.headers as Record<string, string>).Range).toBeUndefined()
  })

  it('throws on a failed response', async () => {
    vi.stubGlobal('fetch', respond(404, ''))
    await expect(downloadFile('https://cdn.example/gone.csv')).rejects.toThrow(/404/)
  })
})

describe('fileBlobName', () => {
  it.each([
    [{ id: 'A1', filename: 'budget.csv', title: 'Q4' }, 'budget__A1.csv'],
    [{ id: 'A2', filename: '', title: 'scan.png' }, 'scan__A2.png'],
    [{ id: 'A3' }, 'file__A3'],
  ])('names %j as %s', (att, expected) => {
    expect(fileBlobName(att)).toBe(expected)
  })
})
