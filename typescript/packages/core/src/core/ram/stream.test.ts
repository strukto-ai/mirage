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

import { stripSlash } from '../../utils/slash.ts'
import { describe, expect, it } from 'vitest'
import { runWithRecording } from '../../observe/context.ts'
import { RAMAccessor } from '../../accessor/ram.ts'
import { RAMStore } from '../../resource/ram/store.ts'
import { PathSpec } from '../../types.ts'
import { stream } from './stream.ts'

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function mkPath(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: stripSlash(virtual),
    resolved: true,
  })
}

describe('stream (RAM)', () => {
  it('yields file contents as a single chunk', async () => {
    const store = new RAMStore()
    store.files.set('/hello.txt', encode('hi'))
    const chunks: string[] = []
    for await (const c of stream(new RAMAccessor(store), mkPath('/hello.txt'))) {
      chunks.push(new TextDecoder().decode(c))
    }
    expect(chunks).toEqual(['hi'])
  })

  it('throws for missing file', async () => {
    const store = new RAMStore()
    const it = stream(new RAMAccessor(store), mkPath('/nope.txt'))
    await expect(async () => {
      for await (const _ of it) void _
    }).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records bytes under active recording context', async () => {
    const store = new RAMStore()
    store.files.set('/a.txt', encode('abcd'))
    const [, records] = await runWithRecording(async () => {
      for await (const _ of stream(new RAMAccessor(store), mkPath('/a.txt'))) void _
    })
    expect(records).toHaveLength(1)
    const rec = records[0]
    if (rec === undefined) throw new Error('expected record')
    expect(rec.op).toBe('read')
    expect(rec.bytes).toBe(4)
    expect(rec.source).toBe('ram')
  })
})
