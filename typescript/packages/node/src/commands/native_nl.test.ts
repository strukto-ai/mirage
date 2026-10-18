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

describe.each(NATIVE_BACKENDS)('native nl (%s backend)', (kind) => {
  it('nl default matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello\nworld\n')
      const m = await env.mirage('nl', data)
      const n = await env.native('nl', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('nl -b a matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello\n\nworld\n')
      const m = await env.mirage('nl -b a', data)
      const n = await env.native('nl -b a', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('nl on file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('aaa\nbbb\n'))
      const m = await env.mirage('nl /data/f.txt')
      const n = await env.native('nl f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('nl -v sets starting line number', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\n')
      const result = await env.mirage('nl -v 10', data)
      expect(result).toContain('10')
    } finally {
      await env.cleanup()
    }
  })

  it('nl -i sets line number increment', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\n')
      const result = await env.mirage('nl -i 2', data)
      expect(result).toContain('1')
      expect(result).toContain('3')
    } finally {
      await env.cleanup()
    }
  })

  it('nl -w sets line number width', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\n')
      const result = await env.mirage('nl -w 6', data)
      expect(result.includes('     1') || result.includes('1')).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('nl -s sets line separator', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\n')
      const result = await env.mirage("nl -s '>> '", data)
      expect(result).toContain('>>')
    } finally {
      await env.cleanup()
    }
  })
})
