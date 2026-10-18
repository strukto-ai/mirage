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

describe.each(NATIVE_BACKENDS)('native uniq (%s backend)', (kind) => {
  it('uniq default matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\na\nb\nc\nc\n'))
      const m = await env.mirage('uniq /data/f.txt')
      const n = await env.native('uniq f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('uniq -c matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\na\nb\nc\nc\nc\n'))
      const mOut = await env.mirage('uniq -c /data/f.txt')
      const nOut = await env.native('uniq -c f.txt')
      const mLines = mOut.trim().split('\n')
      const nLines = nOut.trim().split('\n')
      const mPairs = mLines
        .filter((x) => x.trim())
        .map((x) => {
          const parts = x.split(/\s+/).filter((p) => p.length > 0)
          return [parts[0], parts[1]]
        })
      const nPairs = nLines
        .filter((x) => x.trim())
        .map((x) => {
          const parts = x.split(/\s+/).filter((p) => p.length > 0)
          return [parts[0], parts[1]]
        })
      expect(mPairs).toEqual(nPairs)
    } finally {
      await env.cleanup()
    }
  })

  it('uniq -d matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\na\nb\nc\nc\n'))
      const m = await env.mirage('uniq -d /data/f.txt')
      const n = await env.native('uniq -d f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('uniq -u matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\na\nb\nc\nc\n'))
      const m = await env.mirage('uniq -u /data/f.txt')
      const n = await env.native('uniq -u f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('uniq stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\na\nb\n')
      const m = await env.mirage('uniq', data)
      const n = await env.native('uniq', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('uniq -i matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('Hello\nhello\nWorld\n')
      const m = await env.mirage('uniq -i', data)
      const n = await env.native('uniq -i', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('uniq -f matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a 1\nb 1\nc 2\n')
      const m = await env.mirage('uniq -f 1', data)
      const n = await env.native('uniq -f 1', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('uniq -w produces expected output', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('abc\nabd\nxyz\n')
      const m = await env.mirage('uniq -w 2', data)
      expect(m).toBe('abc\nxyz\n')
    } finally {
      await env.cleanup()
    }
  })

  it('uniq -s matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('xxhello\nyyhello\nzzworld\n')
      const m = await env.mirage('uniq -s 2', data)
      const n = await env.native('uniq -s 2', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })
})
