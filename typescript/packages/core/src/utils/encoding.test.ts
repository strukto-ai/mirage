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
import { bomOf } from './encoding.ts'

describe('encoding', () => {
  it('names the mark a stream starts with', () => {
    expect(bomOf(new Uint8Array([0xef, 0xbb, 0xbf, 0x78]))?.[1]).toBe('UTF-8')
    expect(bomOf(new Uint8Array([0xff, 0xfe, 0x68]))?.[1]).toBe('UTF-16LE')
    expect(bomOf(new Uint8Array([0xfe, 0xff]))?.[1]).toBe('UTF-16BE')
    expect(bomOf(new Uint8Array([0xef, 0xbb]))).toBeNull()
  })
})
