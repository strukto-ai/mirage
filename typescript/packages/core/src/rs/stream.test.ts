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
import { encodeBase64 } from '../utils/base64.ts'
import { StreamRefusal } from './errors.ts'
import { openStream } from './stream.ts'

const DECODE = { mode: 'decode', ignore_garbage: false }

describe('openStream', () => {
  it('refuses a bad config with no output', async () => {
    const refused: unknown = await openStream('base64', { mode: 'nope' }).catch(
      (err: unknown) => err,
    )
    expect(refused).toBeInstanceOf(StreamRefusal)
    expect((refused as StreamRefusal).message).toMatch(/^bad stream config/)
    expect((refused as StreamRefusal).output.byteLength).toBe(0)
  })

  it('keeps the earlier pieces when a chunk past the input window refuses', async () => {
    const data = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 256)
    const input = new TextEncoder().encode(`${encodeBase64(data)}*`)
    const stream = await openStream('base64', DECODE)
    let refused: unknown
    try {
      stream.feed(input)
    } catch (err) {
      refused = err
    } finally {
      stream.close()
      stream.close()
    }
    expect(refused).toBeInstanceOf(StreamRefusal)
    expect((refused as StreamRefusal).output).toEqual(data)
  })
})
