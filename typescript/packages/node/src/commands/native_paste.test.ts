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

describe.each(NATIVE_BACKENDS)('native paste (%s backend)', (kind) => {
  it('paste two files matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('1\n2\n3\n'))
      env.createFile('b.txt', ENC.encode('a\nb\nc\n'))
      const m = await env.mirage('paste /data/a.txt /data/b.txt')
      const n = await env.native('paste a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('paste -d uses custom delimiter', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('x\ny\n'))
      env.createFile('b.txt', ENC.encode('1\n2\n'))
      const m = await env.mirage('paste -d , /data/a.txt /data/b.txt')
      const n = await env.native('paste -d , a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('paste -s serial mode from stdin', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\n')
      const m = await env.mirage('paste -s', data)
      expect(m).toBe('a\tb\tc\n')
    } finally {
      await env.cleanup()
    }
  })

  it('cycles custom delimiters in serial mode', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\nc\n'))
      expect(await env.mirage('paste -s -d, /data/f.txt')).toBe('a,b,c\n')
    } finally {
      await env.cleanup()
    }
  })
})
