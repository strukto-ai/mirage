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
import { jqEval } from './eval.ts'
import { concatBytes, formatJqOutput } from './format.ts'
import { jqOptions } from './types.ts'

const DEC = new TextDecoder()
const PRETTY = jqOptions()
const COMPACT = jqOptions({ compact: true })
const RAW = jqOptions({ rawOutput: true, compact: true })

describe('formatJqOutput', () => {
  it('returns empty bytes when there are no outputs', () => {
    expect(formatJqOutput([], PRETTY)).toEqual(new Uint8Array(0))
    expect(formatJqOutput([], RAW)).toEqual(new Uint8Array(0))
  })

  it('serializes a single value compactly', () => {
    expect(DEC.decode(formatJqOutput([{ a: 1 }], COMPACT))).toBe('{"a":1}\n')
  })

  it('indents a single value by default', () => {
    expect(DEC.decode(formatJqOutput([{ a: 1 }], PRETTY))).toBe('{\n  "a": 1\n}\n')
  })

  it('emits raw strings without JSON quoting when raw=true', () => {
    expect(DEC.decode(formatJqOutput(['hello'], RAW))).toBe('hello\n')
  })

  it('leaves non-strings as JSON when raw=true', () => {
    expect(DEC.decode(formatJqOutput(['a', 1], RAW))).toBe('a\n1\n')
  })

  it('prints one line per output', () => {
    expect(DEC.decode(formatJqOutput([1, 2, 3], COMPACT))).toBe('1\n2\n3\n')
  })

  it('keeps a single array output on one line', () => {
    expect(DEC.decode(formatJqOutput([[1, 2, 3]], COMPACT))).toBe('[1,2,3]\n')
  })

  it('prints one line per output of a comma program', async () => {
    const outputs = await jqEval({ a: 'alice', b: 30 }, '.a, .b')
    expect(DEC.decode(formatJqOutput(outputs, RAW))).toBe('alice\n30\n')
  })
})

describe('jq DropItem regression', () => {
  it('zero-output expression yields no outputs, not a thrown error', async () => {
    const msg = { id: 'x', subject: 'hi', body_text: '...' }
    const outputs = await jqEval(msg, '.attachments[]?')
    expect(outputs).toEqual([])
    expect(formatJqOutput(outputs, RAW)).toEqual(new Uint8Array(0))
  })

  it('select with no match yields no outputs', async () => {
    const outputs = await jqEval({ x: 1 }, 'select(.x > 100)')
    expect(outputs).toEqual([])
    expect(formatJqOutput(outputs, COMPACT)).toEqual(new Uint8Array(0))
  })
})

describe('jq output flags', () => {
  it('writes no separator under -j', () => {
    const opts = jqOptions({ rawOutput: true, joinOutput: true, compact: true })
    expect(DEC.decode(formatJqOutput(['a', 'b'], opts))).toBe('ab')
  })

  it('terminates with NUL under --raw-output0, which beats -j', () => {
    const opts = jqOptions({ rawOutput: true, joinOutput: true, nulOutput: true, compact: true })
    expect(formatJqOutput(['a', 'b'], opts)).toEqual(new Uint8Array([97, 0, 98, 0]))
  })

  it('sorts object keys under -S', () => {
    const opts = jqOptions({ compact: true, sortKeys: true })
    expect(DEC.decode(formatJqOutput([{ b: 1, a: 2 }], opts))).toBe('{"a":2,"b":1}\n')
  })

  it('sorts nested object keys under -S', () => {
    const opts = jqOptions({ compact: true, sortKeys: true })
    expect(DEC.decode(formatJqOutput([{ b: { d: 1, c: 2 } }], opts))).toBe('{"b":{"c":2,"d":1}}\n')
  })

  it('escapes non-ASCII under -a, which beats -r', () => {
    const opts = jqOptions({ rawOutput: true, asciiOutput: true, compact: true })
    expect(DEC.decode(formatJqOutput(['caf\u00e9'], opts))).toBe('"caf\\u00e9"\n')
  })

  it('indents with tabs under --tab', () => {
    expect(DEC.decode(formatJqOutput([{ a: 1 }], jqOptions({ tab: true })))).toBe(
      '{\n\t"a": 1\n}\n',
    )
  })

  it('honors an indent width', () => {
    expect(DEC.decode(formatJqOutput([{ a: 1 }], jqOptions({ indent: 4 })))).toBe(
      '{\n    "a": 1\n}\n',
    )
  })

  it('is compact at indent 0', () => {
    expect(DEC.decode(formatJqOutput([{ a: 1 }], jqOptions({ indent: 0 })))).toBe('{"a":1}\n')
  })
})

describe('concatBytes', () => {
  it('concatenates byte arrays in order', () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([4, 5])
    expect(Array.from(concatBytes([a, b]))).toEqual([1, 2, 3, 4, 5])
  })

  it('returns empty array for empty input', () => {
    expect(concatBytes([])).toEqual(new Uint8Array(0))
  })
})
