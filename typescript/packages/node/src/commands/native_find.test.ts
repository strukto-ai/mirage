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

describe.each(NATIVE_BACKENDS)('native find (%s backend)', (kind) => {
  it('find -iname matches case-insensitively', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('Hello.txt', ENC.encode('hi'))
      const result = await env.mirage('find /data -iname hello.txt')
      expect(result).toContain('Hello.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('find -mindepth 2 excludes top-level files', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('a'))
      env.createFile('sub/b.txt', ENC.encode('b'))
      const resultAll = await env.mirage('find /data -type f')
      const resultDeep = await env.mirage('find /data -mindepth 2 -type f')
      expect(resultAll).toContain('a.txt')
      expect(resultDeep).not.toContain('/data/a.txt')
      expect(resultDeep).toContain('b.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('find -path filters by path pattern', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('sub/hello.txt', ENC.encode('hi'))
      env.createFile('other/hello.txt', ENC.encode('hi'))
      const result = await env.mirage("find /data -path '*/sub/*'")
      expect(result).toContain('sub')
      expect(result).not.toContain('other')
    } finally {
      await env.cleanup()
    }
  })

  it('find -name filters by name', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('hello.txt', ENC.encode('hi'))
      env.createFile('world.txt', ENC.encode('hi'))
      const result = await env.mirage('find /data -name hello.txt')
      expect(result).toContain('hello.txt')
      expect(result).not.toContain('world.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('find -maxdepth 1 excludes deeper files', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hi'))
      env.createFile('sub/deep/c.txt', ENC.encode('hi'))
      const result = await env.mirage('find /data -maxdepth 1 -type f')
      expect(result).toContain('a.txt')
      expect(result).not.toContain('c.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('find -size filters by size', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('big.txt', ENC.encode('x'.repeat(1000)))
      env.createFile('small.txt', ENC.encode('x'))
      const result = await env.mirage('find /data -size +500c -type f')
      expect(result).toContain('big.txt')
      expect(result).not.toContain('small.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('find -mtime -1 includes recently-created files', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello'))
      const result = await env.mirage('find /data -mtime -1 -type f')
      expect(result).toContain('f.txt')
    } finally {
      await env.cleanup()
    }
  })
})
