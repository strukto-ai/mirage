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

describe.each(NATIVE_BACKENDS)('native cut (%s backend)', (kind) => {
  it('cut -f -d matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a:b:c\nd:e:f\n'))
      const m = await env.mirage('cut -f 1 -d : /data/f.txt')
      const n = await env.native('cut -f 1 -d : f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('cut -f with tab default matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\tb\tc\n'))
      const m = await env.mirage('cut -f 2 /data/f.txt')
      const n = await env.native('cut -f 2 f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('cut -c character range matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\n'))
      const m = await env.mirage('cut -c 1-5 /data/f.txt')
      const n = await env.native('cut -c 1-5 f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('cut stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a,b,c\nd,e,f\n')
      const m = await env.mirage('cut -f 1 -d ,', data)
      const n = await env.native('cut -f 1 -d ,', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('cut --complement removes selected field', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a:b:c:d\n')
      const result = await env.mirage('cut -d: -f2 --complement', data)
      expect(result).toBe('a:c:d\n')
    } finally {
      await env.cleanup()
    }
  })

  it('cut -z null delimiter', async () => {
    const env = makeEnv(kind)
    try {
      const data = new Uint8Array([0x61, 0x3a, 0x62, 0x00, 0x63, 0x3a, 0x64, 0x00])
      const result = await env.mirage('cut -d: -f1 -z', data)
      expect(result).toBe('a\x00c\x00')
    } finally {
      await env.cleanup()
    }
  })
})
