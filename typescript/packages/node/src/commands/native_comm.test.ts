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

describe.each(NATIVE_BACKENDS)('native comm (%s backend)', (kind) => {
  it('comm default matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('a\nb\nc\n'))
      env.createFile('b.txt', ENC.encode('b\nc\nd\n'))
      const m = await env.mirage('comm /data/a.txt /data/b.txt')
      const n = await env.native('comm a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('comm -1 matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('a\nb\nc\n'))
      env.createFile('b.txt', ENC.encode('b\nc\nd\n'))
      const m = await env.mirage('comm -1 /data/a.txt /data/b.txt')
      const n = await env.native('comm -1 a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('comm -23 matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('a\nb\nc\n'))
      env.createFile('b.txt', ENC.encode('b\nc\nd\n'))
      const m = await env.mirage('comm -23 /data/a.txt /data/b.txt')
      const n = await env.native('comm -23 a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('comm --nocheck-order equals default', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('a\nb\nc\n'))
      env.createFile('b.txt', ENC.encode('b\nc\nd\n'))
      const m1 = await env.mirage('comm --nocheck-order /data/a.txt /data/b.txt')
      const m2 = await env.mirage('comm /data/a.txt /data/b.txt')
      expect(m1).toBe(m2)
    } finally {
      await env.cleanup()
    }
  })

  it('comm -3 matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('a\nb\nc\n'))
      env.createFile('b.txt', ENC.encode('b\nc\nd\n'))
      const m = await env.mirage('comm -3 /data/a.txt /data/b.txt')
      const n = await env.native('comm -3 a.txt b.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('comm --check-order produces output', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('a\nb\nc\n'))
      env.createFile('b.txt', ENC.encode('b\nc\nd\n'))
      const result = await env.mirage('comm --check-order /data/a.txt /data/b.txt')
      expect(result.length).toBeGreaterThan(0)
    } finally {
      await env.cleanup()
    }
  })
})
