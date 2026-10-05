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
import { byteView } from '../../shell/bytes.ts'
import { RecordReader } from './reader.ts'

const ENC = new TextEncoder()

async function* pieces(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const part of parts) {
    await Promise.resolve()
    yield part
  }
}

async function records(reader: RecordReader): Promise<string[]> {
  const out: string[] = []
  for (;;) {
    const record = await reader.next()
    if (record === null) return out
    out.push(record)
  }
}

describe('awk record reader', () => {
  it('cuts records across chunk boundaries', async () => {
    const reader = new RecordReader(
      pieces(ENC.encode('a\nb'), ENC.encode('c\n'), ENC.encode('d')),
      () => '\n',
    )
    expect(await records(reader)).toEqual(['a', 'bc', 'd'])
    expect(await reader.next()).toBeNull()
  })

  it('preserves multibyte bytes across chunk boundaries', async () => {
    const data = ENC.encode('é\n')
    const reader = new RecordReader(pieces(data.subarray(0, 1), data.subarray(1)), () => '\n')
    expect(await records(reader)).toEqual([byteView('é')])
  })

  it('reads RS again before each record', async () => {
    let rs = '\n'
    const reader = new RecordReader(ENC.encode('a\nb\nc\n\nd\n'), () => rs)
    expect(await reader.next()).toBe('a')
    rs = ''
    expect(await records(reader)).toEqual(['b\nc', 'd'])
  })

  it('cuts with a regex RS', async () => {
    const reader = new RecordReader(ENC.encode('a1b22c'), () => '[0-9]+')
    expect(await records(reader)).toEqual(['a', 'b', 'c'])
  })

  it('stops pulling when closed', async () => {
    const pulled: string[] = []
    async function* source(): AsyncIterable<Uint8Array> {
      for (const part of ['a\n', 'b\n']) {
        await Promise.resolve()
        pulled.push(part)
        yield ENC.encode(part)
      }
    }
    const reader = new RecordReader(source(), () => '\n')
    expect(await reader.next()).toBe('a')
    await reader.close()
    expect(pulled).toEqual(['a\n'])
  })
})
