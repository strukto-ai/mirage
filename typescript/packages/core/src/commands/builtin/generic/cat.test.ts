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

import { stripSlash } from '../../../utils/slash.ts'
import { describe, expect, it, vi } from 'vitest'
import { IOResult, materialize } from '../../../io/types.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { efbig } from '../../../utils/errors.ts'
import { catGeneric } from './cat.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const FILES: Record<string, string> = {
  '/a.txt': 'a1\na2\na3\n',
  '/b.txt': 'b1\nb2\n',
}

function spec(path: string): PathSpec {
  return new PathSpec({
    vfsPath: stripSlash(path),
    virtual: path,
    directory: path,
    resolved: true,
  })
}

function opts(): CommandOpts {
  return { stdin: null, flags: {}, filetypeFns: null, cwd: '/', vfs: {} } as CommandOpts
}

async function* fileStream(path: string, pulled: string[]): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  pulled.push(path)
  yield ENC.encode(FILES[path] ?? '')
}

function statFn(p: PathSpec): Promise<FileStat> {
  return Promise.resolve(
    new FileStat({ name: p.virtual, size: 1, type: FileType.FILE, content: ContentType.TEXT }),
  )
}

describe('catGeneric multi-file streaming', () => {
  it('records one reads entry per file, not the joined stream', async () => {
    const pulled: string[] = []
    const result = await catGeneric([spec('/a.txt'), spec('/b.txt')], [], opts(), statFn, (p) =>
      fileStream(p.virtual, pulled),
    )
    expect(result).not.toBeNull()
    const [stdout, io] = result ?? [null, new IOResult()]
    expect(DEC.decode(await materialize(stdout))).toBe('a1\na2\na3\nb1\nb2\n')
    expect(DEC.decode(await materialize(io.reads['/a.txt']))).toBe('a1\na2\na3\n')
    expect(DEC.decode(await materialize(io.reads['/b.txt']))).toBe('b1\nb2\n')
  })

  it('does not pull the second file when the consumer stops early', async () => {
    const pulled: string[] = []
    const result = await catGeneric([spec('/a.txt'), spec('/b.txt')], [], opts(), statFn, (p) =>
      fileStream(p.virtual, pulled),
    )
    const [stdout] = result ?? [null]
    const iter = (stdout as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(first.done).toBe(false)
    expect(DEC.decode(first.value as Uint8Array)).toBe('a1\na2\na3\n')
    expect(pulled).toEqual(['/a.txt'])
  })
})

describe('catGeneric without display flags', () => {
  it('hands out the first chunk before the source is asked for the next', async () => {
    const pulled: string[] = []
    async function* chunks(): AsyncIterable<Uint8Array> {
      for (const chunk of ['hel', 'lo\nwo', 'rld\n']) {
        await Promise.resolve()
        pulled.push(chunk)
        yield ENC.encode(chunk)
      }
    }
    const result = await catGeneric([spec('/a.txt')], [], opts(), statFn, () => chunks())
    const [stdout] = result ?? [null]
    const iter = (stdout as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(DEC.decode(first.value as Uint8Array)).toBe('hel')
    expect(pulled).toEqual(['hel'])
    let rest = ''
    for (let next = await iter.next(); next.done !== true; next = await iter.next()) {
      rest += DEC.decode(next.value)
    }
    expect(rest).toBe('lo\nworld\n')
  })
})

describe('catGeneric per-operand read failure', () => {
  it('reports a read refused past the stat and prints the next file', async () => {
    // A table past its mount's read cap stats fine and refuses the read; GNU
    // cat reports the operand and goes on to the next.
    const result = await catGeneric([spec('/a.txt'), spec('/b.txt')], [], opts(), statFn, (p) =>
      p.virtual === '/a.txt'
        ? (async function* () {
            await Promise.resolve()
            yield* []
            throw efbig(p)
          })()
        : fileStream(p.virtual, []),
    )
    const [stdout, io] = result ?? [null, new IOResult()]
    expect(DEC.decode(await materialize(stdout))).toBe('b1\nb2\n')
    expect(DEC.decode(await materialize(io.stderr))).toBe('cat: /a.txt: File too large\n')
    expect(io.exitCode).toBe(1)
    expect(await materialize(io.reads['/a.txt'])).toEqual(new Uint8Array())
  })
})

describe('displayLines flags', () => {
  async function run(text: string, flags: Record<string, boolean>): Promise<string> {
    const result = await catGeneric(
      [spec('/a.txt')],
      [],
      { ...opts(), flags } as CommandOpts,
      statFn,
      () =>
        (async function* () {
          await Promise.resolve()
          yield ENC.encode(text)
        })(),
    )
    const [stdout] = result ?? [null]
    return DEC.decode(await materialize(stdout))
  }

  it('-v uses caret and meta notation', async () => {
    // TextEncoder emits UTF-8, so \u00ff arrives as the two bytes C3 BF.
    expect(await run('\x01\x7f\u00ff\n', { show_nonprinting: true })).toBe('^A^?M-CM-?\n')
  })
})

it('stats each operand once while retaining its stream', async () => {
  const stat = vi.fn(statFn)
  const [stdout] = (await catGeneric([spec('/a.txt'), spec('/b.txt')], [], opts(), stat, (p) =>
    fileStream(p.virtual, []),
  )) ?? [null]
  expect(DEC.decode(await materialize(stdout))).toBe('a1\na2\na3\nb1\nb2\n')
  expect(stat).toHaveBeenCalledTimes(2)
})
