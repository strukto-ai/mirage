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
import { CROSS_MOUNT_PAIRS, makeCrossEnv } from './native_fixture.ts'

const ENC = new TextEncoder()

describe.each(CROSS_MOUNT_PAIRS)('native cross mount (%s -> %s)', (p1, p2) => {
  it('cp cross', async () => {
    const env = makeCrossEnv([p1, p2])
    try {
      env.createFile(1, 'f.txt', ENC.encode('hello\n'))
      await env.run('cp /m1/f.txt /m2/copy.txt')
      expect(await env.run('cat /m2/copy.txt')).toBe('hello\n')
    } finally {
      await env.cleanup()
    }
  })

  it('mv cross', async () => {
    const env = makeCrossEnv([p1, p2])
    try {
      env.createFile(1, 'f.txt', ENC.encode('hello\n'))
      await env.run('mv /m1/f.txt /m2/moved.txt')
      expect(await env.run('cat /m2/moved.txt')).toBe('hello\n')
      expect(await env.exit('cat /m1/f.txt')).not.toBe(0)
    } finally {
      await env.cleanup()
    }
  })

  it('diff cross', async () => {
    const env = makeCrossEnv([p1, p2])
    try {
      env.createFile(1, 'a.txt', ENC.encode('hello\n'))
      env.createFile(2, 'b.txt', ENC.encode('world\n'))
      const result = await env.run('diff /m1/a.txt /m2/b.txt')
      expect(result.includes('hello') || result.includes('world')).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  it('diff identical cross', async () => {
    const env = makeCrossEnv([p1, p2])
    try {
      env.createFile(1, 'a.txt', ENC.encode('same\n'))
      await env.run('cp /m1/a.txt /m2/b.txt')
      expect(await env.run('diff /m1/a.txt /m2/b.txt')).toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('cat multi cross', async () => {
    const env = makeCrossEnv([p1, p2])
    try {
      env.createFile(1, 'a.txt', ENC.encode('aaa\n'))
      env.createFile(2, 'b.txt', ENC.encode('bbb\n'))
      expect(await env.run('cat /m1/a.txt /m2/b.txt')).toBe('aaa\nbbb\n')
    } finally {
      await env.cleanup()
    }
  })

  it('head cross', async () => {
    const env = makeCrossEnv([p1, p2])
    try {
      env.createFile(1, 'a.txt', ENC.encode('aaa\n'))
      env.createFile(2, 'b.txt', ENC.encode('bbb\n'))
      const result = await env.run('head -n 1 /m1/a.txt /m2/b.txt')
      expect(result).toContain('==> /m1/a.txt <==')
      expect(result).toContain('==> /m2/b.txt <==')
    } finally {
      await env.cleanup()
    }
  })

  it('grep cross', async () => {
    const env = makeCrossEnv([p1, p2])
    try {
      env.createFile(1, 'a.txt', ENC.encode('hello world\n'))
      env.createFile(2, 'b.txt', ENC.encode('foo bar\n'))
      const result = await env.run('grep hello /m1/a.txt /m2/b.txt')
      expect(result).toContain('/m1/a.txt:')
    } finally {
      await env.cleanup()
    }
  })

  it('wc cross', async () => {
    const env = makeCrossEnv([p1, p2])
    try {
      env.createFile(1, 'a.txt', ENC.encode('one\ntwo\n'))
      env.createFile(2, 'b.txt', ENC.encode('three\n'))
      const result = await env.run('wc -l /m1/a.txt /m2/b.txt')
      expect(result).toContain('/m1/a.txt')
      expect(result).toContain('/m2/b.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('redirect cross', async () => {
    const env = makeCrossEnv([p1, p2])
    try {
      env.createFile(1, 'f.txt', ENC.encode('hello\n'))
      await env.run('cat /m1/f.txt > /m2/out.txt')
      expect(await env.run('cat /m2/out.txt')).toBe('hello\n')
    } finally {
      await env.cleanup()
    }
  })

  it('pipe cross', async () => {
    const env = makeCrossEnv([p1, p2])
    try {
      env.createFile(1, 'f.txt', ENC.encode('hello\nworld\n'))
      const result = await env.run('cat /m1/f.txt | grep hello')
      expect(result).toContain('hello')
    } finally {
      await env.cleanup()
    }
  })

  it('md5 fans out across mounts', async () => {
    const env = makeCrossEnv([p1, p2])
    try {
      env.createFile(1, 'a.txt', ENC.encode('hello\n'))
      env.createFile(2, 'b.txt', ENC.encode('world\n'))
      const single = (await env.run('md5 /m1/a.txt')) + (await env.run('md5 /m2/b.txt'))
      expect(await env.run('md5 /m1/a.txt /m2/b.txt')).toBe(single)
    } finally {
      await env.cleanup()
    }
  })

  it('du fans out across mounts', async () => {
    const env = makeCrossEnv([p1, p2])
    try {
      env.createFile(1, 'a.txt', ENC.encode('hello\n'))
      env.createFile(2, 'b.txt', ENC.encode('world!!\n'))
      const out = await env.run('du -c /m1/a.txt /m2/b.txt')
      expect(out).toContain('6\t/m1/a.txt')
      expect(out).toContain('8\t/m2/b.txt')
      expect(out).toContain('14\ttotal')
    } finally {
      await env.cleanup()
    }
  })

  it('file fans out across mounts', async () => {
    const env = makeCrossEnv([p1, p2])
    try {
      env.createFile(1, 'a.txt', ENC.encode('hello\n'))
      env.createFile(2, 'b.txt', ENC.encode('world\n'))
      const out = await env.run('file /m1/a.txt /m2/b.txt')
      expect(out).toContain('/m1/a.txt:')
      expect(out).toContain('/m2/b.txt:')
    } finally {
      await env.cleanup()
    }
  })
})
