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
import { parseMountGrants } from './session.ts'

describe('parseMountGrants', () => {
  it('parses role suffixes and defaults bare prefixes to exec', () => {
    expect(parseMountGrants(['/data:read', '/scratch:write', '/tools'])).toEqual({
      '/data': 'read',
      '/scratch': 'write',
      '/tools': 'exec',
    })
  })

  it('parses filesystem alias role suffixes', () => {
    expect(parseMountGrants(['/data:r', '/scratch:rw', '/bin:rwx'])).toEqual({
      '/data': 'r',
      '/scratch': 'rw',
      '/bin': 'rwx',
    })
  })

  it('keeps colons that are not role suffixes in the prefix', () => {
    expect(parseMountGrants(['/weird:name'])).toEqual({ '/weird:name': 'exec' })
  })
})
