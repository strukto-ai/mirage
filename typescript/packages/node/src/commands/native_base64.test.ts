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

describe.each(NATIVE_BACKENDS)('native base64 (%s backend)', (kind) => {
  it('base64 encode matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello world\n')
      const m = await env.mirage('base64', data)
      const n = await env.native('base64', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('base64 -d decode matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('aGVsbG8gd29ybGQK\n')
      const m = await env.mirage('base64 -d', data)
      const n = await env.native('base64 -d', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('base64 file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\n'))
      const m = await env.mirage('base64 /data/f.txt')
      const n = await env.native('base64 < f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('base64 -w line wrapping', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello world this is a longer string for wrapping')
      const result = await env.mirage('base64 -w 20', data)
      const lines = result.trim().split('\n')
      for (const line of lines.slice(0, -1)) {
        expect(line.length).toBeLessThanOrEqual(20)
      }
    } finally {
      await env.cleanup()
    }
  })

  it('base64 -D decodes', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('aGVsbG8=\n')
      const result = await env.mirage('base64 -D', data)
      expect(result).toBe('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('supports wrapping and ignore-garbage aliases', async () => {
    const env = makeEnv(kind)
    try {
      expect(await env.mirage('base64 -w 4', ENC.encode('abcdef'))).toBe('YWJj\nZGVm\n')
      expect(await env.mirage('base64 --decode --ignore-garbage', ENC.encode('YWJj$\n'))).toBe(
        'abc',
      )
    } finally {
      await env.cleanup()
    }
  })
})
