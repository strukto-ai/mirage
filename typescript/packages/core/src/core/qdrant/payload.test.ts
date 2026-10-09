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

import { fieldValue, withoutField } from './payload.ts'

describe('qdrant payload fields', () => {
  it('reads dotted keys with Qdrant nested-field semantics', () => {
    expect(fieldValue({ metadata: { source: 'nested' } }, 'metadata.source')).toBe('nested')
    expect(
      fieldValue(
        { 'metadata.source': 'literal', metadata: { source: 'nested' } },
        'metadata.source',
      ),
    ).toBe('nested')
    expect(fieldValue({ metadata: { source: 'x' } }, 'metadata.missing')).toBeUndefined()
  })

  it('removes nested render-only fields without mutating the row', () => {
    const row = { metadata: { source: 'report.pdf', blob: 'bytes' } }
    expect(withoutField(row, 'metadata.blob')).toEqual({ metadata: { source: 'report.pdf' } })
    expect(row.metadata.blob).toBe('bytes')
  })

  it.each(['__proto__', 'constructor', 'toString'])('reads only owned %s fields', (field) => {
    expect(fieldValue({}, field)).toBeUndefined()
    expect(fieldValue({ metadata: {} }, `metadata.${field}`)).toBeUndefined()
    expect(fieldValue({ [field]: 'payload' }, field)).toBe('payload')
  })

  it('preserves prototype-named keys when omitting nested fields', () => {
    const row = { ['__proto__']: { keep: 'value', blob: 'bytes' }, vector: [1] }
    const copied = withoutField(withoutField(row, 'vector'), '__proto__.blob')
    expect(JSON.stringify(copied)).toBe('{"__proto__":{"keep":"value"}}')
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype)
    expect(row.__proto__.blob).toBe('bytes')
  })
})
