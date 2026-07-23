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
import { parseMode } from './mode.ts'

describe('parseMode', () => {
  it('parses octal modes', () => {
    expect(parseMode('644', 0)).toBe(0o644)
    expect(parseMode('0', 0o777)).toBe(0)
    expect(parseMode('7777', 0)).toBe(0o7777)
  })

  it('rejects out-of-range octal', () => {
    expect(parseMode('77777', 0)).toBeNull()
  })

  it('applies symbolic add/remove/assign', () => {
    expect(parseMode('u+x', 0o644)).toBe(0o744)
    expect(parseMode('+x', 0o644)).toBe(0o755)
    expect(parseMode('go-r', 0o644)).toBe(0o600)
    expect(parseMode('a=r', 0o777)).toBe(0o444)
    expect(parseMode('u=rwx,go=', 0o644)).toBe(0o700)
    expect(parseMode('u+x,g-r', 0o644)).toBe(0o704)
  })

  it('rejects invalid symbolic text', () => {
    expect(parseMode('zz', 0o644)).toBeNull()
    expect(parseMode('u~x', 0o644)).toBeNull()
    expect(parseMode('u+q', 0o644)).toBeNull()
  })
})
