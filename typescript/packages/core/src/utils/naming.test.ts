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
import { SEPARATOR, fitIdName, makeIdName, parseIdName } from './naming.ts'
import { NAME_MAX_BYTES, byteLength } from './sanitize.ts'

const CJK = '会議の記録'.repeat(40)
const SLACK_ID = 'C01ABCDEFGH'

describe('makeIdName', () => {
  it('sanitizes by default', () => {
    expect(makeIdName('general', 'C123456')).toBe('general__C123456')
    expect(makeIdName('My Project!', 'uuid-abc')).toBe('My_Project__uuid-abc')
  })

  it('keeps the spelling when pathSafe', () => {
    expect(makeIdName("Zecheng's Server", 'G1', true)).toBe("Zecheng's Server__G1")
  })

  it('takes the suffix as an argument', () => {
    // Appending `.json` afterwards spends bytes the budget never saw, which
    // is how a name that just fits became one that does not.
    expect(makeIdName('notes', 'U1', false, '.json')).toBe('notes__U1.json')
  })

  it.each([false, true])('fits a CJK label into NAME_MAX (pathSafe=%s)', (pathSafe) => {
    // sanitizeName caps at 100 characters and pathSafeName does not cap at
    // all, so this reached 313 and 621 bytes against a 255-byte NAME_MAX and
    // the filesystem refused the name.
    const name = makeIdName(CJK, SLACK_ID, pathSafe)
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    // The cut lands on a character boundary, never mid-sequence.
    expect(name).not.toContain('\uFFFD')
  })

  it('round trips a truncated label', () => {
    const name = makeIdName(CJK, SLACK_ID, false, '.json')
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(parseIdName(name, '.json')[1]).toBe(SLACK_ID)
  })

  it('never trims the id to make room', () => {
    // The label is what gives: a shortened id would stop addressing the
    // VFS, so an id too wide to name is over budget rather than
    // silently mangled. Same rule as gcal's event filenames.
    const longId = 'v'.repeat(NAME_MAX_BYTES + 10)
    const name = makeIdName('Some Name', longId)
    expect(byteLength(name)).toBeGreaterThan(NAME_MAX_BYTES)
    expect(name).toBe(`${SEPARATOR}${longId}`)
    expect(parseIdName(name)[1]).toBe(longId)
  })

  it('leaves a short name untouched', () => {
    expect(makeIdName('hello', 'G1')).toBe('hello__G1')
    // An underscore the caller meant to keep survives, because the trim only
    // runs when the budget is actually exceeded.
    expect(makeIdName('hello_', 'G1', true)).toBe('hello___G1')
  })
})

describe('fitIdName', () => {
  it('does not re-sanitize the label', () => {
    // Linear's team directory joins two sanitized parts with the separator
    // itself; running sanitizeName over that would collapse `__` to `_` and
    // change the name's shape, which is why the budget takes an
    // already-transformed label.
    expect(fitIdName('ENG__Engineering', 't1')).toBe('ENG__Engineering__t1')
  })

  it('leaves no trailing underscore from the cut', () => {
    const name = fitIdName('a'.repeat(300) + '_'.repeat(5), 'id1')
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(name).not.toContain('___')
  })
})

describe('parseIdName', () => {
  it('recovers the id', () => {
    expect(parseIdName('general__C123456')).toEqual(['general', 'C123456'])
    expect(parseIdName('team__uuid.json', '.json')).toEqual(['team', 'uuid'])
  })

  it.each(['nosep', 'trailing__', 'wrong.txt'])('refuses %s', (name) => {
    expect(() => parseIdName(name)).toThrow()
  })
})
