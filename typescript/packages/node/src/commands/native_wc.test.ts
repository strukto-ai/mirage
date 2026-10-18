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

function firstField(s: string): string {
  return s.trim().split(/\s+/)[0] ?? ''
}

describe.each(NATIVE_BACKENDS)('native wc (%s backend)', (kind) => {
  it('wc -l matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\nc\n'))
      const m = firstField(await env.mirage('wc -l /data/f.txt'))
      const n = firstField(await env.native('wc -l f.txt'))
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('wc -w matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\nfoo\n'))
      const m = firstField(await env.mirage('wc -w /data/f.txt'))
      const n = firstField(await env.native('wc -w f.txt'))
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('wc -c matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      const m = firstField(await env.mirage('wc -c /data/f.txt'))
      const n = firstField(await env.native('wc -c f.txt'))
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('wc -l stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\n')
      const m = (await env.mirage('wc -l', data)).trim()
      const n = (await env.native('wc -l', data)).trim()
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('wc default counts match native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\nfoo bar\n'))
      const mParts = (await env.mirage('wc /data/f.txt')).trim().split(/\s+/)
      const nParts = (await env.native('wc f.txt')).trim().split(/\s+/)
      expect(mParts.slice(0, 3)).toEqual(nParts.slice(0, 3))
    } finally {
      await env.cleanup()
    }
  })

  it('wc -L matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('short\na much longer line\nmed\n'))
      const m = firstField(await env.mirage('wc -L /data/f.txt'))
      const n = firstField(await env.native('wc -L f.txt'))
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('wc -L stdin matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('short\na much longer line\nmed\n')
      const m = (await env.mirage('wc -L', data)).trim()
      const n = (await env.native('wc -L', data)).trim()
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('wc -L empty matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode(''))
      const m = firstField(await env.mirage('wc -L /data/f.txt'))
      const n = firstField(await env.native('wc -L f.txt'))
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('wc -L single line matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\n'))
      const m = firstField(await env.mirage('wc -L /data/f.txt'))
      const n = firstField(await env.native('wc -L f.txt'))
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('wc -m matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      const m = firstField(await env.mirage('wc -m /data/f.txt'))
      const n = firstField(await env.native('wc -m f.txt'))
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })
})
