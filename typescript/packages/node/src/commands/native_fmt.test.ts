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
// mirage follows GNU fmt; macOS ships BSD fmt's greedy fill. Mirrors
// test_fmt.py.
const fmtVersion = spawnSync('fmt', ['--version'], { encoding: 'utf8' })
const notGnuFmt = fmtVersion.error !== undefined || !fmtVersion.stdout.includes('GNU')

describe.each(NATIVE_BACKENDS)('native fmt (%s backend)', (kind) => {
  it.skipIf(notGnuFmt)('fmt -w 20 matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('this is a long line that should be wrapped\n')
      const m = await env.mirage('fmt -w 20', data)
      const n = await env.native('fmt -w 20', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it.skipIf(notGnuFmt)('fmt -w 15 file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('short words in a line\n'))
      const m = await env.mirage('fmt -w 15 /data/f.txt')
      const n = await env.native('fmt -w 15 f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })
})
