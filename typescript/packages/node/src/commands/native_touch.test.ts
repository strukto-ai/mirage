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

describe.each(NATIVE_BACKENDS)('native touch (%s backend)', (kind) => {
  it('touch -c does not create file', async () => {
    const env = makeEnv(kind)
    try {
      await env.mirage('touch -c /data/nonexistent.txt')
      const result = await env.mirage('find /data -name nonexistent.txt')
      expect(result.trim()).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('touch creates new file (r scenario)', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('ref.txt', ENC.encode('ref'))
      await env.mirage('touch /data/new.txt')
      const result = await env.mirage('ls /data')
      expect(result).toContain('new.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('touch creates dated file', async () => {
    const env = makeEnv(kind)
    try {
      await env.mirage('touch /data/dated.txt')
      const result = await env.mirage('ls /data')
      expect(result).toContain('dated.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('touch -r explicit reference', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('ref.txt', ENC.encode('ref'))
      env.createFile('new.txt', ENC.encode(''))
      await env.mirage('touch -r /data/ref.txt /data/new.txt')
      const result = await env.mirage('ls /data')
      expect(result).toContain('new.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('touch -d explicit date', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('dated.txt', ENC.encode(''))
      await env.mirage("touch -d '2024-01-01' /data/dated.txt")
      const result = await env.mirage('ls /data')
      expect(result).toContain('dated.txt')
    } finally {
      await env.cleanup()
    }
  })
})
