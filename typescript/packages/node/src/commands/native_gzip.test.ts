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

describe.each(NATIVE_BACKENDS)('native gzip (%s backend)', (kind) => {
  it('gzip -c writes compressed output to stdout', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello world\n')
      const result = await env.mirage('gzip -c', data)
      expect(result.length).toBeGreaterThan(0)
    } finally {
      await env.cleanup()
    }
  })

  it('gzip -9 compresses at least as well as -1', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello world '.repeat(100))
      const r1 = await env.mirage('gzip -1 -c', data)
      const r9 = await env.mirage('gzip -9 -c', data)
      expect(r9.length).toBeLessThanOrEqual(r1.length)
    } finally {
      await env.cleanup()
    }
  })

  it('gzip -d decompresses', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      await env.mirage('gzip /data/f.txt')
      await env.mirage('gzip -d /data/f.txt.gz')
      const result = await env.mirage('cat /data/f.txt')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('gzip -k keeps original file', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      await env.mirage('gzip -k /data/f.txt')
      const original = await env.mirage('cat /data/f.txt')
      expect(original).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('gzip -f force compresses', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      await env.mirage('gzip -f /data/f.txt')
      const result = await env.mirage('gunzip -c /data/f.txt.gz')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })
})
