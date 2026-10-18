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

describe.each(NATIVE_BACKENDS)('native cmp (%s backend)', (kind) => {
  it('cmp identical matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('same\n'))
      env.createFile('b.txt', ENC.encode('same\n'))
      const m = await env.mirage('cmp /data/a.txt /data/b.txt')
      const n = await env.native('cmp a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('cmp -s silent', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      env.createFile('b.txt', ENC.encode('bbb\n'))
      expect(await env.mirage('cmp -s /data/a.txt /data/b.txt')).toBe('')
      expect(await env.native('cmp -s a.txt b.txt')).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('cmp -n 5 matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello world'))
      env.createFile('b.txt', ENC.encode('hello earth'))
      const m = await env.mirage('cmp -n 5 /data/a.txt /data/b.txt')
      const n = await env.native('cmp -n 5 a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('cmp -n 10 differ agreement', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello world'))
      env.createFile('b.txt', ENC.encode('hello earth'))
      const m = await env.mirage('cmp -n 10 /data/a.txt /data/b.txt')
      const n = await env.native('cmp -n 10 a.txt b.txt')
      expect(m.length > 0).toBe(n.length > 0)
    } finally {
      await env.cleanup()
    }
  })

  it('cmp -i 2 skip offset', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('XXhello'))
      env.createFile('b.txt', ENC.encode('YYhello'))
      const m = await env.mirage('cmp -i 2 /data/a.txt /data/b.txt')
      const n = await env.native('cmp -i 2 a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('cmp -l lists diffs', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('abc'))
      env.createFile('b.txt', ENC.encode('axc'))
      const result = await env.mirage('cmp -l /data/a.txt /data/b.txt')
      expect(result.trim().length).toBeGreaterThan(0)
    } finally {
      await env.cleanup()
    }
  })

  it('cmp -b includes differ', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('abc'))
      env.createFile('b.txt', ENC.encode('axc'))
      const result = await env.mirage('cmp -b /data/a.txt /data/b.txt')
      expect(result).toContain('differ')
    } finally {
      await env.cleanup()
    }
  })
})
