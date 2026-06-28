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

describe.each(NATIVE_BACKENDS)('native tar (%s backend)', (kind) => {
  it('tar cz tf', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      env.createFile('b.txt', ENC.encode('bbb\n'))
      await env.mirage('tar -c -z -f /data/out.tar.gz /data/a.txt /data/b.txt')
      const listing = await env.mirage('tar -t -f /data/out.tar.gz')
      const names = listing.trim().split('\n')
      expect(names.join(' ')).toContain('a.txt')
      expect(names.join(' ')).toContain('b.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('tar j create list (bzip2)', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      env.createFile('b.txt', ENC.encode('bbb\n'))
      await env.mirage('tar -c -j -f /data/out.tar.bz2 /data/a.txt /data/b.txt')
      const listing = await env.mirage('tar -t -f /data/out.tar.bz2')
      const names = listing.trim().split('\n')
      expect(names.join(' ')).toContain('a.txt')
      expect(names.join(' ')).toContain('b.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('tar J create list (xz)', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      env.createFile('b.txt', ENC.encode('bbb\n'))
      await env.mirage('tar -c -J -f /data/out.tar.xz /data/a.txt /data/b.txt')
      const listing = await env.mirage('tar -t -f /data/out.tar.xz')
      const names = listing.trim().split('\n')
      expect(names.join(' ')).toContain('a.txt')
      expect(names.join(' ')).toContain('b.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('tar strip-components', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      await env.mirage('tar -c -z -f /data/out.tar.gz /data/a.txt')
      await env.mirage('tar -x -z -f /data/out.tar.gz --strip-components 1 -C /data/extracted')
      const content = await env.mirage('cat /data/extracted/a.txt')
      expect(content).toContain('aaa')
    } finally {
      await env.cleanup()
    }
  })

  it('tar exclude', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      env.createFile('b.txt', ENC.encode('bbb\n'))
      await env.mirage('tar -c -z -f /data/out.tar.gz --exclude b.txt /data/a.txt /data/b.txt')
      const listing = await env.mirage('tar -t -f /data/out.tar.gz')
      const names = listing.trim().split('\n')
      expect(names.join(' ')).not.toContain('b.txt')
      expect(names.join(' ')).toContain('a.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('tar v', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      await env.mirage('tar -c -v -z -f /data/out.tar.gz /data/a.txt')
      const listing = await env.mirage('tar -t -f /data/out.tar.gz')
      expect(listing).toContain('a.txt')
    } finally {
      await env.cleanup()
    }
  })
})
