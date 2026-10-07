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
import { encodeText } from '../../../../shell/bytes.ts'
import { runPrintf } from './format.ts'

// GNU pins taken in debian:stable-slim. `handlePrintf` collapses the
// message list into one stderr blob and a status, so the list itself —
// order and count — is only observable here. Mirrors python's
// tests/workspace/executor/builtins/printf/test_format.py.

// bash 5.2.37 through `od -An -tx1`: the format reads \NNN, one to three
// octal digits, and a %b argument also reads \0NNN, a leading 0 and up
// to three more.
const OCTAL_PINS: [string, string, string][] = [
  ['\\0003', '00 33', '03'],
  ['\\0', '00', '00'],
  ['\\00', '00', '00'],
  ['\\000', '00', '00'],
  ['\\0000', '00 30', '00'],
  ['\\08', '00 38', '00 38'],
  ['\\101', '41', '41'],
  ['\\1011', '41 31', '41 31'],
  ['\\0101', '08 31', '41'],
  ['\\400', '00', '00'],
  ['\\0400', '20 30', '00'],
]

// bash 5.2.37 under LC_ALL=C.UTF-8 through `od -An -tx1`: the format and
// a %b argument UTF-8-encode \u and \U values, so a surrogate half
// and a value past Unicode come out UTF-8-shaped, and 0x80000000 and
// past come out as nothing.
const UNICODE_PINS: [string, string][] = [
  ['\\uD800', 'ed a0 80'],
  ['\\uDC80', 'ed b2 80'],
  ['\\uDFFF', 'ed bf bf'],
  ['\\uD83D\\uDE00', 'ed a0 bd ed b8 80'],
  ['\\U00110000', 'f4 90 80 80'],
  ['\\U0010FFFF', 'f4 8f bf bf'],
  ['\\U7FFFFFFF', 'fd bf bf bf bf bf'],
  ['\\U80000000', ''],
  ['\\UFFFFFFFF', ''],
  ['x\\UFFFFFFFFy', '78 79'],
  ['a\\u0000b', '61 00 62'],
  ['\\uDC80\\xff', 'ed b2 80 ff'],
]

const HEX_WARNING = 'printf: missing hex digit for \\x\n'

const ABC_INVALID = 'printf: abc: invalid number\n'

const DEF_INVALID = 'printf: def: invalid number\n'

// bash 5.2.37: an escape with no hex digit after it is written as it
// stands and warns on stderr, in the format and in a %b argument alike,
// and the status stays 0.
const MISSING_DIGIT_PINS: [string, string[]][] = [
  ['\\x|', [HEX_WARNING]],
  ['\\xg', [HEX_WARNING]],
  ['\\x', [HEX_WARNING]],
  [
    '\\u|\\U|',
    ['printf: missing unicode digit for \\u\n', 'printf: missing unicode digit for \\U\n'],
  ],
]

function od(text: string): string {
  return Array.from(encodeText(text), (b) => b.toString(16).padStart(2, '0')).join(' ')
}

