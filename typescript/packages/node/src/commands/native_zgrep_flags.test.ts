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

import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { makeEnv, NATIVE_BACKENDS } from './native_fixture.ts'

const ENC = new TextEncoder()

describe.each(NATIVE_BACKENDS)('native zgrep flags (%s backend)', (kind) => {
  it('zgrep -w whole word', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nhelloworld\nhello there\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -w hello /data/f.txt.gz')
      expect(result).not.toContain('helloworld')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -i case insensitive', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('Hello\nworld\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -i hello /data/f.txt.gz')
      expect(result).toContain('Hello')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -c count', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nworld\nhello\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -c hello /data/f.txt.gz')
      expect(result).toContain('2')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -v invert match', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nworld\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -v hello /data/f.txt.gz')
      expect(result).toContain('world')
      expect(result).not.toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -n line numbers', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nworld\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -n hello /data/f.txt.gz')
      expect(result.includes('1:') || result.includes('1\t')).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -l list filenames', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nworld\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -l hello /data/f.txt.gz')
      expect(result).toContain('f.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -e pattern from stdin', async () => {
    const env = makeEnv(kind)
    try {
      const compressed = new Uint8Array(gzipSync(Buffer.from('hello\nworld\n')))
      const result = await env.mirage('zgrep -e hello', compressed)
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -E extended regex', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('foo\nbar\nbaz\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage("zgrep -E 'foo|bar' /data/f.txt.gz")
      expect(result).toContain('foo')
      expect(result).toContain('bar')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -F fixed string', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a.b\na*b\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage("zgrep -F 'a.b' /data/f.txt.gz")
      expect(result).toContain('a.b')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -o only matching', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -o hello /data/f.txt.gz')
      expect(result.trim()).toBe('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -m max count', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\na\na\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -m 1 a /data/f.txt.gz')
      const count = (result.trim().match(/a/g) ?? []).length
      expect(count).toBe(1)
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -q quiet', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -q hello /data/f.txt.gz')
      expect(result.trim()).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -H with filename', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -H hello /data/f.txt.gz')
      expect(result).toContain('f.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -h no filename', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage('zgrep -h hello /data/f.txt.gz')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  // zgrep is grep over decompressed bytes, so + is an ordinary character.
  it('zgrep reads a basic expression', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('aab\na+b\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage("zgrep 'a+b' /data/f.txt.gz")
      expect(result).toContain('a+b')
      expect(result).not.toContain('aab')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -E reads an extended expression', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('aab\na+b\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage("zgrep -E 'a+b' /data/f.txt.gz")
      expect(result).toContain('aab')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep -G asks for the default dialect', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('aab\na+b\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage("zgrep -G 'a+b' /data/f.txt.gz")
      expect(result).toContain('a+b')
      expect(result).not.toContain('aab')
    } finally {
      await env.cleanup()
    }
  })

  it('zgrep backslash-plus is the basic operator', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('aab\na+b\n'))
      await env.mirage('gzip /data/f.txt')
      const result = await env.mirage("zgrep 'a\\+b' /data/f.txt.gz")
      expect(result).toContain('aab')
    } finally {
      await env.cleanup()
    }
  })
})
