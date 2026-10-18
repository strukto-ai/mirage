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

describe.each(NATIVE_BACKENDS)('native cp (%s backend)', (kind) => {
  it('cp basic copies content', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('src.txt', ENC.encode('hello'))
      await env.mirage('cp /data/src.txt /data/dst.txt')
      expect(await env.mirage('cat /data/dst.txt')).toBe('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('cp -a copies directory', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('src/a.txt', ENC.encode('aaa'))
      await env.mirage('cp -a /data/src/ /data/dst/')
      expect(await env.mirage('cat /data/dst/a.txt')).toBe('aaa')
    } finally {
      await env.cleanup()
    }
  })

  it('cp -n does not overwrite', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('src.txt', ENC.encode('new'))
      env.createFile('dst.txt', ENC.encode('old'))
      await env.mirage('cp -n /data/src.txt /data/dst.txt')
      expect(await env.mirage('cat /data/dst.txt')).toBe('old')
    } finally {
      await env.cleanup()
    }
  })

  it('cp -v verbose output', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('src.txt', ENC.encode('hello'))
      const result = await env.mirage('cp -v /data/src.txt /data/dst.txt')
      expect(result).toContain('src.txt')
      expect(result).toContain('->')
      expect(result).toContain('dst.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('cp -f overwrites', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('src.txt', ENC.encode('hello'))
      env.createFile('dst.txt', ENC.encode('old'))
      await env.mirage('cp -f /data/src.txt /data/dst.txt')
      expect(await env.mirage('cat /data/dst.txt')).toBe('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('cp -r recursive copy', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('src/a.txt', ENC.encode('hello'))
      await env.mirage('cp -r /data/src /data/dst')
      const result = await env.mirage('cat /data/dst/a.txt')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('cp -R recursive copy', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('src/a.txt', ENC.encode('hello'))
      await env.mirage('cp -R /data/src /data/dst2')
      const result = await env.mirage('cat /data/dst2/a.txt')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })
})
