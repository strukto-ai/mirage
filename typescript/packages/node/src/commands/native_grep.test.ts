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

describe.each(NATIVE_BACKENDS)('native grep (%s backend)', (kind) => {
  it('grep basic matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\nfoo bar\nhello again\n'))
      const m = await env.mirage('grep hello /data/f.txt')
      const n = await env.native('grep hello f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -i (case insensitive) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('Hello\nworld\nHELLO\n'))
      const m = await env.mirage('grep -i hello /data/f.txt')
      const n = await env.native('grep -i hello f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -v (invert match) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nworld\nfoo\n'))
      const m = await env.mirage('grep -v hello /data/f.txt')
      const n = await env.native('grep -v hello f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -n (line numbers) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nworld\nhello\n'))
      const m = await env.mirage('grep -n hello /data/f.txt')
      const n = await env.native('grep -n hello f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -c (count) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nworld\nhello\n'))
      const m = await env.mirage('grep -c hello /data/f.txt')
      const n = await env.native('grep -c hello f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -w (word) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nhelloworld\nhello there\n'))
      const m = await env.mirage('grep -w hello /data/f.txt')
      const n = await env.native('grep -w hello f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -F (fixed string) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a.b\na*b\naXb\n'))
      const m = await env.mirage("grep -F 'a.b' /data/f.txt")
      const n = await env.native("grep -F 'a.b' f.txt")
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -o (only matching) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\nfoo hello\n'))
      const m = await env.mirage('grep -o hello /data/f.txt')
      const n = await env.native('grep -o hello f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -m (max count) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\na\na\na\n'))
      const m = await env.mirage('grep -m 2 a /data/f.txt')
      const n = await env.native('grep -m 2 a f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -iv (combined) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('Hello\nworld\nHELLO\nfoo\n'))
      const m = await env.mirage('grep -iv hello /data/f.txt')
      const n = await env.native('grep -iv hello f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -nw (combined) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nhelloworld\nhello there\n'))
      const m = await env.mirage('grep -nw hello /data/f.txt')
      const n = await env.native('grep -nw hello f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -Fc (combined) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a.b\na.b\naXb\n'))
      const m = await env.mirage("grep -Fc 'a.b' /data/f.txt")
      const n = await env.native("grep -Fc 'a.b' f.txt")
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep no match matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nworld\n'))
      const m = await env.mirage('grep zzz /data/f.txt')
      const n = await env.native('grep zzz f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello world\nfoo bar\nhello again\n')
      const m = await env.mirage('grep hello', data)
      const n = await env.native('grep hello', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep stdin -i matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('Hello\nworld\nHELLO\n')
      const m = await env.mirage('grep -i hello', data)
      const n = await env.native('grep -i hello', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep stdin -c matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\na\n')
      const m = await env.mirage('grep -c a', data)
      const n = await env.native('grep -c a', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -A (after context) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\nc\nd\ne\n'))
      const m = await env.mirage('grep -A 1 c /data/f.txt')
      const n = await env.native('grep -A 1 c f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -B (before context) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\nc\nd\ne\n'))
      const m = await env.mirage('grep -B 1 c /data/f.txt')
      const n = await env.native('grep -B 1 c f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -C (context) matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\nc\nd\ne\n'))
      const m = await env.mirage('grep -C 1 c /data/f.txt')
      const n = await env.native('grep -C 1 c f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -A multiple matches matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('x\na\nb\nc\na\nd\ne\n'))
      const m = await env.mirage('grep -A 1 a /data/f.txt')
      const n = await env.native('grep -A 1 a f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -B multiple matches matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('x\ny\na\nb\nc\na\n'))
      const m = await env.mirage('grep -B 1 a /data/f.txt')
      const n = await env.native('grep -B 1 a f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -C multiple matches matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('w\nx\na\ny\nz\na\nb\n'))
      const m = await env.mirage('grep -C 1 a /data/f.txt')
      const n = await env.native('grep -C 1 a f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -A overlapping matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\na\nc\nd\n'))
      const m = await env.mirage('grep -A 2 a /data/f.txt')
      const n = await env.native('grep -A 2 a f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -e stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello\nworld\nfoo\n')
      const m = await env.mirage('grep -e hello', data)
      const n = await env.native('grep -e hello', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -n -A combined matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\nc\nd\ne\n'))
      const m = await env.mirage('grep -n -A 1 c /data/f.txt')
      const n = await env.native('grep -n -A 1 c f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -C -i combined matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('aaa\nbbb\nAAA\nccc\n'))
      const m = await env.mirage('grep -C 1 -i aaa /data/f.txt')
      const n = await env.native('grep -C 1 -i aaa f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -A stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\nd\ne\n')
      const m = await env.mirage('grep -A 1 c', data)
      const n = await env.native('grep -A 1 c', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -C stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\nd\ne\n')
      const m = await env.mirage('grep -C 1 c', data)
      const n = await env.native('grep -C 1 c', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -r lists file', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nworld\n'))
      const result = await env.mirage('grep -r -l hello /data')
      expect(result).toContain('f.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('grep -l lists file', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello\n'))
      const result = await env.mirage('grep -r -l hello /data')
      expect(result).toContain('a.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('grep -E extended regex matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('foo\nbar\nbaz\n')
      const m = await env.mirage("grep -E 'foo|bar'", data)
      const n = await env.native("grep -E 'foo|bar'", data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('grep -q quiet produces no output', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      const result = await env.mirage('grep -q hello /data/f.txt')
      expect(result).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('grep -R recursive returns matching line', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      const result = await env.mirage('grep -R hello /data')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('grep -H with filename returns match', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      const result = await env.mirage('grep -H hello /data/f.txt')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('grep -r -h suppresses filename', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      const result = await env.mirage('grep -r -h hello /data')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })
})
