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
import { materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { GENERAL_WGET } from './wget.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function mockFetch(respBody: string, status = 200): void {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      arrayBuffer: () => Promise.resolve(ENC.encode(respBody).buffer),
      headers: new Headers(),
    } as unknown as Response),
  ) as typeof fetch
}

async function runWget(
  texts: string[],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{
  out: string
  err: string
  exitCode: number
  writes: Record<string, Uint8Array | AsyncIterable<Uint8Array>>
}> {
  const resource = new RAMResource()
  const cmd = GENERAL_WGET[0]
  if (cmd === undefined) throw new Error('wget not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { out: '', err: '', exitCode: -1, writes: {} }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return {
    out: DEC.decode(buf),
    err: await ioResult.stderrStr(),
    exitCode: ioResult.exitCode,
    writes: ioResult.writes,
  }
}

describe('wget', () => {
  const original = globalThis.fetch
  beforeEach(() => {
    mockFetch('file-body')
  })
  afterEach(() => {
    globalThis.fetch = original
  })

  // Real wget puts its progress report on stderr and nothing on stdout.
  it('saves URL basename by default and reports on stderr', async () => {
    const r = await runWget(['https://x.test/path/doc.pdf'])
    expect(r.writes['doc.pdf']).toBeInstanceOf(Uint8Array)
    expect(r.out).toBe('')
    expect(r.err).toContain("'doc.pdf' saved [9/9]")
  })

  it('-O specifies destination', async () => {
    const r = await runWget(['https://x.test/file'], { args_O: '/tmp/dest.bin' })
    const written = r.writes['/tmp/dest.bin']
    expect(written).toBeInstanceOf(Uint8Array)
    if (written instanceof Uint8Array) {
      expect(DEC.decode(written)).toBe('file-body')
    }
  })

  it('-q suppresses stdout', async () => {
    const r = await runWget(['https://x.test/a.txt'], { q: true })
    expect(r.out).toBe('')
  })

  it('--spider checks without saving and reports on stderr', async () => {
    const r = await runWget(['https://x.test/exists'], { spider: true })
    expect(Object.keys(r.writes)).toHaveLength(0)
    expect(r.out).toBe('')
    expect(r.err).toBe('Remote file exists.\n')
  })

  it('missing URL is a usage error with exit 1', async () => {
    await expect(runWget([])).rejects.toMatchObject({ exitCode: 1 })
  })

  // Pinned against GNU Wget 1.25.0: any 4xx/5xx is exit 8, and the -O target
  // is still created (empty), because wget truncates it before it learns the
  // response code.
  it('exits 8 on a 404 and still creates an empty destination', async () => {
    mockFetch('not found', 404)
    const r = await runWget(['https://x.test/missing'], { args_O: '/tmp/w.txt' })
    expect(r.exitCode).toBe(8)
    expect(r.err).toContain('ERROR 404:')
    const written = r.writes['/tmp/w.txt']
    expect(written).toBeInstanceOf(Uint8Array)
    if (written instanceof Uint8Array) expect(written.byteLength).toBe(0)
  })

  it('-q keeps exit 8 but silences the message', async () => {
    mockFetch('not found', 404)
    const r = await runWget(['https://x.test/missing'], { args_O: '/tmp/w.txt', q: true })
    expect(r.exitCode).toBe(8)
    expect(r.err).toBe('')
  })

  it('--spider on a 404 exits 8 with the broken-link message', async () => {
    mockFetch('not found', 404)
    const r = await runWget(['https://x.test/missing'], { spider: true })
    expect(r.exitCode).toBe(8)
    expect(r.err).toBe('Remote file does not exist -- broken link!!!\n')
  })

  it('reports a refused connection as exit 4', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
    const r = await runWget(['http://127.0.0.1:1/x'])
    expect(r.exitCode).toBe(4)
    expect(r.err).toContain('failed: Connection refused.')
  })
})
