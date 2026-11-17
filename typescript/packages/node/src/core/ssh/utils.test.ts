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
import { isDirectoryAttrs, isFileAttrs, isNoSuchFile } from './utils.ts'

describe('isNoSuchFile', () => {
  it('returns true for { code: 2 }', () => {
    expect(isNoSuchFile({ code: 2 })).toBe(true)
  })
  it('returns false for { code: 4 }', () => {
    expect(isNoSuchFile({ code: 4 })).toBe(false)
  })
  it('returns false for null', () => {
    expect(isNoSuchFile(null)).toBe(false)
  })
  it('returns false for undefined', () => {
    expect(isNoSuchFile(undefined)).toBe(false)
  })
  it('returns false for a plain Error without code', () => {
    expect(isNoSuchFile(new Error('x'))).toBe(false)
  })
})

describe('isDirectoryAttrs', () => {
  it('returns true for a dir mode', () => {
    expect(isDirectoryAttrs({ mode: 0o040755 })).toBe(true)
  })
  it('returns false for a regular file mode', () => {
    expect(isDirectoryAttrs({ mode: 0o100644 })).toBe(false)
  })
  it('returns false when mode is missing', () => {
    expect(isDirectoryAttrs({})).toBe(false)
  })
})

describe('isFileAttrs', () => {
  it('returns true for a regular file mode', () => {
    expect(isFileAttrs({ mode: 0o100644 })).toBe(true)
  })
  it('returns false for a dir mode', () => {
    expect(isFileAttrs({ mode: 0o040755 })).toBe(false)
  })
  it('returns false when mode is missing', () => {
    expect(isFileAttrs({})).toBe(false)
  })
})
