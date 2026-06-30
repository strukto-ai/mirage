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

// Mirror of python/tests/workspace/test_cache_invalidation.py. The Python
// suite uses moto S3 (a caching backend); TS core has no S3 in unit tests, so
// it forces a RAM mount to cache reads, which exercises the same write-site
// invalidation hooks (a mutation invalidates the file cache and the parent
// listing before the next command in the pipeline runs).

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser } from '../shell/parse.ts'
import { MountMode } from '../types.ts'
import { Workspace } from './workspace.ts'

const DEC = new TextDecoder()
const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

function cachingWorkspace(): Workspace {
  const ram = new RAMResource()
  // Force the cache on so reads are cached and write-site invalidation matters,
  // mirroring an S3-style caching backend (local RAM does not cache by default).
  ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
  return new Workspace(
    { '/data': ram },
    {
      mode: MountMode.WRITE,
      shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
    },
  )
}

async function exec(ws: Workspace, cmd: string): Promise<{ code: number; out: string }> {
  const res = await ws.execute(cmd)
  return { code: res.exitCode, out: DEC.decode(res.stdout) }
}

describe('cache invalidation at the write site', () => {
  it('gzip roundtrip with an interleaved ls sees the recreated file', async () => {
    const ws = cachingWorkspace()
    try {
      const { code, out } = await exec(
        ws,
        'mkdir -p /data/arch' +
          ' && echo two | tee /data/arch/h.txt > /dev/null' +
          ' && gzip /data/arch/h.txt' +
          ' && ls /data/arch' +
          ' && gunzip /data/arch/h.txt.gz' +
          ' && cat /data/arch/h.txt',
      )
      expect(code).toBe(0)
      expect(out).toContain('two')
    } finally {
      await ws.close()
    }
  })

  it('ls sees a file created after a prior listing cached the directory', async () => {
    const ws = cachingWorkspace()
    try {
      const setup = await exec(
        ws,
        'mkdir -p /data/arch && echo one | tee /data/arch/a.txt > /dev/null && ls /data/arch',
      )
      expect(setup.code).toBe(0)
      const { code, out } = await exec(
        ws,
        'echo two | tee /data/arch/b.txt > /dev/null && ls /data/arch',
      )
      expect(code).toBe(0)
      expect(out).toContain('b.txt')
    } finally {
      await ws.close()
    }
  })

  it('ls does not show a file removed after it was listed', async () => {
    const ws = cachingWorkspace()
    try {
      const setup = await exec(
        ws,
        'mkdir -p /data/arch && echo gone | tee /data/arch/c.txt > /dev/null && ls /data/arch',
      )
      expect(setup.code).toBe(0)
      const rm = await exec(ws, 'rm /data/arch/c.txt')
      expect(rm.code).toBe(0)
      const { code, out } = await exec(ws, 'ls /data/arch')
      expect(code).toBe(0)
      expect(out).not.toContain('c.txt')
    } finally {
      await ws.close()
    }
  })

  // Mirrors python/tests/integration/test_cache_write_through.py: a cat warms
  // the file cache, rm evicts that cached entry (not just the listing), so a
  // re-cat fails instead of serving the stale cached bytes.
  it('rm after cat evicts the file cache so a re-read fails', async () => {
    const ws = cachingWorkspace()
    try {
      const setup = await exec(
        ws,
        'mkdir -p /data/arch && echo hi | tee /data/arch/f.txt > /dev/null',
      )
      expect(setup.code).toBe(0)
      const first = await exec(ws, 'cat /data/arch/f.txt')
      expect(first.code).toBe(0)
      expect(first.out).toContain('hi')
      const rm = await exec(ws, 'rm /data/arch/f.txt')
      expect(rm.code).toBe(0)
      const reread = await exec(ws, 'cat /data/arch/f.txt')
      expect(reread.code).not.toBe(0)
    } finally {
      await ws.close()
    }
  })
})
