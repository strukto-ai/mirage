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
import { parseJsonAuto, parseJsonDocs } from './stream.ts'

const ENC = new TextEncoder()

describe('parseJsonAuto', () => {
  it('throws clear error on empty input', () => {
    expect(() => parseJsonAuto(ENC.encode(''))).toThrow(/empty input/)
  })

  it('throws clear error on whitespace-only input', () => {
    expect(() => parseJsonAuto(ENC.encode('   \n\n  '))).toThrow(/empty input/)
  })

  it('parses single JSON value', () => {
    expect(parseJsonAuto(ENC.encode('{"a":1}'))).toEqual({ a: 1 })
    expect(parseJsonAuto(ENC.encode('42'))).toBe(42)
  })

  it('parses NDJSON when multiple lines', () => {
    expect(parseJsonAuto(ENC.encode('{"a":1}\n{"b":2}'))).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('propagates original parse error on single-line garbage (no silent NDJSON downgrade)', () => {
    expect(() => parseJsonAuto(ENC.encode('this is not json'))).toThrow(/JSON|json/)
  })
})

describe('parseJsonDocs', () => {
  it('returns a single value as one document', () => {
    expect(parseJsonDocs(ENC.encode('{"a":1}'))).toEqual([{ a: 1 }])
  })

  it('splits an NDJSON stream', () => {
    expect(parseJsonDocs(ENC.encode('{"a":1}\n{"a":2}\n'))).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('splits a pretty-printed stream, since documents need not be one per line', () => {
    const raw = ENC.encode('{\n  "a": 1\n}\n{\n  "a": 2\n}\n')
    expect(parseJsonDocs(raw)).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('splits a stream of arrays', () => {
    expect(parseJsonDocs(ENC.encode('[1,2]\n[3,4]\n'))).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('reports the whole-document error on garbage', () => {
    expect(() => parseJsonDocs(ENC.encode('this is not json'))).toThrow(/JSON|json/)
  })
})
