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

describe.each(NATIVE_BACKENDS)('native tree (%s backend)', (kind) => {
  it('tree -d shows only directories', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('sub/a.txt', ENC.encode('hi'))
      const result = await env.mirage('tree -d /data')
      expect(result).not.toContain('a.txt')
      expect(result).toContain('sub')
    } finally {
      await env.cleanup()
    }
  })

  it('tree -a shows hidden files', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('.hidden', ENC.encode('secret'))
      env.createFile('visible.txt', ENC.encode('hi'))
      const result = await env.mirage('tree -a /data')
      expect(result).toContain('.hidden')
    } finally {
      await env.cleanup()
    }
  })

  it('tree -L limits depth', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('sub/deep/a.txt', ENC.encode('hi'))
      const result = await env.mirage('tree -L 1 /data')
      expect(result).toContain('sub')
      expect(result).not.toContain('a.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('tree -P filters by pattern', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('hello.txt', ENC.encode('hi'))
      env.createFile('world.txt', ENC.encode('hi'))
      const result = await env.mirage('tree -P hello* /data')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('tree -I ignores pattern', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('keep.txt', ENC.encode('hi'))
      env.createFile('skip.log', ENC.encode('hi'))
      const result = await env.mirage("tree -I '*.log' /data")
      expect(result).toContain('keep.txt')
      expect(result).not.toContain('skip.log')
    } finally {
      await env.cleanup()
    }
  })
})
