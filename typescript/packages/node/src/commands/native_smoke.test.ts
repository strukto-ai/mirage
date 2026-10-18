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

describe.each(NATIVE_BACKENDS)('native smoke (%s backend)', (kind) => {
  it('create and cat matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\n'))
      const m = await env.mirage('cat /data/f.txt')
      const n = await env.native('cat f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('create subdir and cat matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('sub/f.txt', ENC.encode('nested\n'))
      const m = await env.mirage('cat /data/sub/f.txt')
      const n = await env.native('cat sub/f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })
})
