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

describe.each(NATIVE_BACKENDS)('native iconv (%s backend)', (kind) => {
  it('iconv -c drops invalid chars', async () => {
    const env = makeEnv(kind)
    try {
      const data = new Uint8Array([
        104, 101, 108, 108, 111, 32, 0xff, 32, 119, 111, 114, 108, 100, 10,
      ])
      const result = await env.mirage('iconv -f utf-8 -t ascii -c', data)
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('iconv -o writes to file', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      await env.mirage('iconv -f utf-8 -t ascii -o /data/out.txt /data/f.txt')
      const result = await env.mirage('cat /data/out.txt')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })
})
