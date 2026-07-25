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

import { afterEach, describe, expect, it } from 'vitest'
import { decodeBase64, encodeBase64 } from './base64.ts'

const HELD = globalThis.Buffer

// Core must work in browsers, where `Buffer` does not exist. Running the
// round-trip with the global removed is the only way to prove that.
function withoutBuffer<T>(fn: () => T): T {
  delete (globalThis as { Buffer?: unknown }).Buffer
  return fn()
}

afterEach(() => {
  globalThis.Buffer = HELD
})

describe('base64 round-trip', () => {
  it('encodes and decodes arbitrary bytes without Buffer', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 65, 0, 254])
    const { encoded, decoded } = withoutBuffer(() => {
      const encoded = encodeBase64(bytes)
      return { encoded, decoded: decodeBase64(encoded) }
    })
    expect(encoded).toBe(HELD.from(bytes).toString('base64'))
    expect([...decoded]).toEqual([...bytes])
  })

  it('decodes the same bytes Node would, without Buffer', () => {
    const encoded = HELD.from('héllo wörld', 'utf8').toString('base64')
    const decoded = withoutBuffer(() => decodeBase64(encoded))
    expect(new TextDecoder().decode(decoded)).toBe('héllo wörld')
  })

  it('decodes empty input to an empty array', () => {
    expect([...withoutBuffer(() => decodeBase64(''))]).toEqual([])
  })
})
