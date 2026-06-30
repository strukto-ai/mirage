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

import { describe, expect, it } from 'vitest'
import { FileStat, FileType } from '../../../types.ts'
import { formatLsLong, humanSize } from './formatting.ts'
import { readStdinAsync, resolveSource, wrapBytes } from './stream.ts'

// interpretEscapes tests live in
// workspace/executor/escapes.test.ts (direct Python port).

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('humanSize', () => {
  it('bytes below 1K', () => {
    expect(humanSize(500)).toBe('500B')
  })

  it('K/M/G units', () => {
    expect(humanSize(1024)).toBe('1.0K')
    expect(humanSize(1024 * 1024)).toBe('1.0M')
    expect(humanSize(1024 * 1024 * 1024)).toBe('1.0G')
  })

  it('fractional sizes round to one decimal (GNU, not floored)', () => {
    expect(humanSize(1536)).toBe('1.5K')
    expect(humanSize(1024 * 1024 + 512 * 1024)).toBe('1.5M')
  })
})

describe('formatLsLong', () => {
  it('emits standard Unix ls -l format for a regular file', () => {
    const stat = new FileStat({
      name: 'file.txt',
      size: 5,
      type: FileType.TEXT,
      modified: '2026-01-01T00:00:00Z',
    })
    const [line] = formatLsLong([stat])
    expect(line).toBe('-rw-r--r-- 1 user user 5 Jan  1 00:00 file.txt')
  })

  it('emits "d" type char and dir perms for directories', () => {
    const stat = new FileStat({
      name: 'sub',
      size: 0,
      type: FileType.DIRECTORY,
      modified: '2026-01-01T00:00:00Z',
    })
    const [line] = formatLsLong([stat])
    expect(line?.startsWith('drwxr-xr-x ')).toBe(true)
    expect(line?.endsWith(' sub')).toBe(true)
  })

  it('right-aligns sizes to common width', () => {
    const stats = [
      new FileStat({ name: 'a', size: 5, type: FileType.TEXT, modified: '2026-01-01T00:00:00Z' }),
      new FileStat({
        name: 'b',
        size: 1234,
        type: FileType.TEXT,
        modified: '2026-01-01T00:00:00Z',
      }),
    ]
    const lines = formatLsLong(stats)
    expect(lines[0]).toContain('    5 Jan  1 00:00 a')
    expect(lines[1]).toContain(' 1234 Jan  1 00:00 b')
  })

  it('uses humanSize when human=true', () => {
    const stat = new FileStat({
      name: 'big',
      size: 2048,
      type: FileType.TEXT,
      modified: '2026-01-01T00:00:00Z',
    })
    const [line] = formatLsLong([stat], { human: true })
    expect(line).toContain('2.0K')
    expect(line).not.toContain(' 2048 ')
  })

  it('falls back to placeholder when modified is missing', () => {
    const stat = new FileStat({ name: 'x', size: 0, type: FileType.TEXT, modified: null })
    const [line] = formatLsLong([stat])
    expect(line).toContain('Jan  1 00:00')
  })
})

describe('stream utils', () => {
  it('readStdinAsync returns null for null', async () => {
    expect(await readStdinAsync(null)).toBeNull()
  })

  it('readStdinAsync passes through Uint8Array', async () => {
    const bytes = encode('hello')
    expect(await readStdinAsync(bytes)).toBe(bytes)
  })

  it('readStdinAsync drains async iterable', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* src(): AsyncIterable<Uint8Array> {
      yield encode('hel')
      yield encode('lo')
    }
    const out = await readStdinAsync(src())
    if (out === null) throw new Error('expected bytes')
    expect(decode(out)).toBe('hello')
  })

  it('resolveSource wraps bytes as iterable', async () => {
    const chunks: string[] = []
    for await (const c of resolveSource(encode('xy'), 'missing')) chunks.push(decode(c))
    expect(chunks).toEqual(['xy'])
  })

  it('resolveSource throws on null', () => {
    expect(() => resolveSource(null, 'missing operand')).toThrow('missing operand')
  })

  it('wrapBytes yields once', async () => {
    const out: string[] = []
    for await (const c of wrapBytes(encode('a'))) out.push(decode(c))
    expect(out).toEqual(['a'])
  })
})
