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
const DEC = new TextDecoder()

// A .tar.bz2 holding a.txt and b.txt, written by GNU-compatible tar rather
// than by mirage: bzip2 is decompress-only here, so the read path has no
// writer of its own to round-trip against.
const BZIP2_FIXTURE = Uint8Array.from(
  atob(
    'QlpoOTFBWSZTWb5cDKYAAIl7gMmQABBAAXWAAAhwAB5ACCggAHQShE0aA0eoNqBVJAAAaA+6YFC2QJVR' +
      'EIU4zaLiTBWsQhIczkjNuTLKIYCgg4wgxJypYcoUGGDPpbubQsplyCC5BU0EQPxdyRThQkL5cDKY',
  ),
  (c) => c.charCodeAt(0),
)

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

  it('tar j lists an archive another tar wrote (bzip2)', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('out.tar.bz2', BZIP2_FIXTURE)
      const listing = await env.mirage('tar -t -f /data/out.tar.bz2')
      const names = listing.trim().split('\n')
      expect(names.join(' ')).toContain('a.txt')
      expect(names.join(' ')).toContain('b.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('tar xJ round-trips file bodies through the xz codec', async () => {
    // Listing only proves the headers survived; extracting proves the
    // decompressed bodies are byte-exact.
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      env.createFile('b.txt', ENC.encode('bbb\n'))
      await env.mirage('tar -c -J -f /data/out.tar.xz /data/a.txt /data/b.txt')
      await env.mirage('tar -x -J -f /data/out.tar.xz -C /data/ex')
      expect(await env.mirage('cat /data/ex/data/a.txt')).toBe('aaa\n')
      expect(await env.mirage('cat /data/ex/data/b.txt')).toBe('bbb\n')
    } finally {
      await env.cleanup()
    }
  })

  it('tar xj extracts an archive another tar wrote (bzip2)', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('out.tar.bz2', BZIP2_FIXTURE)
      await env.mirage('tar -x -j -f /data/out.tar.bz2 -C /data/ex')
      expect(await env.mirage('cat /data/ex/a.txt')).toBe('aaa\n')
      expect(await env.mirage('cat /data/ex/b.txt')).toBe('bbb\n')
    } finally {
      await env.cleanup()
    }
  })

  it('tar cj refuses to create, since bzip2 is decompress-only', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      env.ws.cwd = '/data'
      const io = await env.ws.execute('tar -c -j -f /data/out.tar.bz2 /data/a.txt')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe('tar: bzip2 not supported\n')
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

describe.each(NATIVE_BACKENDS)('native tar old option style (%s backend)', (kind) => {
  it('tar czf / tzf / xzf', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      await env.mirage('tar czf /data/out.tar.gz /data/a.txt')
      expect(await env.mirage('tar tzf /data/out.tar.gz')).toContain('a.txt')
      await env.mirage('tar xzf /data/out.tar.gz -C /data/ex')
      expect(await env.mirage('cat /data/ex/data/a.txt')).toContain('aaa')
    } finally {
      await env.cleanup()
    }
  })

  it('tar cfz still compresses', async () => {
    // GNU: `tar cfz a.tgz f` gzips, so -f takes the archive and z stays a
    // flag; listing it back with -z proves the stream is gzip.
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      await env.mirage('tar cfz /data/out.tar.gz /data/a.txt')
      expect(await env.mirage('tar tzf /data/out.tar.gz')).toContain('a.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('tar xzCf binds C then f', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      await env.mirage('tar czf /data/out.tar.gz /data/a.txt')
      await env.mirage('tar xzCf /data/ex /data/out.tar.gz')
      expect(await env.mirage('cat /data/ex/data/a.txt')).toContain('aaa')
    } finally {
      await env.cleanup()
    }
  })

  it('tar cvzf lists members', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('a.txt', ENC.encode('aaa\n'))
      expect(await env.mirage('tar cvzf /data/out.tar.gz /data/a.txt')).toContain('a.txt')
    } finally {
      await env.cleanup()
    }
  })
})
