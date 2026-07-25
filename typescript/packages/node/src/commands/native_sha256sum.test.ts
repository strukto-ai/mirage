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

describe.each(NATIVE_BACKENDS)('native sha256sum (%s backend)', (kind) => {
  it('sha256sum -c verifies checksums', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      const checksums = await env.mirage('sha256sum /data/f.txt')
      env.createFile('sums.txt', ENC.encode(checksums))
      const result = await env.mirage('sha256sum -c /data/sums.txt')
      expect(result).toContain('OK')
    } finally {
      await env.cleanup()
    }
  })

  it('supports tagged and binary NUL-terminated output', async () => {
    const env = makeEnv(kind)
    try {
      expect(await env.mirage('sha256sum --tag', ENC.encode('abc'))).toMatch(/^SHA256 \(-\) = /)
      expect(await env.mirage('sha256sum -b -z', ENC.encode('abc'))).toMatch(/ \*-\0$/)
    } finally {
      await env.cleanup()
    }
  })
})
