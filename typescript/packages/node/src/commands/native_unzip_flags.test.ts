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

describe.each(NATIVE_BACKENDS)('native unzip flags (%s backend)', (kind) => {
  it('unzip -q quiet', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello'))
      await env.mirage('zip /data/out.zip /data/a.txt')
      const result = await env.mirage('unzip -q -d /data/ext /data/out.zip')
      expect(result.trim() === '' || !result.includes('inflating')).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('unzip -t test archive', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello'))
      await env.mirage('zip /data/out.zip /data/a.txt')
      const result = await env.mirage('unzip -t /data/out.zip')
      const ok =
        result.includes('OK') || result.toLowerCase().includes('ok') || result.includes('No errors')
      expect(ok).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('unzip -l list archive', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello'))
      await env.mirage('zip /data/out.zip /data/a.txt')
      const result = await env.mirage('unzip -l /data/out.zip')
      expect(result).toContain('a.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('unzip -p pipe to stdout', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello'))
      await env.mirage('zip /data/out.zip /data/a.txt')
      const result = await env.mirage('unzip -p /data/out.zip')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('unzip -o overwrite', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello'))
      await env.mirage('zip /data/out.zip /data/a.txt')
      await env.mirage('unzip -o /data/out.zip')
      const result = await env.mirage('ls /data')
      expect(result).toContain('a.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('unzip -p with a member outputs only that member', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello\n'))
      env.createFile('b.txt', ENC.encode('world\n'))
      await env.mirage('zip /data/out.zip /data/a.txt /data/b.txt')
      const result = await env.mirage('unzip -p /data/out.zip data/a.txt')
      expect(result).toBe('hello\n')
    } finally {
      await env.cleanup()
    }
  })

  it('unzip -p with a missing member exits 11 with a caution', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello\n'))
      await env.mirage('zip /data/out.zip /data/a.txt')
      env.ws.cwd = '/data'
      const io = await env.ws.execute('unzip -p /data/out.zip NOSUCHFILE.xml')
      expect(io.exitCode).toBe(11)
      expect(new TextDecoder().decode(io.stdout)).toBe('')
      expect(new TextDecoder().decode(io.stderr)).toBe(
        'caution: filename not matched:  NOSUCHFILE.xml\n',
      )
    } finally {
      await env.cleanup()
    }
  })

  it('unzip extraction writes only the selected member', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('hello\n'))
      env.createFile('b.txt', ENC.encode('world\n'))
      await env.mirage('zip /data/out.zip /data/a.txt /data/b.txt')
      await env.mirage('unzip -q /data/out.zip data/a.txt -d /data/ext')
      const listing = await env.mirage('ls /data/ext/data')
      expect(listing).toContain('a.txt')
      expect(listing).not.toContain('b.txt')
    } finally {
      await env.cleanup()
    }
  })
})
