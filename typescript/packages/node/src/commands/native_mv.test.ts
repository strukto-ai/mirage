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

describe.each(NATIVE_BACKENDS)('native mv (%s backend)', (kind) => {
  it('mv -v prints -> arrow', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('mv_src.txt', ENC.encode('hello'))
      const result = await env.mirage('mv -v /data/mv_src.txt /data/mv_dst.txt')
      expect(result).toContain('->')
    } finally {
      await env.cleanup()
    }
  })

  it('mv -n does not overwrite existing file', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa'))
      env.createFile('b.txt', ENC.encode('bbb'))
      await env.mirage('mv -n /data/a.txt /data/b.txt')
      const result = await env.mirage('cat /data/b.txt')
      expect(result).toContain('bbb')
    } finally {
      await env.cleanup()
    }
  })

  it('mv -f overwrites existing file', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa'))
      env.createFile('b.txt', ENC.encode('bbb'))
      await env.mirage('mv -f /data/a.txt /data/b.txt')
      const result = await env.mirage('cat /data/b.txt')
      expect(result).toContain('aaa')
    } finally {
      await env.cleanup()
    }
  })
})
