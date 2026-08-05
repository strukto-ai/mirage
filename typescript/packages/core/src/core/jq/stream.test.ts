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
import { evalJsonlStream, parseJsonAuto, parseJsonDocs, splitRawLines } from './stream.ts'
import { jqOptions } from './types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const COMPACT = jqOptions({ compact: true })

async function* lines(...items: string[]): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  for (const item of items) yield ENC.encode(item)
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string[]> {
  const out: string[] = []
  for await (const chunk of stream) out.push(DEC.decode(chunk).replace(/\n$/, ''))
  return out
}

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

describe('evalJsonlStream', () => {
  it('maps each line through the per-item program', async () => {
    const source = lines('{"msg":"hello"}\n', '{"msg":"world"}\n')
    expect(await collect(evalJsonlStream(source, '.[].msg', COMPACT))).toEqual([
      '"hello"',
      '"world"',
    ])
  })

  it('unquotes strings when raw', async () => {
    const source = lines('{"msg":"hello"}\n', '{"msg":"world"}\n')
    expect(
      await collect(
        evalJsonlStream(source, '.[].msg', jqOptions({ rawOutput: true, compact: true })),
      ),
    ).toEqual(['hello', 'world'])
  })

  it('prints every output of a line', async () => {
    const source = lines('{"a":1,"b":2}\n', '{"a":3,"b":4}\n')
    expect(await collect(evalJsonlStream(source, '.[] | .a, .b', COMPACT))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ])
  })

  it('drops lines with no output', async () => {
    const source = lines('{"id":1}\n', '{"id":2}\n', '{"id":3}\n')
    expect(await collect(evalJsonlStream(source, '.[] | select(.id > 2)', COMPACT))).toEqual([
      '{"id":3}',
    ])
  })
})

describe('splitRawLines', () => {
  it('drops only the trailing newline', () => {
    expect(splitRawLines(ENC.encode('a\nb\n'))).toEqual(['a', 'b'])
    expect(splitRawLines(ENC.encode('a\nb'))).toEqual(['a', 'b'])
    expect(splitRawLines(ENC.encode(''))).toEqual([])
    expect(splitRawLines(ENC.encode('\n'))).toEqual([''])
  })
})

describe('parseJsonDocs on empty input', () => {
  it('has no documents at all', () => {
    expect(parseJsonDocs(ENC.encode(''))).toEqual([])
    expect(parseJsonDocs(ENC.encode('  \n\n '))).toEqual([])
  })
})

describe('evalJsonlStream output options', () => {
  it('pretty-prints by default', async () => {
    const source = lines('{"a":1}\n')
    expect(await collect(evalJsonlStream(source, '.[]', jqOptions()))).toEqual(['{\n  "a": 1\n}'])
  })

  it('binds named args', async () => {
    const source = lines('{"a":1}\n')
    const opts = jqOptions({ compact: true, namedArgs: { v: 'hi' } })
    expect(await collect(evalJsonlStream(source, '.[] | [., $v]', opts))).toEqual([
      '[{"a":1},"hi"]',
    ])
  })
})
