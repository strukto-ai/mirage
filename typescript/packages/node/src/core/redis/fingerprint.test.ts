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

import { RedisAccessor } from '@struktoai/mirage-core/accessor/redis'
import { tree } from '@struktoai/mirage-core/core/redis/readdir'
import { stat } from '@struktoai/mirage-core/core/redis/stat'
import { write } from '@struktoai/mirage-core/core/redis/write'
import { type FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { ManualClock, runWithSystemClock } from '@struktoai/mirage-core/utils/clock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RedisStore } from '../../vfs/redis/store.ts'

const REDIS_URL = process.env.REDIS_URL
const ENC = new TextEncoder()

async function rewritten(acc: RedisAccessor): Promise<[FileStat, FileStat, FileStat | undefined]> {
  const at = PathSpec.fromStrPath('/f')
  await write(acc, at, ENC.encode('one'))
  const first = await stat(acc, at)
  await write(acc, at, ENC.encode('two'))
  const second = await stat(acc, at)
  const rows = await tree(acc, PathSpec.fromStrPath('/'))
  return [first, second, rows?.get('f')]
}

describe.skipIf(REDIS_URL === undefined)('a Redis fingerprint', () => {
  let store: RedisStore
  const prefix = `mirage:fs:test:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`
  beforeEach(async () => {
    store = new RedisStore({ url: REDIS_URL ?? '', keyPrefix: prefix })
    await store.clear()
    await store.addDir('/')
  })
  afterEach(async () => {
    await store.clear()
    await store.close()
  })

  it('moves on a same-size rewrite on a clock that stands still', async () => {
    const [first, second, listed] = await runWithSystemClock(new ManualClock(1_800_000_000), () =>
      rewritten(new RedisAccessor(store)),
    )
    expect(first.fingerprint).not.toBe(second.fingerprint)
    expect(listed?.fingerprint).toBe(second.fingerprint)
  })
})
