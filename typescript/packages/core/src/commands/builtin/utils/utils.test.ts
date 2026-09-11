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
import { ContentType, DEVICE_NUMBERS_KEY, FileStat, FileType } from '../../../types.ts'
import { formatLsLong, humanSize } from './formatting.ts'
import { readStdinAsync, resolveSource, wrapBytes } from './stream.ts'

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

// Read off GNU coreutils 9.7 (`ls -lh` on a file of each size, debian
// stable-slim). The three rows that matter are the ones a plain
// divide-and-format gets wrong: no suffix under 1024, rounding *up* to
// the shown precision (1025 -> 1.1K), and the decimal dropping once the
// value reaches ten (10240 -> 10K). 1048575 pins the carry: it ceils to
// 1024K, which GNU re-scales to 1.0M.
const GNU_HUMAN_SIZES: readonly (readonly [number, string])[] = [
  [0, '0'],
  [1, '1'],
  [24, '24'],
  [500, '500'],
  [999, '999'],
  [1000, '1000'],
  [1023, '1023'],
  [1024, '1.0K'],
  [1025, '1.1K'],
  [1126, '1.1K'],
  [1127, '1.2K'],
  [1536, '1.5K'],
  [2048, '2.0K'],
  [10188, '10K'],
  [10240, '10K'],
  [10241, '11K'],
  [11263, '11K'],
  [1048575, '1.0M'],
  [1048576, '1.0M'],
  [1024 * 1024 + 512 * 1024, '1.5M'],
  [1073741824, '1.0G'],
  // Past 2**53/10, so a `n * 10` intermediate stops being exact.
  // GNU says 1.8P; a float product rounds down and yields 1.7P.
  [1914029841632461, '1.8P'],
]

describe('humanSize', () => {
  it.each(GNU_HUMAN_SIZES)('formats %i as GNU does', (size, expected) => {
    expect(humanSize(size)).toBe(expected)
  })
})

describe('formatLsLong', () => {
  it('emits standard Unix ls -l format for a regular file', () => {
    const stat = new FileStat({
      name: 'file.txt',
      size: 5,
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: '2026-01-01T00:00:00Z',
    })
    const [line] = formatLsLong([stat])
    expect(line).toBe('-rw-r--r-- 1 - - 5 Jan  1  2026 file.txt')
  })

  it('renders the owner as the user and the group as the profile', () => {
    const stat = new FileStat({
      name: 'file.txt',
      size: 5,
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: '2026-01-01T00:00:00Z',
    })
    const identity = { user: 'alice', profile: 'admin' }
    expect(formatLsLong([stat], { identity })[0]).toBe(
      '-rw-r--r-- 1 alice admin 5 Jan  1  2026 file.txt',
    )
    // A reported uid/gid (disk, or a chown in the overlay) wins over both.
    const owned = stat.with({ uid: 501, gid: 'staff' })
    expect(formatLsLong([owned], { identity })[0]).toBe(
      '-rw-r--r-- 1 501 staff 5 Jan  1  2026 file.txt',
    )
    // Half an identity fills half the columns.
    expect(formatLsLong([stat], { identity: { user: null, profile: 'admin' } })[0]).toBe(
      '-rw-r--r-- 1 - admin 5 Jan  1  2026 file.txt',
    )
  })

  it('keeps the owner columns on a metadata-less row', () => {
    // A synthetic directory with neither size nor mtime shows `-` for
    // both rather than inventing size 0 and the epoch, and still names
    // who the session is.
    const stat = new FileStat({ name: 'dev', type: FileType.DIRECTORY })
    expect(formatLsLong([stat])[0]).toBe('drwxr-xr-x 1 - - - - dev')
    expect(formatLsLong([stat], { identity: { user: null, profile: 'admin' } })[0]).toBe(
      'drwxr-xr-x 1 - admin - - dev',
    )
  })

  it('renders a device row with its numbers in the size column', () => {
    const nul = new FileStat({
      name: 'null',
      type: FileType.CHAR_DEVICE,
      extra: { [DEVICE_NUMBERS_KEY]: [1, 3] },
    })
    expect(formatLsLong([nul], { identity: { user: 'alice', profile: null } })[0]).toBe(
      'crw-rw-rw- 1 alice - 1, 3 - null',
    )
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
      new FileStat({
        name: 'a',
        size: 5,
        type: FileType.FILE,
        content: ContentType.TEXT,
        modified: '2026-01-01T00:00:00Z',
      }),
      new FileStat({
        name: 'b',
        size: 1234,
        type: FileType.FILE,
        content: ContentType.TEXT,
        modified: '2026-01-01T00:00:00Z',
      }),
    ]
    const lines = formatLsLong(stats)
    expect(lines[0]).toContain('    5 Jan  1  2026 a')
    expect(lines[1]).toContain(' 1234 Jan  1  2026 b')
  })

  it('uses humanSize when human=true', () => {
    const stat = new FileStat({
      name: 'big',
      size: 2048,
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: '2026-01-01T00:00:00Z',
    })
    const [line] = formatLsLong([stat], { human: true })
    expect(line).toContain('2.0K')
    expect(line).not.toContain(' 2048 ')
  })

  it('falls back to placeholder when modified is missing', () => {
    const stat = new FileStat({
      name: 'x',
      size: 0,
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: null,
    })
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
