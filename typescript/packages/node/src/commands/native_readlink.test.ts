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

describe.each(NATIVE_BACKENDS)('native readlink (%s backend)', (kind) => {
  it('readlink -n -f does not append newline', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('rl.txt', ENC.encode('x'))
      const result = await env.mirage('readlink -n -f /data/rl.txt')
      expect(result.endsWith('\n')).toBe(false)
    } finally {
      await env.cleanup()
    }
  })

  it('readlink -m resolves nonexistent path', async () => {
    const env = makeEnv(kind)
    try {
      const result = await env.mirage('readlink -m /data/nonexistent/path')
      expect(result.includes('/data/nonexistent/path') || result.includes('nonexistent')).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('readlink -e resolves existing file', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello'))
      const result = await env.mirage('readlink -e /data/f.txt')
      expect(result).toContain('f.txt')
    } finally {
      await env.cleanup()
    }
  })
})
