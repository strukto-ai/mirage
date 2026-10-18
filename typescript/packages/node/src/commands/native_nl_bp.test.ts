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

describe.each(NATIVE_BACKENDS)('native nl -bp (%s backend)', (kind) => {
  it('nl -bp numbers only matching lines', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello\nworld\nhello again\n')
      const result = await env.mirage("nl -bp'hello'", data)
      const lines = result.trim().split('\n')
      const numbered = lines.filter((ln) => {
        const stripped = ln.trim()
        return stripped.length > 0 && /^[0-9]/.test(stripped)
      })
      expect(numbered.length).toBe(2)
    } finally {
      await env.cleanup()
    }
  })
})
