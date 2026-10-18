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

describe.each(NATIVE_BACKENDS)('native zip (%s backend)', (kind) => {
  it('zip -j junk path', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('sub/a.txt', ENC.encode('hello'))
      await env.mirage('zip -j /data/out.zip /data/sub/a.txt')
      const result = await env.mirage('unzip -l /data/out.zip')
      expect(result).toContain('a.txt')
      expect(result.replace(/a\.txt/g, '')).not.toContain('sub')
    } finally {
      await env.cleanup()
    }
  })

  it('zip -q quiet', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello'))
      const result = await env.mirage('zip -q /data/out.zip /data/a.txt')
      expect(result.trim()).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('zip -r recursive', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('sub/a.txt', ENC.encode('hello'))
      await env.mirage('zip -r /data/out.zip /data/sub/a.txt')
      const result = await env.mirage('unzip -l /data/out.zip')
      expect(result).toContain('a.txt')
    } finally {
      await env.cleanup()
    }
  })
})
