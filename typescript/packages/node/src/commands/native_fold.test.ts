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

describe.each(NATIVE_BACKENDS)('native fold (%s backend)', (kind) => {
  it('fold -w 10 matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('abcdefghijklmnopqrstuvwxyz\n')
      const m = await env.mirage('fold -w 10', data)
      const n = await env.native('fold -w 10', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('fold -w 10 file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('abcdefghijklmnopqrstuvwxyz\n'))
      const m = await env.mirage('fold -w 10 /data/f.txt')
      const n = await env.native('fold -w 10 f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('fold -w 12 -s matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello world this is a test\n')
      const m = await env.mirage('fold -w 12 -s', data)
      const n = await env.native('fold -w 12 -s', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })
})
