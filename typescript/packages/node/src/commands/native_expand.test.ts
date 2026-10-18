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

describe.each(NATIVE_BACKENDS)('native expand (%s backend)', (kind) => {
  it('expand default matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello\tworld\n')
      const m = await env.mirage('expand', data)
      const n = await env.native('expand', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('expand -t 4 matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello\tworld\n')
      const m = await env.mirage('expand -t 4', data)
      const n = await env.native('expand -t 4', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('expand file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\tb\tc\n'))
      const m = await env.mirage('expand /data/f.txt')
      const n = await env.native('expand f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('expand -i expands only leading tab', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('\thello\tworld\n')
      const result = await env.mirage('expand -i', data)
      expect(result).toBe('        hello\tworld\n')
    } finally {
      await env.cleanup()
    }
  })

  it('expand -i expands multiple leading tabs', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('\t\thello\tworld\n')
      const result = await env.mirage('expand -i', data)
      expect(result).toBe('                hello\tworld\n')
    } finally {
      await env.cleanup()
    }
  })
})
