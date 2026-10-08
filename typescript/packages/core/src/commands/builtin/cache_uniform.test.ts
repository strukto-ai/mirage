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
import { createShellParser } from '../../shell/parse/index.ts'
import { MountMode, type PathSpec } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

describe('a warm read command reads nothing from the backend', () => {
  // Every read command reads at the door, which serves the warm entry
  // whatever reader the command binds.
  it.each([
    'cat /c/a.txt',
    'head -n 1 /c/a.txt',
    'tail -n 1 /c/a.txt',
    'wc -l /c/a.txt',
    'grep alpha /c/a.txt',
    'rg alpha /c/a.txt',
  ])('%s', async (line) => {
    const ram = new RAMVFS()
    Object.assign(ram, { cachesReads: true })
    const ws = new Workspace(
      { '/c': ram },
      {
        mode: MountMode.WRITE,
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      await ws.shell("printf 'alpha\\nbeta\\n' > /c/a.txt")
      await ws.shell('cat /c/a.txt')
      const reads: string[] = []
      const read = ram.read.bind(ram)
      const readStream = ram.readStream.bind(ram)
      Object.assign(ram, {
        read: (path: PathSpec, ...rest: [IndexCacheStore?, number?, (number | null)?]) => {
          reads.push(path.virtual)
          return read(path, ...rest)
        },
        readStream: (path: PathSpec, index?: IndexCacheStore) => {
          reads.push(path.virtual)
          return readStream(path, index)
        },
      })
      const out = await ws.shell(line)
      expect(out.stdout.byteLength).toBeGreaterThan(0)
      expect(out.exitCode).toBe(0)
      expect(reads).toEqual([])
    } finally {
      await ws.close()
    }
  })
})