describe('runPrintf', () => {
  it('returns errors as a list in argument order', () => {
    const [out, messages, failed] = runPrintf('%d %d\n', ['abc', 'def'])
    expect(out).toBe('0 0\n')
    expect(messages).toEqual(['printf: abc: invalid number\n', 'printf: def: invalid number\n'])
    expect(failed).toBe(true)
  })

  it('ends the reuse when a cycle consumes nothing', () => {
    // `a%%b` has no conversion, so the first cycle consumes no argument
    // and the excess args are dropped rather than looping forever; the
    // first one dropped comes back for coreutils' warning.
    expect(runPrintf('a%%b\n', ['x', 'y', 'z'])).toEqual(['a%b\n', [], false, 'x'])
  })

  it('drops every argument for an empty format', () => {
    expect(runPrintf('', ['a', 'b', 'c'])).toEqual(['', [], false, 'a'])
  })

  it('drops nothing when the format is reused', () => {
    expect(runPrintf('%s-%s\n', ['a', 'b', 'c'])).toEqual(['a-b\nc-\n', [], false, null])
  })

  it('drops nothing to warn about after \\c in the format', () => {
    expect(runPrintf('x\\c', ['a'])).toEqual(['x', [], false, null])
  })

  it('suppresses the rest of the format after a stop from %b', () => {
    expect(runPrintf('[%b][%s]\n', ['ab\\ccd', 'tail'])).toEqual(['[ab', [], false, null])
  })

  it('ends every cycle when the stop lands on a later one', () => {
    expect(runPrintf('<%b>', ['one', 'tw\\co', 'three'])).toEqual(['<one><tw', [], false, null])
  })

  it.each([
    ['0.5', '0'],
    ['1.5', '2'],
    ['2.5', '2'],
    ['3.5', '4'],
  ])('rounds %s half-to-even at fixed precision', (value, expected) => {
    expect(runPrintf('%.0f', [value])).toEqual([expected, [], false, null])
  })

  it('renders a missing argument as the empty string or zero', () => {
    expect(runPrintf('[%s][%d]', [])).toEqual(['[][0]', [], false, null])
  })

  it.each(OCTAL_PINS)(
    'reads %s as three digits in the format and a zero plus three in %%b',
    (escape, inFormat, inBArg) => {
      const [fmtOut, fmtMessages, fmtFailed] = runPrintf(escape, [])
      const [bOut, bMessages, bFailed] = runPrintf('%b', [escape])
      expect([od(fmtOut), fmtMessages, fmtFailed]).toEqual([inFormat, [], false])
      expect([od(bOut), bMessages, bFailed]).toEqual([inBArg, [], false])
    },
  )

  it.each(UNICODE_PINS)(
    'UTF-8-encodes %s in the format and in a %b argument',
    (escape, expected) => {
      const [fmtOut, fmtMessages, fmtFailed] = runPrintf(escape, [])
      const [bOut, bMessages, bFailed] = runPrintf('%b', [escape])
      expect([od(fmtOut), fmtMessages, fmtFailed]).toEqual([expected, [], false])
      expect([od(bOut), bMessages, bFailed]).toEqual([expected, [], false])
    },
  )

  it.each(MISSING_DIGIT_PINS)('warns for %s without failing', (escapes, warnings) => {
    expect(runPrintf(escapes, [])).toEqual([escapes, warnings, false, null])
    expect(runPrintf('%b', [escapes])).toEqual([escapes, warnings, false, null])
  })

  it('returns warnings and invalid numbers in scan order', () => {
    expect(runPrintf('\\x%d\n', ['abc'])).toEqual([
      '\\x0\n',
      [HEX_WARNING, ABC_INVALID],
      true,
      null,
    ])
    expect(runPrintf('%d\\x\n', ['abc'])).toEqual([
      '0\\x\n',
      [ABC_INVALID, HEX_WARNING],
      true,
      null,
    ])
    expect(runPrintf('%d%b\n', ['abc', '\\x'])).toEqual([
      '0\\x\n',
      [ABC_INVALID, HEX_WARNING],
      true,
      null,
    ])
  })

  it('warns once per pass of a reused format', () => {
    expect(runPrintf('\\x%s\n', ['a', 'b'])).toEqual([
      '\\xa\n\\xb\n',
      [HEX_WARNING, HEX_WARNING],
      false,
      null,
    ])
    expect(runPrintf('\\x\n', ['a', 'b'])).toEqual(['\\x\n', [HEX_WARNING], false, 'a'])
  })

  it('warns for a %b argument up to its stop and before its precision', () => {
    expect(runPrintf('%b\n', ['a\\cb\\x'])).toEqual(['a', [], false, null])
    expect(runPrintf('%.1b\n', ['\\xy'])).toEqual(['\\\n', [HEX_WARNING], false, null])
  })

  // bash 5.2.37: %b's \c returns from printf with the status it has so
  // far, before the end of the builtin folds an invalid number into it.
  it('reports no failure when %b stops after an invalid number', () => {
    expect(runPrintf('%d%b', ['abc', '\\c'])).toEqual(['0', [ABC_INVALID], false, null])
    expect(runPrintf('%d%b\n', ['abc', 'x\\cy'])).toEqual(['0x', [ABC_INVALID], false, null])
    expect(runPrintf('%d%b', ['abc', 'x', 'def', '\\c'])).toEqual([
      '0x0',
      [ABC_INVALID, DEF_INVALID],
      false,
      null,
    ])
  })

  it('never reads an invalid number after the stop', () => {
    expect(runPrintf('%b%d', ['\\c', 'abc'])).toEqual(['', [], false, null])
  })

  it('still fails for an invalid number without a stop', () => {
    expect(runPrintf('%d%b', ['abc', 'x'])).toEqual(['0x', [ABC_INVALID], true, null])
  })
})
