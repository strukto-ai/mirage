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

describe.each(NATIVE_BACKENDS)('native rm (%s backend)', (kind) => {
  it('rm -d removes empty directory', async () => {
    const env = makeEnv(kind)
    try {
      await env.mirage('mkdir /data/emptydir')
      await env.mirage('rm -d /data/emptydir')
      const result = await env.mirage('ls /data/')
      expect(result).not.toContain('emptydir')
    } finally {
      await env.cleanup()
    }
  })

  it('rm -r removes recursively', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('sub/a.txt', ENC.encode('hello'))
      await env.mirage('rm -r /data/sub')
      const result = await env.mirage('find /data -name a.txt')
      expect(result.trim()).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('rm -f on nonexistent file produces no output', async () => {
    const env = makeEnv(kind)
    try {
      const result = await env.mirage('rm -f /data/nonexistent.txt')
      expect(result.trim()).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('rm -R removes recursively', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('sub/a.txt', ENC.encode('hi'))
      await env.mirage('rm -R /data/sub')
      const result = await env.mirage('find /data -name a.txt')
      expect(result.trim()).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('rm -v verbose prints filename', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello'))
      const result = await env.mirage('rm -v /data/f.txt')
      expect(result).toContain('f.txt')
    } finally {
      await env.cleanup()
    }
  })
})
