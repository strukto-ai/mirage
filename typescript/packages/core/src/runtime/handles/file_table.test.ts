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
import { FileTable } from './file_table.ts'

describe('FileTable', () => {
  it('hands out dense ids from firstId', () => {
    const table = new FileTable<string>(4)
    expect(table.add('a')).toBe(4)
    expect(table.add('b')).toBe(5)
    expect(table.get(4)).toBe('a')
    expect(table.has(5)).toBe(true)
    expect(table.has(9)).toBe(false)
  })

  it('set and pop move entries without burning ids', () => {
    const table = new FileTable<string>()
    const fd = table.add('a')
    table.set(0, 'seeded')
    expect(table.pop(fd)).toBe('a')
    expect(table.pop(fd)).toBeUndefined()
    expect(table.get(0)).toBe('seeded')
    expect([...table.values()]).toEqual(['seeded'])
  })
})
