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

import { expect, it } from 'vitest'
import { RedisAccessor } from '../../accessor/redis.ts'
import { FileType, PathSpec } from '../../types.ts'
import type { RedisStoreLike } from '../../vfs/redis/store.ts'
import { stat } from './stat.ts'

// A gate each of `parties` callers waits at until all of them are there.
function together(parties: number): () => Promise<void> {
  let waiting = 0
  let release: () => void = () => undefined
  const all = new Promise<void>((resolve) => {
    release = resolve
  })
  return async () => {
    waiting += 1
    if (waiting === parties) release()
    await all
  }
}

// Twin of test_stat_asks_what_is_at_a_path_in_one_round_trip: whether a
// directory or a file is at the path, and the fields kept under its name, are
// three lookups. Each waits here until all three are out, so a stat that asked
// them one after another, each waiting for the one before, would never finish.
// The store answers only those three; core has no Redis client of its own.
it('asks what is at a path in one round trip', async () => {
  const gate = together(3)
  const store = {
    hasDir: async (): Promise<boolean> => {
      await gate()
      return false
    },
    hasFile: async (): Promise<boolean> => {
      await gate()
      return true
    },
    statMany: async (): Promise<[Record<string, string>, number | null, string | null][]> => {
      await gate()
      return [[{}, 11, null]]
    },
  } as unknown as RedisStoreLike
  const result = await stat(new RedisAccessor(store), PathSpec.fromStrPath('/hello.txt'))
  expect(result.type).toBe(FileType.FILE)
  expect(result.size).toBe(11)
}, 2000)
