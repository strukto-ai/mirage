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

describe.each(NATIVE_BACKENDS)('native tail (%s backend)', (kind) => {
  it('tail default matches native', async () => {
    const env = makeEnv(kind)
    try {
      let lines = ''
      for (let i = 1; i < 20; i++) lines += `line${String(i)}\n`
      env.createFile('f.txt', ENC.encode(lines))
      const m = await env.mirage('tail /data/f.txt')
      const n = await env.native('tail f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('tail -n 3 matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\nc\nd\ne\n'))
      const m = await env.mirage('tail -n 3 /data/f.txt')
      const n = await env.native('tail -n 3 f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('tail -c 5 matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\n'))
      const m = await env.mirage('tail -c 5 /data/f.txt')
      const n = await env.native('tail -c 5 f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('tail stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\nd\ne\n')
      const m = await env.mirage('tail -n 3', data)
      const n = await env.native('tail -n 3', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('tail -n +N matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\nc\nd\ne\n'))
      const m = await env.mirage('tail -n +3 /data/f.txt')
      const n = await env.native('tail -n +3 f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('tail -n +N stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\nd\ne\n')
      const m = await env.mirage('tail -n +2', data)
      const n = await env.native('tail -n +2', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('tail -q quiet includes content', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      const result = await env.mirage('tail -q /data/a.txt')
      expect(result).toContain('aaa')
    } finally {
      await env.cleanup()
    }
  })

  it('tail -v verbose includes content', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      const result = await env.mirage('tail -v /data/a.txt')
      expect(result).toContain('aaa')
    } finally {
      await env.cleanup()
    }
  })
})
