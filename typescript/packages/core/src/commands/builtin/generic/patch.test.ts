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
import { PathSpec } from '../../../types.ts'
import { isTried, needleOf, patchGeneric, seek, tries } from './patch.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const PREFIX = Array.from({ length: 100_000 }, (_, k) => `p${String(k)}`)

// The file's lines, counting how often their length is read: every
// candidate spot a hunk is checked at reads it at least once.
function counted(lines: string[]): { lines: string[]; reads: () => number } {
  let reads = 0
  const proxy = new Proxy(lines, {
    get(target, prop, receiver) {
      if (prop === 'length') reads += 1
      return Reflect.get(target, prop, receiver) as unknown
    },
  })
  return { lines: proxy, reads: () => reads }
}

function hunk(body: string[]): ReturnType<typeof needleOf> {
  return needleOf({ oldStart: 1, newStart: 1, note: '', body })
}

async function run(text: string, diff: string): Promise<string> {
  const files = new Map<string, Uint8Array>([['f', ENC.encode(text)]])
  const read = (p: PathSpec): Promise<Uint8Array> => {
    const bytes = files.get(p.vfsPath)
    if (bytes === undefined) throw new Error('missing fixture')
    return Promise.resolve(bytes)
  }
  const write = (p: PathSpec, data: Uint8Array): Promise<void> => {
    files.set(p.vfsPath, data)
    return Promise.resolve()
  }
  const result = await patchGeneric(
    [],
    { mountPrefix: '', cwd: PathSpec.fromStrPath('/'), flags: { p: '0' }, stdin: ENC.encode(diff) },
    read,
    write,
  )
  if (result === null) throw new Error('patch returned no result')
  return DEC.decode(result[0] as Uint8Array)
}

describe('patch placement', () => {
  it('tries a hunk held to the end of the file at that one line', () => {
    const file = counted([...PREFIX, 'a', 'b', 'c', 'd'])
    const needle = hunk([' a', ' b', ' c', '-d', '+D'])
    expect(seek(file.lines, needle, 0, 0, 0)).toBe(100_000)
    expect(file.reads()).toBeLessThan(10)
  })

  it('tries a hunk held to the start of the file at that one line', () => {
    const file = counted([...PREFIX, 'x', 'a', 'b', 'c'])
    const needle = hunk(['-x', '+X', ' a', ' b', ' c'])
    for (let fuzz = 0; fuzz <= 2; fuzz++) expect(seek(file.lines, needle, fuzz, 0, 0)).toBeNull()
    expect(file.reads()).toBeLessThan(20)
  })

  it('knows every line the search reaches', () => {
    for (let expected = -6; expected < 12; expected++) {
      for (let used = 0; used < 8; used++) {
        for (let last = -3; last < 12; last++) {
          const reached = new Set(tries(expected, used, last))
          for (let at = -14; at < 16; at++) {
            expect(isTried(at, expected, used, last)).toBe(reached.has(at))
          }
        }
      }
    }
  })

  it('places an end-held hunk after a long prefix as GNU patch 2.8 does', async () => {
    const text = [...PREFIX, 'a', 'b', 'c', 'd'].map((l) => `${l}\n`).join('')
    const diff = '--- f\n+++ f\n@@ -1,4 +1,4 @@\n a\n b\n c\n-d\n+D\n'
    expect(await run(text, diff)).toBe(
      'patching file f\nHunk #1 succeeded at 100001 (offset 100000 lines).\n',
    )
  })
})
