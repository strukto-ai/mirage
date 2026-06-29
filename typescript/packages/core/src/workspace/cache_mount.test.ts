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
import { cachesReads } from '../resource/base.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser } from '../shell/parse.ts'
import { ConsistencyPolicy, MountMode, PathSpec } from '../types.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

describe('cache is a hidden store, not a mount', () => {
  it('is decoupled from the root mount', async () => {
    // The file cache is reached via `registry.fileCache`, not the root mount's
    // resource. When no `/` is mounted the root is an ordinary empty RAM mount
    // at `/` (a normal entry in allMounts) and never holds the cache.
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    try {
      expect(ws.registry.fileCache).toBe(ws.cache)
      const root = ws.registry.rootMount
      expect(root).not.toBeNull()
      expect(root?.resource).not.toBe(ws.cache)
      expect(cachesReads(root?.resource ?? new RAMResource())).toBe(false)
      expect(root?.prefix).toBe('/')
      expect(ws.registry.allMounts()).toContain(root)
    } finally {
      await ws.close()
    }
  })

  it('reuses a user-provided / mount as the root anchor (no synthetic root)', async () => {
    const userRoot = new RAMResource()
    const ws = new Workspace({ '/': userRoot }, { mode: MountMode.WRITE })
    try {
      expect(ws.registry.rootMount?.resource).toBe(userRoot)
      expect(ws.registry.fileCache).toBe(ws.cache)
    } finally {
      await ws.close()
    }
  })
})

describe('warm read serves from the hidden store, command stays on its mount', () => {
  it('serves a cached operand under LAZY after out-of-band mutation', async () => {
    const ram = new RAMResource()
    // Force the cache on a local backend so the read is cached and, under LAZY,
    // never revalidated. A subsequent out-of-band mutation must NOT be seen:
    // the warm read serves the cached bytes from the hidden store while the
    // command stays on its real mount.
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ws = new Workspace(
      { '/r': ram },
      {
        mode: MountMode.WRITE,
        consistency: ConsistencyPolicy.LAZY,
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
      const first = DEC.decode((await ws.execute('cat /r/a.txt')).stdout)
      expect(first).toContain('v1')
      await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v2\n'))
      const second = DEC.decode((await ws.execute('cat /r/a.txt')).stdout)
      expect(second).toContain('v1')
      expect(second).not.toContain('v2')
    } finally {
      await ws.close()
    }
  })
})
