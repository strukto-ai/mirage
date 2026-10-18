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

describe.each(NATIVE_BACKENDS)('native sort (%s backend)', (kind) => {
  it('sort default matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('cherry\napple\nbanana\n'))
      const m = await env.mirage('sort /data/f.txt')
      const n = await env.native('sort f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -r reverse matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\nc\n'))
      const m = await env.mirage('sort -r /data/f.txt')
      const n = await env.native('sort -r f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -n numeric matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('10\n2\n1\n20\n'))
      const m = await env.mirage('sort -n /data/f.txt')
      const n = await env.native('sort -n f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -u unique matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\na\nc\nb\n'))
      const m = await env.mirage('sort -u /data/f.txt')
      const n = await env.native('sort -u f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -nr matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('10\n2\n1\n20\n'))
      const m = await env.mirage('sort -nr /data/f.txt')
      const n = await env.native('sort -nr f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -t -k -n matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('b,3\na,1\nc,2\n'))
      const m = await env.mirage('sort -t , -k 2 -n /data/f.txt')
      const n = await env.native('sort -t , -k 2 -n f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('cherry\napple\nbanana\n')
      const m = await env.mirage('sort', data)
      const n = await env.native('sort', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -h human numeric matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('10K\n1M\n5G\n100\n2K\n'))
      const m = await env.mirage('sort -h /data/f.txt')
      const n = await env.native('sort -h f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -hr matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('10K\n1M\n5G\n100\n2K\n'))
      const m = await env.mirage('sort -hr /data/f.txt')
      const n = await env.native('sort -hr f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -h stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('1G\n500M\n2T\n100K\n')
      const m = await env.mirage('sort -h', data)
      const n = await env.native('sort -h', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -V version matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('v1.10\nv1.2\nv1.1\nv2.0\n'))
      const m = await env.mirage('sort -V /data/f.txt')
      const n = await env.native('sort -V f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -Vr matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('v1.10\nv1.2\nv1.1\nv2.0\n'))
      const m = await env.mirage('sort -Vr /data/f.txt')
      const n = await env.native('sort -Vr f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -V stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('lib-2.1\nlib-1.10\nlib-1.2\nlib-3.0\n')
      const m = await env.mirage('sort -V', data)
      const n = await env.native('sort -V', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -s stable matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('b 2\na 1\nc 1\na 2\n'))
      const m = await env.mirage("sort -s -k 2 -t ' ' /data/f.txt")
      const n = await env.native("sort -s -k 2 -t ' ' f.txt")
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -s stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('b 2\na 1\nc 1\na 2\n')
      const m = await env.mirage("sort -s -k 2 -t ' '", data)
      const n = await env.native("sort -s -k 2 -t ' '", data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sort -f fold case includes all items', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('B\na\nC\nb\n'))
      const result = await env.mirage('sort -f /data/f.txt')
      expect(result).toContain('a')
      expect(result).toContain('B')
    } finally {
      await env.cleanup()
    }
  })
})
