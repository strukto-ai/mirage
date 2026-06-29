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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { RAMFileCacheStore } from '../cache/file/ram.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser } from '../shell/parse.ts'
import { MountMode, PathSpec } from '../types.ts'
import { Workspace } from './workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

describe('default mount cache dedup', () => {
  it('cache hit does not double-store', async () => {
    const ram = new RAMResource()
    await ram.writeFile(PathSpec.fromStrPath('/big.bin'), new Uint8Array(4096))
    const ws = new Workspace(
      { '/r': ram },
      {
        mode: MountMode.WRITE,
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    const cache = ws.cache as RAMFileCacheStore
    try {
      await ws.execute('cat /r/big.bin > /dev/null')
      const sizeFirst = cache.cacheSize
      const keysFirst = cache
        .snapshotEntries()
        .map((e) => e.key)
        .sort()

      await ws.execute('cat /r/big.bin > /dev/null')
      const sizeSecond = cache.cacheSize
      const keysSecond = cache
        .snapshotEntries()
        .map((e) => e.key)
        .sort()

      expect(sizeSecond).toBe(sizeFirst)
      expect(keysSecond).toEqual(keysFirst)
      expect(keysSecond.every((k) => k.startsWith('/r/'))).toBe(true)
    } finally {
      await ws.close()
    }
  })
})
