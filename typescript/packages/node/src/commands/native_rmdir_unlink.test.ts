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

describe.each(NATIVE_BACKENDS)('native rmdir/unlink (%s backend)', (kind) => {
  it('rmdir removes an empty directory', async () => {
    const env = makeEnv(kind)
    try {
      await env.mirage('mkdir /data/d')
      expect((await env.mirage('ls /data')).split(/\s+/)).toContain('d')
      const out = await env.mirage('rmdir /data/d')
      expect(out).toBe('')
      expect((await env.mirage('ls /data')).split(/\s+/)).not.toContain('d')
    } finally {
      await env.cleanup()
    }
  })

  it('rmdir -v is verbose', async () => {
    const env = makeEnv(kind)
    try {
      await env.mirage('mkdir /data/dv')
      const out = await env.mirage('rmdir -v /data/dv')
      expect(out).toBe("rmdir: removing directory, '/data/dv'\n")
    } finally {
      await env.cleanup()
    }
  })

  it('unlink removes a file', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('bytes\n'))
      expect((await env.mirage('ls /data')).split(/\s+/)).toContain('f.txt')
      const out = await env.mirage('unlink /data/f.txt')
      expect(out).toBe('')
      expect((await env.mirage('ls /data')).split(/\s+/)).not.toContain('f.txt')
    } finally {
      await env.cleanup()
    }
  })
})
