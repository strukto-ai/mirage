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

describe.each(NATIVE_BACKENDS)('native diff (%s backend)', (kind) => {
  it('diff identical matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('same\n'))
      env.createFile('b.txt', ENC.encode('same\n'))
      const m = await env.mirage('diff /data/a.txt /data/b.txt')
      const n = await env.native('diff a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('diff different agreement on content', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello\n'))
      env.createFile('b.txt', ENC.encode('world\n'))
      const m = await env.mirage('diff /data/a.txt /data/b.txt')
      const n = await env.native('diff a.txt b.txt')
      expect(m.includes('hello')).toBe(n.includes('hello'))
      expect(m.includes('world')).toBe(n.includes('world'))
    } finally {
      await env.cleanup()
    }
  })

  it('diff -i case insensitive matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('Hello\n'))
      env.createFile('b.txt', ENC.encode('hello\n'))
      const m = await env.mirage('diff -i /data/a.txt /data/b.txt')
      const n = await env.native('diff -i a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('diff default is normal format (1c1 / < / ---)', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello\n'))
      env.createFile('b.txt', ENC.encode('world\n'))
      const out = await env.mirage('diff /data/a.txt /data/b.txt')
      expect(out).toContain('< hello')
      expect(out).toContain('> world')
      expect(out).toContain('---')
    } finally {
      await env.cleanup()
    }
  })

  it('diff -u emits unified format', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello\n'))
      env.createFile('b.txt', ENC.encode('world\n'))
      const out = await env.mirage('diff -u /data/a.txt /data/b.txt')
      expect(out).toContain('--- /data/a.txt')
      expect(out).toContain('+++ /data/b.txt')
      expect(out).toContain('-hello')
      expect(out).toContain('+world')
    } finally {
      await env.cleanup()
    }
  })

  it('diff -q differ', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello\n'))
      env.createFile('b.txt', ENC.encode('world\n'))
      const result = await env.mirage('diff -q /data/a.txt /data/b.txt')
      expect(result).toContain('differ')
    } finally {
      await env.cleanup()
    }
  })

  it('diff -q same empty', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello\n'))
      env.createFile('b.txt', ENC.encode('hello\n'))
      const result = await env.mirage('diff -q /data/a.txt /data/b.txt')
      expect(result.trim()).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('diff -w ignores whitespace', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello  world\n'))
      env.createFile('b.txt', ENC.encode('helloworld\n'))
      const result = await env.mirage('diff -w /data/a.txt /data/b.txt')
      expect(result.trim()).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('diff -b ignores whitespace amount', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello  world\n'))
      env.createFile('b.txt', ENC.encode('hello world\n'))
      const result = await env.mirage('diff -b /data/a.txt /data/b.txt')
      expect(result.trim()).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('diff -e ed script', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello\n'))
      env.createFile('b.txt', ENC.encode('world\n'))
      const result = await env.mirage('diff -e /data/a.txt /data/b.txt')
      const passes = result.includes('c') || result.includes('d') || result.includes('a')
      expect(passes).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('diff -r recursive', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('dir1/a.txt', ENC.encode('hello\n'))
      env.createFile('dir2/a.txt', ENC.encode('world\n'))
      const result = await env.mirage('diff -r /data/dir1 /data/dir2')
      const passes =
        result.includes('differ') || result.includes('hello') || result.includes('world')
      expect(passes).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('diff -r recurses into subdirectories', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('d1/top.txt', ENC.encode('same\n'))
      env.createFile('d2/top.txt', ENC.encode('same\n'))
      env.createFile('d1/sub/x.txt', ENC.encode('alpha\n'))
      env.createFile('d2/sub/x.txt', ENC.encode('beta\n'))
      const result = await env.mirage('diff -r /data/d1 /data/d2')
      expect(result).toContain('alpha')
      expect(result).toContain('beta')
      expect(result).toContain('/data/d1/sub/x.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('diff -r reports entries only in one directory', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('o1/shared.txt', ENC.encode('s\n'))
      env.createFile('o2/shared.txt', ENC.encode('s\n'))
      env.createFile('o1/leftonly.txt', ENC.encode('l\n'))
      env.createFile('o2/rightonly.txt', ENC.encode('r\n'))
      const result = await env.mirage('diff -r /data/o1 /data/o2')
      expect(result).toContain('Only in /data/o1: leftonly.txt')
      expect(result).toContain('Only in /data/o2: rightonly.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('diff -r on two files diffs them like a plain diff', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f1.txt', ENC.encode('hello\n'))
      env.createFile('f2.txt', ENC.encode('world\n'))
      const result = await env.mirage('diff -r /data/f1.txt /data/f2.txt')
      expect(result).toContain('hello')
      expect(result).toContain('world')
      expect(result).not.toContain('Not a directory')
    } finally {
      await env.cleanup()
    }
  })

  it('diff -r on identical trees produces no output', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('s1/a.txt', ENC.encode('x\n'))
      env.createFile('s1/sub/b.txt', ENC.encode('y\n'))
      env.createFile('s2/a.txt', ENC.encode('x\n'))
      env.createFile('s2/sub/b.txt', ENC.encode('y\n'))
      const result = await env.mirage('diff -r /data/s1 /data/s2')
      expect(result).toBe('')
    } finally {
      await env.cleanup()
    }
  })
})
