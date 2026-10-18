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

describe.each(NATIVE_BACKENDS)('native xxd (%s backend)', (kind) => {
  it('xxd -u uppercase hex', async () => {
    const env = makeEnv(kind)
    try {
      const data = new Uint8Array([0xab, 0xcd])
      const result = await env.mirage('xxd -u', data)
      expect(result.includes('AB') || result.includes('CD')).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('xxd -r reverse hex', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello')
      const hexOut = await env.mirage('xxd -p', data)
      const restored = await env.mirage('xxd -r -p', ENC.encode(hexOut))
      expect(restored).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('xxd -p plain hex', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('AB')
      const result = await env.mirage('xxd -p', data)
      expect(result.toLowerCase()).toContain('4142')
    } finally {
      await env.cleanup()
    }
  })

  it('xxd -l limits length', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello world')
      const result = await env.mirage('xxd -l 5', data)
      expect(result).not.toContain('worl')
    } finally {
      await env.cleanup()
    }
  })

  it('xxd -g group size', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('ABCD')
      const result = await env.mirage('xxd -g 4', data)
      expect(result.trim().length).toBeGreaterThan(0)
    } finally {
      await env.cleanup()
    }
  })

  it('xxd -c columns', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello world')
      const result = await env.mirage('xxd -c 4', data)
      const lines = result.trim().split('\n')
      expect(lines.length).toBeGreaterThanOrEqual(2)
    } finally {
      await env.cleanup()
    }
  })

  it('xxd -s seek offset', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello world')
      const result = await env.mirage('xxd -s 5', data)
      expect(result.toLowerCase()).not.toContain('6865')
    } finally {
      await env.cleanup()
    }
  })
})
