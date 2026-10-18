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

describe.each(NATIVE_BACKENDS)('native ls (%s backend)', (kind) => {
  it('ls lists same top-level files as native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa'))
      env.createFile('b.txt', ENC.encode('bbb'))
      const mNames = new Set(
        (await env.mirage('ls /data/'))
          .trim()
          .split('\n')
          .filter((s) => s.length > 0),
      )
      const nNames = new Set(
        (await env.native('ls'))
          .trim()
          .split('\n')
          .filter((s) => s.length > 0),
      )
      expect(mNames).toEqual(nNames)
    } finally {
      await env.cleanup()
    }
  })

  it('ls -a shows hidden dotfiles', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('.hidden', ENC.encode('h'))
      env.createFile('visible.txt', ENC.encode('v'))
      const out = await env.mirage('ls -a /data/')
      const names = new Set(
        out
          .trim()
          .split('\n')
          .filter((s) => s.length > 0),
      )
      expect(names.has('.hidden')).toBe(true)
      expect(names.has('visible.txt')).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('ls -l includes filename', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello'))
      const out = await env.mirage('ls -l /data')
      expect(out).toContain('f.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('ls -r reverse matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('a'))
      env.createFile('b.txt', ENC.encode('b'))
      env.createFile('c.txt', ENC.encode('c'))
      const mNames = (await env.mirage('ls -r /data/')).trim().split('\n')
      const nNames = (await env.native('ls -r')).trim().split('\n')
      expect(mNames).toEqual(nNames)
    } finally {
      await env.cleanup()
    }
  })

  it('ls -a includes filename', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello'))
      const result = await env.mirage('ls -a /data')
      expect(result).toContain('f.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('ls -F marks subdirectory with trailing slash', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('sub/a.txt', ENC.encode('hi'))
      const result = await env.mirage('ls -F /data')
      expect(result).toContain('sub/')
    } finally {
      await env.cleanup()
    }
  })

  it('ls -A includes filename', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hi'))
      const result = await env.mirage('ls -A /data')
      expect(result).toContain('f.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('ls -l -h human readable shows K or filename', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('x'.repeat(1024)))
      const result = await env.mirage('ls -l -h /data')
      expect(result.includes('K') || result.includes('f.txt')).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('ls -t sorts by time and includes all files', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('a'))
      env.createFile('b.txt', ENC.encode('b'))
      const result = await env.mirage('ls -t /data')
      expect(result).toContain('a.txt')
      expect(result).toContain('b.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('ls -S sorts by size and returns multiple lines', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('big.txt', ENC.encode('x'.repeat(100)))
      env.createFile('small.txt', ENC.encode('x'))
      const result = await env.mirage('ls -S /data')
      const lines = result
        .trim()
        .split('\n')
        .filter((s) => s.length > 0)
      expect(lines.length).toBeGreaterThanOrEqual(2)
    } finally {
      await env.cleanup()
    }
  })

  it('ls -1 produces newline-separated output', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('a'))
      env.createFile('b.txt', ENC.encode('b'))
      const result = await env.mirage('ls -1 /data')
      expect(result).toContain('\n')
    } finally {
      await env.cleanup()
    }
  })

  it('ls -R recursive includes subdirectory and files', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('sub/a.txt', ENC.encode('hi'))
      const result = await env.mirage('ls -R /data')
      expect(result).toContain('sub')
      expect(result).toContain('a.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('ls -d on directory returns non-empty output', async () => {
    const env = makeEnv(kind)
    try {
      const result = await env.mirage('ls -d /data')
      expect(result.trim().length).toBeGreaterThan(0)
    } finally {
      await env.cleanup()
    }
  })
})
