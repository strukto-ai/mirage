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
import { FileType } from '@struktoai/mirage-core'
import { attrsToFileStat } from './entry.ts'

describe('attrsToFileStat', () => {
  it('returns DIRECTORY type for a directory mode', () => {
    const stat = attrsToFileStat('mydir', { mode: 0o040755, size: 0 })
    expect(stat.type).toBe(FileType.DIRECTORY)
    expect(stat.name).toBe('mydir')
  })

  it('returns JSON type for foo.json', () => {
    const stat = attrsToFileStat('foo.json', { mode: 0o100644, size: 12 })
    expect(stat.type).toBe(FileType.JSON)
    expect(stat.name).toBe('foo.json')
  })

  it('returns TEXT type for foo.txt with regular-file mode', () => {
    const stat = attrsToFileStat('foo.txt', { mode: 0o100644, size: 7 })
    expect(stat.type).toBe(FileType.TEXT)
    expect(stat.name).toBe('foo.txt')
  })

  it('returns BINARY type for foo.bin', () => {
    const stat = attrsToFileStat('foo.bin', { mode: 0o100644, size: 0 })
    expect(stat.type).toBe(FileType.BINARY)
  })

  it('formats modified as ISO 8601 when mtime is given', () => {
    const stat = attrsToFileStat('foo.txt', { mode: 0o100644, mtime: 0 })
    expect(stat.modified).toBe('1970-01-01T00:00:00.000Z')
  })

  it('returns null modified when mtime is omitted', () => {
    const stat = attrsToFileStat('foo.txt', { mode: 0o100644 })
    expect(stat.modified).toBeNull()
  })

  it('carries the name through unchanged', () => {
    const stat = attrsToFileStat('weird-name.parquet', { mode: 0o100644, size: 100 })
    expect(stat.name).toBe('weird-name.parquet')
    expect(stat.type).toBe(FileType.BINARY)
  })
})
