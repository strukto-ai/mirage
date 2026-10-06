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
import { isEacces } from '../../../../errors/fs.ts'
import { UsageError } from '../../../errors.ts'
import { findTable, jsonObject, oneOperand, scopedBase, stdinText } from './util.ts'

// Mirrors python/tests/commands/cli/builtin/airtable/test_util.py.

describe('airtable cli util', () => {
  it('admits the scoped bases and refuses the rest', () => {
    expect(scopedBase({ token: 't', baseIds: ['appA'] }, 'appA')).toBe('appA')
    expect(scopedBase({ token: 't' }, 'appB')).toBe('appB')
    let refused: unknown
    try {
      scopedBase({ token: 't', baseIds: ['appA'] }, 'appB')
    } catch (err) {
      refused = err
    }
    expect(isEacces(refused)).toBe(true)
    expect((refused as Error).message).toBe('appB: Permission denied')
  })

  it('finds a table by id before name', () => {
    const tables = [
      { id: 'tblA', name: 'tblB' },
      { id: 'tblB', name: 'B' },
    ]
    expect(findTable(tables, 'tblB')).toEqual({ id: 'tblB', name: 'B' })
    expect(findTable(tables, 'B')).toEqual({ id: 'tblB', name: 'B' })
    expect(findTable(tables, 'tblA')).toEqual({ id: 'tblA', name: 'tblB' })
    expect(findTable(tables, 'missing')).toBeUndefined()
  })

  it('refuses non-finite numbers as JSON', () => {
    expect(jsonObject('--fields', '{"a": 1.5}')).toEqual({ a: 1.5 })
    for (const text of ['NaN', '[Infinity]', '{"a": -Infinity}']) {
      expect(() => jsonObject('--fields', text)).toThrow(UsageError)
    }
    expect(() => jsonObject('--fields', '[]')).toThrow(/must be a JSON object/)
  })

  it('words operand refusals like argparse', () => {
    expect(oneOperand(['x'], 'BASE')).toBe('x')
    expect(() => oneOperand([], 'BASE')).toThrow(/are required: BASE/)
    expect(() => oneOperand(['x', 'y', 'z'], 'BASE')).toThrow(/unrecognized arguments: y z/)
  })

  it('drops a leading byte order mark from stdin', async () => {
    expect(await stdinText(new TextEncoder().encode('﻿{}\n'))).toBe('{}\n')
    expect(await stdinText(new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]))).toBe('café')
  })
})
