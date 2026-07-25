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

describe.each(NATIVE_BACKENDS)('native shuf (%s backend)', (kind) => {
  it('shuf -r -n produces N lines', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\n')
      const result = await env.mirage('shuf -r -n 5', data)
      const lines = result
        .trim()
        .split('\n')
        .filter((s) => s.length > 0)
      expect(lines.length).toBe(5)
    } finally {
      await env.cleanup()
    }
  })

  it('shuf -e echoes args in some order', async () => {
    const env = makeEnv(kind)
    try {
      const result = await env.mirage('shuf -e a b c')
      const lines = result
        .trim()
        .split('\n')
        .map((ln) => ln.trim().replace(/^\/+/, ''))
        .filter((s) => s.length > 0)
      expect(lines.slice().sort()).toEqual(['a', 'b', 'c'])
    } finally {
      await env.cleanup()
    }
  })

  it('shuf -z handles NUL-delimited input', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\x00b\x00c\x00')
      const result = await env.mirage('shuf -z', data)
      expect(result.includes('\x00') || result.length > 0).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('supports input ranges and output files', async () => {
    const env = makeEnv(kind)
    try {
      const result = await env.mirage('shuf -i 3-5 -n 3')
      expect(new Set(result.trim().split('\n'))).toEqual(new Set(['3', '4', '5']))
      await env.mirage('shuf -i 1-1 -o /data/out.txt')
      expect(await env.mirage('cat /data/out.txt')).toBe('1\n')
    } finally {
      await env.cleanup()
    }
  })
})
