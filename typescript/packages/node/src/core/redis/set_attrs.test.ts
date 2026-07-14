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

import { PathSpec } from '@struktoai/mirage-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RedisAccessor } from '../../accessor/redis.ts'
import { RedisStore } from '../../resource/redis/store.ts'
import { rename } from './rename.ts'
import { setAttrs } from './set_attrs.ts'
import { stat } from './stat.ts'
import { unlink } from './unlink.ts'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

function spec(path: string): PathSpec {
  return PathSpec.fromStrPath(path)
}

describe.skipIf(skip)('core/redis setAttrs', () => {
  let store: RedisStore
  let acc: RedisAccessor

  beforeEach(async () => {
    store = new RedisStore(
      REDIS_URL !== undefined
        ? { url: REDIS_URL, keyPrefix: 'test:setattr:' }
        : { keyPrefix: 'test:setattr:' },
    )
    await store.clear()
    await store.addDir('/')
    await store.setFile('/f.txt', new TextEncoder().encode('hello'))
    acc = new RedisAccessor(store)
  })

  afterEach(async () => {
    await store.clear()
    await store.close()
  })

  it('fields are reported by stat', async () => {
    await setAttrs(acc, spec('/f.txt'), {
      mode: 0o601,
      uid: 500,
      gid: 'dev',
      atime: '2026-01-02T00:00:00+00:00',
    })
    const s = await stat(acc, spec('/f.txt'))
    expect(s.mode).toBe(0o601)
    expect(s.uid).toBe(500)
    expect(s.gid).toBe('dev')
    expect(s.atime).toBe('2026-01-02T00:00:00+00:00')
  })

  it('mtime updates modified', async () => {
    await setAttrs(acc, spec('/f.txt'), { mtime: '2026-03-04T12:00:00+00:00' })
    const s = await stat(acc, spec('/f.txt'))
    expect(s.modified).toBe('2026-03-04T12:00:00+00:00')
  })

  it('throws for a missing path', async () => {
    await expect(setAttrs(acc, spec('/nope.txt'), { mode: 0o644 })).rejects.toThrow()
  })

  it('unlink drops attrs', async () => {
    await setAttrs(acc, spec('/f.txt'), { mode: 0o600 })
    await unlink(acc, spec('/f.txt'))
    await store.setFile('/f.txt', new TextEncoder().encode('recreated'))
    const s = await stat(acc, spec('/f.txt'))
    expect(s.mode).toBeNull()
  })

  it('rename carries attrs', async () => {
    await setAttrs(acc, spec('/f.txt'), { mode: 0o600, uid: 500 })
    await rename(acc, spec('/f.txt'), spec('/g.txt'))
    const s = await stat(acc, spec('/g.txt'))
    expect(s.mode).toBe(0o600)
    expect(s.uid).toBe(500)
    expect(await store.getAttrs('/f.txt')).toEqual({})
  })
})
