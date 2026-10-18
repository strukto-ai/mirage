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

describe.each(NATIVE_BACKENDS)('native pwd (%s backend)', (kind) => {
  it('pwd -P equals pwd', async () => {
    const env = makeEnv(kind)
    try {
      const p = await env.mirage('pwd -P')
      const q = await env.mirage('pwd')
      expect(p).toBe(q)
    } finally {
      await env.cleanup()
    }
  })

  it('pwd -L returns non-empty path', async () => {
    const env = makeEnv(kind)
    try {
      const result = await env.mirage('pwd -L')
      expect(result.trim().length).toBeGreaterThan(0)
    } finally {
      await env.cleanup()
    }
  })
})
