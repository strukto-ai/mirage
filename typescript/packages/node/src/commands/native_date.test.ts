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
import { makeEnv, NATIVE_BACKENDS } from '../../tests/commands/native_fixture.ts'

describe.each(NATIVE_BACKENDS)('native date (%s backend)', (kind) => {
  it('date -I produces 10-char ISO date', async () => {
    const env = makeEnv(kind)
    try {
      const result = await env.mirage('date -I')
      expect(result.trim().length).toBe(10)
    } finally {
      await env.cleanup()
    }
  })

  it('date -R includes comma', async () => {
    const env = makeEnv(kind)
    try {
      const result = await env.mirage('date -R')
      expect(result).toContain(',')
    } finally {
      await env.cleanup()
    }
  })

  it('date -u produces output', async () => {
    const env = makeEnv(kind)
    try {
      const result = await env.mirage('date -u')
      const passes = result.includes('UTC') || result.includes('GMT') || result.trim().length > 0
      expect(passes).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it("date -d '2024-01-15' contains year or month", async () => {
    const env = makeEnv(kind)
    try {
      const result = await env.mirage("date -d '2024-01-15'")
      const passes = result.includes('2024') || result.includes('Jan')
      expect(passes).toBe(true)
    } finally {
      await env.cleanup()
    }
  })
})
