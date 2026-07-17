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
import { newSessionId, newWorkspaceId, uuid7 } from './ids.ts'

const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuid7', () => {
  it('is canonical lowercase and version 7', () => {
    expect(uuid7()).toMatch(UUID7_RE)
  })

  it('embeds the current timestamp', () => {
    const before = Date.now()
    const value = uuid7()
    const after = Date.now()
    const embedded = parseInt(value.slice(0, 8) + value.slice(9, 13), 16)
    expect(embedded).toBeGreaterThanOrEqual(before - 10)
    expect(embedded).toBeLessThanOrEqual(after + 10)
  })

  it('orders across milliseconds', async () => {
    const first = uuid7()
    await new Promise((r) => setTimeout(r, 2))
    const second = uuid7()
    expect(first < second).toBe(true)
  })

  it('is unique', () => {
    const values = new Set(Array.from({ length: 1000 }, () => uuid7()))
    expect(values.size).toBe(1000)
  })
})

describe('id kinds', () => {
  it('share the format', () => {
    expect(newWorkspaceId()).toMatch(UUID7_RE)
    expect(newSessionId()).toMatch(UUID7_RE)
  })
})
