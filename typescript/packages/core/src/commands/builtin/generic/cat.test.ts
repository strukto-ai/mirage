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
import { describe, expect, it } from 'vitest'
import { IOResult, materialize } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { catGeneric } from './cat.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const FILES: Record<string, string> = {
  '/a.txt': 'a1\na2\na3\n',
  '/b.txt': 'b1\nb2\n',
}

function spec(path: string): PathSpec {
  return new PathSpec({
    resourcePath: stripSlash(path),
    virtual: path,
    directory: path,
    resolved: true,
  })
}

function opts(): CommandOpts {
  return { stdin: null, flags: {}, filetypeFns: null, cwd: '/', resource: {} } as CommandOpts
}

async function* fileStream(path: string, pulled: string[]): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  pulled.push(path)
  yield ENC.encode(FILES[path] ?? '')
}

function statFn(p: PathSpec): Promise<FileStat> {
  return Promise.resolve(new FileStat({ name: p.virtual, size: 1, type: FileType.TEXT }))
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

  it('-E marks line ends', async () => {
    expect(await run('a\tb\nx\n', { E: true })).toBe('a\tb$\nx$\n')
  })

  it('-T renders tabs as ^I', async () => {
    expect(await run('a\tb\nx\n', { T: true })).toBe('a^Ib\nx\n')
  })

  it('-A combines -vET', async () => {
    expect(await run('a\tb\nx\n', { A: true })).toBe('a^Ib$\nx$\n')
  })

  it('-v uses caret and meta notation', async () => {
    // TextEncoder emits UTF-8, so \u00ff arrives as the two bytes C3 BF.
    expect(await run('\x01\x7f\u00ff\n', { v: true })).toBe('^A^?M-CM-?\n')
  })
})
