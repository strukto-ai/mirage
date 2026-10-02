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
import { settling } from '../../cache/_test_util.ts'
import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { RedisStoreLike } from '../../vfs/redis/store.ts'
import { writeBytes } from './write.ts'

function mkPath(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: stripSlash(virtual), resolved: true })
}

// writeBytes asks which keys are files and directories, then stores the
// bytes and the mtime; a map stands in for the server.
function mkStore(files: Map<string, Uint8Array>): RedisStoreLike {
  const dirs = new Set(['/', '/d'])
  return {
    hasFile: (path: string) => Promise.resolve(files.has(path)),
    hasDir: (path: string) => Promise.resolve(dirs.has(path)),
    setFile: (path: string, data: Uint8Array) => {
      files.set(path, data)
      return Promise.resolve()
    },
    setModified: () => Promise.resolve(),
  } as unknown as RedisStoreLike
}

describe('core/redis writeBytes settles', () => {
  it('settles its bytes without a receipt', async () => {
    const files = new Map<string, Uint8Array>()
    const manager = await settling(() =>
      writeBytes(
        new RedisAccessor(mkStore(files)),
        mkPath('/d/f.txt'),
        new TextEncoder().encode('hi'),
      ),
    )
    expect([...files.keys()]).toEqual(['/d/f.txt'])
    expect(manager.settled).toEqual([
      { path: '/d/f.txt', data: 'hi', receipt: null, generation: 5 },
    ])
    expect(manager.writes).toEqual([])
  })
})
