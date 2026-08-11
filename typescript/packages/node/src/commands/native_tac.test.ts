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

import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { makeEnv, NATIVE_BACKENDS } from './native_fixture.ts'

const ENC = new TextEncoder()
// tac is GNU coreutils (macOS ships `tail -r`); the fixture captures only
// native stdout, so a missing tac would silently compare against "".
const hasTac = spawnSync('/bin/sh', ['-c', 'command -v tac'], { stdio: 'ignore' }).status === 0

describe.each(NATIVE_BACKENDS)('native tac (%s backend)', (kind) => {
  it.skipIf(!hasTac)('tac stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\n')
      const m = await env.mirage('tac', data)
      const n = await env.native('tac', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it.skipIf(!hasTac)('tac file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('1\n2\n3\n'))
      const m = await env.mirage('tac /data/f.txt')
      const n = await env.native('tac f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })
})
