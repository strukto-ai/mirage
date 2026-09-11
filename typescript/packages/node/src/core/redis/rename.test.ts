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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RedisAccessor } from '@struktoai/mirage-core/accessor/redis'
import { RedisStore } from '../../resource/redis/store.ts'
import { rename } from '@struktoai/mirage-core/core/redis/rename'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

function spec(path: string): PathSpec {
  return PathSpec.fromStrPath(path)
}

async function codeOf(fn: () => Promise<void>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE'
  }
  return 'NO_THROW'
}

describe.skipIf(skip)('core/redis rename', () => {
  let store: RedisStore
  let acc: RedisAccessor

  beforeEach(async () => {
    store = new RedisStore(
      REDIS_URL !== undefined
        ? { url: REDIS_URL, keyPrefix: 'test:rename:' }
        : { keyPrefix: 'test:rename:' },
    )
    await store.clear()
    const enc = new TextEncoder()
    await store.addDir('/')
    await store.addDir('/dir')
    await store.addDir('/d')
    await store.setFile('/a.txt', enc.encode('hi'))
    await store.setFile('/plain', enc.encode('y'))
    await store.setFile('/dir/f', enc.encode('x'))
    acc = new RedisAccessor(store)
  })

  afterEach(async () => {
    await store.clear()
    await store.close()
  })

  it('moves a file', async () => {
    await rename(acc, spec('/a.txt'), spec('/d/b.txt'))
    expect(await store.hasFile('/d/b.txt')).toBe(true)
    expect(await store.hasFile('/a.txt')).toBe(false)
  })

  it('moves a directory with its children', async () => {
    await rename(acc, spec('/dir'), spec('/d/moved'))
    expect(await store.hasDir('/d/moved')).toBe(true)
    expect(await store.hasFile('/d/moved/f')).toBe(true)
    expect(await store.hasFile('/dir/f')).toBe(false)
  })

  it('a missing source is ENOENT', async () => {
    expect(await codeOf(() => rename(acc, spec('/nope'), spec('/d/x')))).toBe('ENOENT')
  })

  it('a file into a missing parent is ENOENT and leaves no orphan', async () => {
    expect(await codeOf(() => rename(acc, spec('/a.txt'), spec('/missing/a.txt')))).toBe('ENOENT')
    expect(await store.hasFile('/a.txt')).toBe(true)
    expect(await store.hasFile('/missing/a.txt')).toBe(false)
  })

  it('a directory into a missing parent is ENOENT and leaves no orphan', async () => {
    expect(await codeOf(() => rename(acc, spec('/dir'), spec('/missing/dir')))).toBe('ENOENT')
    expect(await store.hasDir('/dir')).toBe(true)
    expect(await store.hasFile('/dir/f')).toBe(true)
    expect(await store.hasDir('/missing/dir')).toBe(false)
  })

  it('a missing grandparent is ENOENT', async () => {
    expect(await codeOf(() => rename(acc, spec('/a.txt'), spec('/missing/sub/a.txt')))).toBe(
      'ENOENT',
    )
    expect(await store.hasFile('/a.txt')).toBe(true)
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    expect(await codeOf(() => rename(acc, spec('/a.txt'), spec('/plain/c.txt')))).toBe('ENOTDIR')
    expect(await store.hasFile('/a.txt')).toBe(true)
    expect(await store.hasFile('/plain/c.txt')).toBe(false)
  })

  it('a plain file deeper in the parent chain is ENOTDIR', async () => {
    expect(await codeOf(() => rename(acc, spec('/a.txt'), spec('/plain/sub/c.txt')))).toBe(
      'ENOTDIR',
    )
    expect(await store.hasFile('/a.txt')).toBe(true)
  })

  // rename(2) resolves the destination path first: a bad destination parent
  // outranks a missing source (ENOTDIR, not ENOENT).
  it('resolves the destination before the source', async () => {
    expect(await codeOf(() => rename(acc, spec('/nope'), spec('/plain/x')))).toBe('ENOTDIR')
  })

  it('a root child is allowed', async () => {
    await rename(acc, spec('/a.txt'), spec('/b.txt'))
    expect(await store.hasFile('/b.txt')).toBe(true)
  })
})
