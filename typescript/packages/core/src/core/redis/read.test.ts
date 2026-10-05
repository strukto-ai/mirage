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
import { RedisAccessor } from '../../accessor/redis.ts'
import { PathSpec } from '../../types.ts'
import type { RedisStoreLike } from '../../vfs/redis/store.ts'
import { read } from './read.ts'
import { readStream } from './stream.ts'

// A miss is all these paths need: the store holds no file at either key, and
// only the directory set tells EISDIR from ENOENT. The ops that read a file
// run against a live server in node/src/core/redis/core.test.ts.
function mkAccessor(): RedisAccessor {
  const dirs = new Set(['/', '/sub'])
  return new RedisAccessor({
    getFile: () => Promise.resolve(null),
    getFileRange: () => Promise.resolve(null),
    hasFile: () => Promise.resolve(false),
    hasDir: (path: string) => Promise.resolve(dirs.has(path)),
  } as unknown as RedisStoreLike)
}

async function drain(source: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _ of source) void _
}

describe('reading a directory (redis)', () => {
  it.each([
    ['/sub', 'EISDIR'],
    ['/nope', 'ENOENT'],
  ])('read and readStream answer %s with %s', async (key, code) => {
    const accessor = mkAccessor()
    const path = PathSpec.fromStrPath(key)
    await expect(read(accessor, path)).rejects.toMatchObject({ code })
    await expect(read(accessor, path, undefined, { offset: 1, size: 2 })).rejects.toMatchObject({
      code,
    })
    await expect(drain(readStream(accessor, path))).rejects.toMatchObject({ code })
  })
})
