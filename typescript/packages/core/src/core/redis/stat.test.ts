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

// Twin of test_stat_asks_what_is_at_a_path_in_one_pipeline: whether a
// directory or a file is at the path, and the fields kept under its name, are
// asked of the store in one call, which each store sends as one pipeline (the
// node store's own test runs that against a live server); a lookup asked on
// its own would fail here. Core has no Redis client of its own.
it.each([
  ['/hello.txt', false, true, FileType.FILE, 11],
  ['/sub', true, false, FileType.DIRECTORY, null],
] as const)('asks what is at %s in one call', async (virtual, isDir, isFile, kind, size) => {
  const asked: string[] = []
  const alone = (): never => {
    throw new Error('a lookup went out on its own')
  }
  const store = {
    hasDir: alone,
    hasFile: alone,
    statMany: alone,
    statAt: (path: string) => {
      asked.push(path)
      return Promise.resolve([isDir, isFile, {}, 11, null])
    },
  } as unknown as RedisStoreLike
  const result = await stat(new RedisAccessor(store), PathSpec.fromStrPath(virtual))
  expect([result.type, result.size]).toEqual([kind, size])
  expect(asked).toEqual([virtual])
})
