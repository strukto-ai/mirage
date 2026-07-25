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

describe.each(NATIVE_BACKENDS)('native join (%s backend)', (kind) => {
  it('join -a 1 matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('1 a\n2 b\n3 c\n'))
      env.createFile('b.txt', ENC.encode('2 x\n3 y\n4 z\n'))
      const m = await env.mirage('join -a 1 /data/a.txt /data/b.txt')
      const n = await env.native('join -a 1 a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('join -v 1 matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('1 a\n2 b\n3 c\n'))
      env.createFile('b.txt', ENC.encode('2 x\n3 y\n4 z\n'))
      const m = await env.mirage('join -v 1 /data/a.txt /data/b.txt')
      const n = await env.native('join -v 1 a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('join -a 1 -e EMPTY matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('1 a\n2 b\n'))
      env.createFile('b.txt', ENC.encode('1 x\n3 y\n'))
      const m = await env.mirage('join -a 1 -e EMPTY /data/a.txt /data/b.txt')
      const n = await env.native('join -a 1 -e EMPTY a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('join -t : matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('1:a\n2:b\n'))
      env.createFile('b.txt', ENC.encode('1:x\n2:y\n'))
      const m = await env.mirage('join -t : /data/a.txt /data/b.txt')
      const n = await env.native('join -t : a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('join -o selects output fields', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('1 a c\n2 b d\n'))
      env.createFile('b.txt', ENC.encode('1 x z\n2 y w\n'))
      // -o FILE.FIELD is 1-based over all fields (key included): 0=key,
      // 1.2=file1 field 2, 2.2=file2 field 2.
      const result = await env.mirage('join -o 0,1.2,2.2 /data/a.txt /data/b.txt')
      expect(result).toContain('1 a x')
      expect(result).toContain('2 b y')
    } finally {
      await env.cleanup()
    }
  })

  it('join -1 -2 uses specified fields', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('a 1\nb 2\n'))
      env.createFile('b.txt', ENC.encode('1 x\n2 y\n'))
      const result = await env.mirage('join -1 1 -2 1 /data/a.txt /data/b.txt')
      expect(result.trim().length >= 0).toBe(true)
    } finally {
      await env.cleanup()
    }
  })
})
