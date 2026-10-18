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

describe.each(NATIVE_BACKENDS)('native patch (%s backend)', (kind) => {
  it('patch -N applies forward patch', async () => {
    if (kind === 'disk') return
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\nworld\n'))
      const patchContent =
        '--- a/f.txt\n' +
        '+++ b/f.txt\n' +
        '@@ -1,2 +1,2 @@\n' +
        '-hello\n' +
        '+goodbye\n' +
        ' world\n'
      env.createFile('fix.patch', ENC.encode(patchContent))
      await env.mirage('patch -N -p1 -i /data/fix.patch')
      const result = await env.mirage('cat /data/f.txt')
      expect(result).toContain('goodbye')
    } finally {
      await env.cleanup()
    }
  })

  it('patch -R reverses patch', async () => {
    if (kind === 'disk') return
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('goodbye\nworld\n'))
      const patchContent =
        '--- a/f.txt\n' +
        '+++ b/f.txt\n' +
        '@@ -1,2 +1,2 @@\n' +
        '-hello\n' +
        '+goodbye\n' +
        ' world\n'
      env.createFile('fix.patch', ENC.encode(patchContent))
      await env.mirage('patch -R -p1 -i /data/fix.patch')
      const result = await env.mirage('cat /data/f.txt')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })
})
