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

describe.each(NATIVE_BACKENDS)('native awk (%s backend)', (kind) => {
  it('awk print field matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('alice 30\nbob 25\n')
      const m = await env.mirage("awk '{print $1}'", data)
      const n = await env.native("awk '{print $1}'", data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('awk -F matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a,b,c\n1,2,3\n')
      const m = await env.mirage("awk -F , '{print $2}'", data)
      const n = await env.native("awk -F , '{print $2}'", data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('awk file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('alice 30\nbob 25\n'))
      const m = await env.mirage("awk '{print $2}' /data/f.txt")
      const n = await env.native("awk '{print $2}' f.txt")
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('awk -f program file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('prog.awk', ENC.encode('{print $1}'))
      env.createFile('data.txt', ENC.encode('hello world\nfoo bar\n'))
      const m = await env.mirage('awk -f /data/prog.awk /data/data.txt')
      const n = await env.native('awk -f prog.awk data.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('awk -v matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\n'))
      const m = await env.mirage("awk -v x=hello '{print x}' /data/f.txt")
      const n = await env.native("awk -v x=hello '{print x}' f.txt")
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })
})
