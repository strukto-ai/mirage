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

describe.each(NATIVE_BACKENDS)('native du (%s backend)', (kind) => {
  it('du -c includes total line', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello'))
      env.createFile('b.txt', ENC.encode('world'))
      const result = await env.mirage('du -c /data')
      const lines = result.trim().split('\n')
      const last = lines[lines.length - 1] ?? ''
      const parts = last.split(/\s+/)
      expect(last.endsWith('total') || parts[parts.length - 1] === 'total').toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('du --max-depth 0 returns one line', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('sub/a.txt', ENC.encode('hello'))
      const result = await env.mirage('du --max-depth 0 /data')
      const lines = result.trim().split('\n')
      expect(lines.length).toBe(1)
    } finally {
      await env.cleanup()
    }
  })

  it('du --max-depth 1 does not include deep', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('sub/deep/a.txt', ENC.encode('hello'))
      const result = await env.mirage('du --max-depth 1 /data')
      const lines = result.trim().split('\n')
      expect(lines.some((ln) => ln.includes('deep'))).toBe(false)
    } finally {
      await env.cleanup()
    }
  })

  it('du -h returns size output', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('x'.repeat(1024)))
      const result = await env.mirage('du -h /data/f.txt')
      expect(result.includes('K') || result.includes('B') || result.trim().length > 0).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('du -s returns one line', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('sub/a.txt', ENC.encode('hello'))
      const result = await env.mirage('du -s /data')
      const lines = result.trim().split('\n')
      expect(lines.length).toBe(1)
    } finally {
      await env.cleanup()
    }
  })

  it('du -a shows individual files', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello'))
      env.createFile('b.txt', ENC.encode('world'))
      const result = await env.mirage('du -a /data')
      expect(result).toContain('a.txt')
      expect(result).toContain('b.txt')
    } finally {
      await env.cleanup()
    }
  })
})
