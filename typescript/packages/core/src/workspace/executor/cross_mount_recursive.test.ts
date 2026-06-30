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

// Mirror of python/tests/workspace/test_cross_mount_recursive.py. Two RAM
// mounts exercise recursive cp/mv across mounts (empty-dir preservation,
// per-file no-clobber, omitting-directory) end-to-end through the workspace,
// so no S3/MinIO is needed. Guards cross-mount transfer against regression
// while it is collapsed onto the shared cp/mv generics.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { RAMResource } from '../../resource/ram/ram.ts'
import { createShellParser } from '../../shell/parse.ts'
import { MountMode } from '../../types.ts'
import { Workspace } from '../workspace.ts'

const DEC = new TextDecoder()
const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

function makeWs(): Workspace {
  return new Workspace(
    { '/a': new RAMResource(), '/b': new RAMResource() },
    {
      mode: MountMode.WRITE,
      shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
    },
  )
}

async function run(
  ws: Workspace,
  cmd: string,
): Promise<{ out: string; err: string; code: number }> {
  const res = await ws.execute(cmd)
  return { out: DEC.decode(res.stdout), err: DEC.decode(res.stderr), code: res.exitCode }
}

async function seedSrc(ws: Workspace): Promise<void> {
  await run(ws, 'mkdir -p /a/dir/sub')
  await run(ws, 'mkdir -p /a/dir/empty')
  await run(ws, 'echo aaa | tee /a/dir/a.txt > /dev/null')
  await run(ws, 'echo bbb | tee /a/dir/sub/b.txt > /dev/null')
}

describe('cross-mount recursive cp/mv (port of test_cross_mount_recursive.py)', () => {
  it('cp -r copies the whole tree including empty dirs', async () => {
    const ws = makeWs()
    try {
      await seedSrc(ws)
      const cp = await run(ws, 'cp -r /a/dir /b/copied')
      expect(cp.code).toBe(0)
      expect((await run(ws, 'cat /b/copied/a.txt')).out).toBe('aaa\n')
      expect((await run(ws, 'cat /b/copied/sub/b.txt')).out).toBe('bbb\n')
      expect((await run(ws, 'ls /b/copied')).out).toContain('empty')
    } finally {
      await ws.close()
    }
  })

  it('cp -r into an existing dir nests under it', async () => {
    const ws = makeWs()
    try {
      await seedSrc(ws)
      await run(ws, 'mkdir -p /b/into')
      const cp = await run(ws, 'cp -r /a/dir /b/into')
      expect(cp.code).toBe(0)
      expect((await run(ws, 'cat /b/into/dir/a.txt')).out).toBe('aaa\n')
      expect((await run(ws, 'cat /b/into/dir/sub/b.txt')).out).toBe('bbb\n')
    } finally {
      await ws.close()
    }
  })

  it('cp of a directory without -r fails with omitting directory', async () => {
    const ws = makeWs()
    try {
      await seedSrc(ws)
      const cp = await run(ws, 'cp /a/dir /b/copied')
      expect(cp.code).toBe(1)
      expect(cp.err).toContain('omitting directory')
      expect((await run(ws, 'cat /b/copied/a.txt')).code).not.toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('mv moves the tree and removes the source', async () => {
    const ws = makeWs()
    try {
      await seedSrc(ws)
      const mv = await run(ws, 'mv /a/dir /b/moved')
      expect(mv.code).toBe(0)
      expect((await run(ws, 'cat /b/moved/a.txt')).out).toBe('aaa\n')
      expect((await run(ws, 'cat /b/moved/sub/b.txt')).out).toBe('bbb\n')
      expect((await run(ws, 'cat /a/dir/a.txt')).code).not.toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('cp -rn skips an existing file but copies a new one', async () => {
    const ws = makeWs()
    try {
      await seedSrc(ws)
      await run(ws, 'mkdir -p /b/into/dir')
      await run(ws, 'echo keep | tee /b/into/dir/a.txt > /dev/null')
      const cp = await run(ws, 'cp -rn /a/dir /b/into')
      expect(cp.code).toBe(0)
      expect((await run(ws, 'cat /b/into/dir/a.txt')).out).toBe('keep\n')
      expect((await run(ws, 'cat /b/into/dir/sub/b.txt')).out).toBe('bbb\n')
    } finally {
      await ws.close()
    }
  })
})
