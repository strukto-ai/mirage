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
import { makeEnv, NATIVE_BACKENDS } from './native_fixture.ts'

const ENC = new TextEncoder()

describe.each(NATIVE_BACKENDS)('native stat (%s backend)', (kind) => {
  it("stat -c '%s' reports file size", async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello'))
      const result = await env.mirage("stat -c '%s' /data/f.txt")
      expect(result.trim()).toBe('5')
    } finally {
      await env.cleanup()
    }
  })

  it("stat -f -c '%T' names the backend", async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello'))
      const result = await env.mirage("stat -f -c '%n %T' /data/f.txt")
      expect(result.trim()).toBe(`/data/f.txt ${kind}`)
    } finally {
      await env.cleanup()
    }
  })
})
