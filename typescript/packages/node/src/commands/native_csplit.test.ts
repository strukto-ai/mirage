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

describe.each(NATIVE_BACKENDS)('native csplit (%s backend)', (kind) => {
  it('csplit -s suppresses byte counts', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('aaa\n---\nbbb\n'))
      const result = await env.mirage('csplit -s /data/f.txt /---/')
      expect(result.trim()).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('csplit -b format produces two lines', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('aaa\n---\nbbb\n'))
      const result = await env.mirage('csplit -b %03d /data/f.txt /---/')
      const lines = result.trim().split('\n')
      expect(lines.length).toBe(2)
    } finally {
      await env.cleanup()
    }
  })

  it('csplit -k keeps files on error', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('aaa\nbbb\nccc\n'))
      await env.mirage('csplit -k /data/f.txt /bbb/')
      const result = await env.mirage('cat /data/xx00')
      expect(result).toContain('aaa')
    } finally {
      await env.cleanup()
    }
  })

  it('csplit -f prefix', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('aaa\nbbb\nccc\n'))
      await env.mirage('csplit -f part /data/f.txt /bbb/')
      const result = await env.mirage('cat /data/part00')
      expect(result).toContain('aaa')
    } finally {
      await env.cleanup()
    }
  })

  it('csplit -n number of digits', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('aaa\nbbb\nccc\n'))
      await env.mirage('csplit -n 3 /data/f.txt /bbb/')
      const result = await env.mirage('ls /data')
      expect(result).toContain('xx000')
    } finally {
      await env.cleanup()
    }
  })
})
