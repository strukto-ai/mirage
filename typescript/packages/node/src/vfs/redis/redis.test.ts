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

import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedisVFS } from './redis.ts'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

describe.skipIf(skip)('RedisVFS', () => {
  it('connects and closes cleanly', async () => {
    const res = new RedisVFS(REDIS_URL !== undefined ? { url: REDIS_URL } : {})
    const client = await res.client()
    expect(client.isOpen).toBe(true)
    await res.close()
    expect(client.isOpen).toBe(false)
  })

  it('ping round-trips via shared client', async () => {
    const res = new RedisVFS(REDIS_URL !== undefined ? { url: REDIS_URL } : {})
    try {
      const c = await res.client()
      const pong = await c.ping()
      expect(pong).toBe('PONG')
    } finally {
      await res.close()
    }
  })

  it('is idempotent on close()', async () => {
    const res = new RedisVFS(REDIS_URL !== undefined ? { url: REDIS_URL } : {})
    await res.close()
    await res.close()
  })
})

function spec(path: string): PathSpec {
  return new PathSpec({ virtual: path, directory: path, vfsPath: path.slice(1), resolved: true })
}

const OOM = new Error("OOM command not allowed when used memory > 'maxmemory'.")
const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const dec = (data: Uint8Array | null): string | null =>
  data === null ? null : new TextDecoder().decode(data)

describe.skipIf(skip)('RedisVFS rename when a write is refused', () => {
  let vfs: RedisVFS

  beforeEach(async () => {
    const prefix = `mirage:fs:rename-test:${Math.random().toString(36).slice(2)}:`
    vfs = new RedisVFS(
      REDIS_URL !== undefined ? { url: REDIS_URL, keyPrefix: prefix } : { keyPrefix: prefix },
    )
    await vfs.store.clear()
    for (const dir of ['/', '/dir', '/dir/sub', '/d']) await vfs.store.addDir(dir)
    await vfs.store.setFile('/a.txt', enc('hi'))
    await vfs.store.setFile('/dir/f', enc('x'))
    await vfs.store.setFile('/dir/sub/deep', enc('z'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await vfs.store.clear()
    await vfs.close()
  })

  // A full Redis refuses SET but still runs DEL, so deleting first lost both names.
  it('keeps a file whose new name could not be written', async () => {
    vi.spyOn(vfs.store, 'setFile').mockRejectedValue(OOM)
    await expect(vfs.rename(spec('/a.txt'), spec('/d/b.txt'))).rejects.toThrow('OOM')
    expect(dec(await vfs.store.getFile('/a.txt'))).toBe('hi')
  })

  it('keeps a directory whose new name could not be written', async () => {
    vi.spyOn(vfs.store, 'addDir').mockRejectedValue(OOM)
    await expect(vfs.rename(spec('/dir'), spec('/d/moved'))).rejects.toThrow('OOM')
    expect(await vfs.store.hasDir('/dir')).toBe(true)
    expect(dec(await vfs.store.getFile('/dir/f'))).toBe('x')
  })

  it('keeps the subtree when a file under it could not be written', async () => {
    vi.spyOn(vfs.store, 'setFile').mockRejectedValue(OOM)
    await expect(vfs.rename(spec('/dir'), spec('/d/moved'))).rejects.toThrow('OOM')
    expect(await vfs.store.hasDir('/dir')).toBe(true)
    expect(await vfs.store.hasDir('/dir/sub')).toBe(true)
    expect(dec(await vfs.store.getFile('/dir/f'))).toBe('x')
    expect(dec(await vfs.store.getFile('/dir/sub/deep'))).toBe('z')
  })

  it.each(['/a.txt', '/dir'])('keeps %s renamed onto itself', async (path) => {
    await vfs.rename(spec(path), spec(path))
    expect(dec(await vfs.store.getFile('/a.txt'))).toBe('hi')
    expect(dec(await vfs.store.getFile('/dir/f'))).toBe('x')
    expect(await vfs.store.hasDir('/dir')).toBe(true)
  })
})
