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
import { jqOptions } from '../../../core/jq/index.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { assembleInputs, exitCode, namedArgs, parseFlags, positionalArgs } from './jq.ts'

const ENC = new TextEncoder()

function view(flags: Record<string, string | boolean | number | string[]>): FlagView {
  return new FlagView(flags, specOf('jq'))
}

describe('parseFlags', () => {
  it('reads -j and --raw-output0 as implying -r', () => {
    expect(parseFlags(view({ join_output: true })).rawOutput).toBe(true)
    expect(parseFlags(view({ raw_output0: true })).rawOutput).toBe(true)
  })

  it('reads --indent -1 as tab indentation', () => {
    const opts = parseFlags(view({ indent: '-1' }))
    expect(opts.tab).toBe(true)
    expect(opts.indent).toBe(2)
  })

  it('refuses an indent out of range', () => {
    expect(() => parseFlags(view({ indent: '8' }))).toThrow(/between -1 and 7/)
  })
})

describe('namedArgs', () => {
  it('pairs up the flattened tokens', () => {
    expect(namedArgs(view({ arg: ['a', '1', 'b', '2'] }))).toEqual({ a: '1', b: '2' })
  })

  it('parses an --argjson value as JSON', () => {
    expect(namedArgs(view({ argjson: ['v', '{"k":[1,2]}'] }))).toEqual({ v: { k: [1, 2] } })
  })

  it('refuses invalid JSON', () => {
    expect(() => namedArgs(view({ argjson: ['v', 'nope'] }))).toThrow(/invalid JSON text/)
  })
})

describe('assembleInputs', () => {
  it('slurps across every input rather than each one', async () => {
    const chunks = [ENC.encode('{"a":1}'), ENC.encode('{"b":2}')]
    expect(await assembleInputs(chunks, jqOptions({ slurp: true }))).toEqual([[{ a: 1 }, { b: 2 }]])
  })

  it('splits raw lines per input', async () => {
    const chunks = [ENC.encode('x\ny'), ENC.encode('z\n')]
    expect(await assembleInputs(chunks, jqOptions({ rawInput: true }))).toEqual(['x', 'y', 'z'])
  })

  it('joins every input into one string when raw and slurped', async () => {
    const chunks = [ENC.encode('x\n'), ENC.encode('y\n')]
    const opts = jqOptions({ rawInput: true, slurp: true })
    expect(await assembleInputs(chunks, opts)).toEqual(['x\ny\n'])
  })
})

describe('exitCode', () => {
  it('reads the last output only under -e', () => {
    const opts = jqOptions({ exitStatus: true })
    expect(exitCode([1, false], opts)).toBe(1)
    expect(exitCode([false, 1], opts)).toBe(0)
    expect(exitCode([null], opts)).toBe(1)
    expect(exitCode([], opts)).toBe(4)
  })

  it('is zero without the flag', () => {
    expect(exitCode([], jqOptions())).toBe(0)
    expect(exitCode([null], jqOptions())).toBe(0)
  })
})

describe('positionalArgs', () => {
  it('reads the operands after the program as text', () => {
    expect(positionalArgs(view({ args: true }), ['.', 'a', 'b'], false)).toEqual(['a', 'b'])
  })

  it('keeps every operand when -f gave the program', () => {
    expect(positionalArgs(view({ args: true }), ['a', 'b'], true)).toEqual(['a', 'b'])
  })

  it('parses each operand under --jsonargs', () => {
    expect(positionalArgs(view({ jsonargs: true }), ['.', '1', '{"k":2}'], false)).toEqual([
      1,
      { k: 2 },
    ])
  })

  it('refuses invalid JSON under --jsonargs', () => {
    expect(() => positionalArgs(view({ jsonargs: true }), ['.', 'nope'], false)).toThrow(
      /invalid JSON text/,
    )
  })

  it('is empty without either flag', () => {
    expect(positionalArgs(view({}), ['.', 'a'], false)).toEqual([])
  })
})

describe('assembleInputs with --stream and --seq', () => {
  it('expands documents into events', async () => {
    expect(await assembleInputs([ENC.encode('{"a":1}')], jqOptions({ stream: true }))).toEqual([
      [['a'], 1],
      [['a']],
    ])
  })

  it('collects the events when slurped', async () => {
    const opts = jqOptions({ stream: true, slurp: true })
    expect(await assembleInputs([ENC.encode('{"a":1}')], opts)).toEqual([[[['a'], 1], [['a']]]])
  })

  it('reads only RS-introduced values', async () => {
    const chunks = [ENC.encode('\u001e{"a":1}\n\u001e{"a":2}\n')]
    expect(await assembleInputs(chunks, jqOptions({ seq: true }))).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('drops text before the first separator', async () => {
    expect(await assembleInputs([ENC.encode('{"a":1}\n')], jqOptions({ seq: true }))).toEqual([])
  })
})
