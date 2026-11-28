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
import { InvalidOption, checkChoice, jsNumber, parseNumber, splitCsv } from './options.ts'

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof InvalidOption) return error.message
    throw error
  }
  throw new Error('expected an InvalidOption')
}

// Mirrors python's tests/commands/cli/builtin/tvly/test_options.py.
describe('tvly option values', () => {
  it.each([
    [' 5 ', 5],
    ['0x10', 16],
    ['1e3', 1000],
    ['.5', 0.5],
    ['1.', 1],
  ])('reads %j as JavaScript reads it', (raw, value) => {
    expect(jsNumber(raw)).toBe(value)
  })

  it.each(['1_0', 'inf', '0x', '-0x10', '5n'])('reads %j as NaN', (raw) => {
    expect(Number.isNaN(jsNumber(raw))).toBe(true)
  })

  it('keeps a whole number whole', () => {
    expect(parseNumber('7', '--max-results <n>', { integer: true })).toBe(7)
  })

  it.each([
    ['abc', {}, 'Not a number.'],
    ['', {}, 'Not a number.'],
    ['1.5', { integer: true }, 'Not an integer.'],
    ['30', { maximum: 20 }, '30 is above the maximum 20.'],
    ['-1', { minimum: 0 }, '-1 is below the minimum 0.'],
  ])("refuses %j in commander's words", (raw, options, reason) => {
    expect(refusal(() => parseNumber(raw, '--max-results <n>', options))).toBe(
      `error: option '--max-results <n>' argument '${raw}' is invalid. ${reason}`,
    )
  })

  it('reads a radix past the double range as Infinity', () => {
    expect(jsNumber(`0x${'f'.repeat(256)}`)).toBe(Infinity)
    expect(
      refusal(() => parseNumber(`0x${'f'.repeat(256)}`, '--max-results <n>', { integer: true })),
    ).toContain('Not an integer.')
  })

  it('names every allowed value of a choice', () => {
    expect(checkChoice('pro', '--model <model>', ['mini', 'pro'])).toBe('pro')
    expect(refusal(() => checkChoice('max', '--model <model>', ['mini', 'pro']))).toContain(
      'Allowed choices are mini, pro.',
    )
  })

  it('keeps the empty parts of a comma list, trimmed', () => {
    expect(splitCsv(' /a , /b,')).toEqual(['/a', '/b', ''])
    expect(splitCsv('')).toBeUndefined()
    expect(splitCsv(undefined)).toBeUndefined()
  })
})
