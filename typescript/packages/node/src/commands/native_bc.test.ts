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

const ENC = new TextEncoder()

describe.each(NATIVE_BACKENDS)('native bc (%s backend)', (kind) => {
  it('bc -q matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('2+3\n')
      const m = await env.mirage('bc -q', data)
      const n = await env.native('bc -q', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('bc -l sqrt(2) contains 1.41', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('sqrt(2)\n')
      const result = await env.mirage('bc -l', data)
      expect(result).toContain('1.41')
    } finally {
      await env.cleanup()
    }
  })
})
