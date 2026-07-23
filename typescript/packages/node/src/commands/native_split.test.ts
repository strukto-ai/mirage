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

describe.each(NATIVE_BACKENDS)('native split (%s backend)', (kind) => {
  it('split -d numeric suffix', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\nc\nd\n'))
      await env.mirage('split -d -l 2 /data/f.txt /data/part')
      const result = await env.mirage('cat /data/part00')
      expect(result).toContain('a')
    } finally {
      await env.cleanup()
    }
  })

  it('split -b byte chunks', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world this is a test\n'))
      await env.mirage('split -b 10 /data/f.txt /data/chunk')
      const result = await env.mirage('cat /data/chunkaa')
      expect(result.length).toBeGreaterThan(0)
    } finally {
      await env.cleanup()
    }
  })

  it('split -a suffix length', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\nc\nd\n'))
      await env.mirage('split -d -a 3 -l 2 /data/f.txt /data/p')
      const result = await env.mirage('ls /data')
      expect(result).toContain('p000')
    } finally {
      await env.cleanup()
    }
  })

  it('split -n number of chunks', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('abcdefghij'))
      await env.mirage('split -n 2 /data/f.txt /data/chunk')
      const r1 = await env.mirage('cat /data/chunkaa')
      const r2 = await env.mirage('cat /data/chunkab')
      expect(r1.length).toBeGreaterThan(0)
      expect(r2.length).toBeGreaterThan(0)
    } finally {
      await env.cleanup()
    }
  })

  it('supports a custom record separator and additional suffix', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a,b,c,d,'))
      await env.mirage('split -t, -l 2 --additional-suffix=.part /data/f.txt /data/p')
      expect(await env.mirage('cat /data/paa.part')).toBe('a,b,')
      expect(await env.mirage('cat /data/pab.part')).toBe('c,d,')
    } finally {
      await env.cleanup()
    }
  })
})
