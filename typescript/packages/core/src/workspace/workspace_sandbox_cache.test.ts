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
import { RAMResource } from '../resource/ram/ram.ts'
import { ConsistencyPolicy, MountMode, PathSpec } from '../types.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// The sandbox bridge and Workspace.dispatch route through the
// Dispatcher, so sandbox I/O shares the shell path's file cache:
// warm reads serve cached bytes and writes invalidate, exactly as in
// Python where Workspace.dispatch delegates to the Dispatcher.
async function makeCachingWorkspace(): Promise<{ ws: Workspace; ram: RAMResource }> {
  const parser = await getTestParser()
  const ram = new RAMResource()
  // Force the cache on a local backend so reads are cached and, under
  // LAZY, never revalidated (the cache_mount.test.ts pattern).
  ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
  const ws = new Workspace(
    { '/r': ram },
    {
      mode: MountMode.EXEC,
      consistency: ConsistencyPolicy.LAZY,
      shellParserFactory: () => Promise.resolve(parser),
    },
  )
  return { ws, ram }
}

describe('sandbox bridge shares the shell file cache', () => {
  it('js read is served from the warm cache, not the backend', async () => {
    const { ws, ram } = await makeCachingWorkspace()
    try {
      await ws.execute('echo v1 > /r/f.txt')
      const first = DEC.decode((await ws.execute('cat /r/f.txt')).stdout)
      expect(first).toContain('v1')
      // Out-of-band mutation: under LAZY the cache is not revalidated,
      // so the warm read must keep serving v1 — from the sandbox too.
      ram.store.files.set('/f.txt', ENC.encode('v2-out-of-band\n'))
      const io = await ws.execute(
        "js -e \"const f = std.open('/r/f.txt', 'r'); console.log(f.readAsString().trim()); f.close()\"",
      )
      expect(io.exitCode).toBe(0)
      expect(DEC.decode(io.stdout)).toBe('v1\n')
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('js write invalidates the cache so cat sees the new bytes', async () => {
    const { ws } = await makeCachingWorkspace()
    try {
      await ws.execute('echo v1 > /r/f.txt')
      const warm = DEC.decode((await ws.execute('cat /r/f.txt')).stdout)
      expect(warm).toContain('v1')
      const io = await ws.execute(
        "js -e \"const f = std.open('/r/f.txt', 'w'); f.puts('v2-from-js'); f.close()\"",
      )
      expect(io.exitCode).toBe(0)
      const after = DEC.decode((await ws.execute('cat /r/f.txt')).stdout)
      expect(after).toBe('v2-from-js')
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('Workspace.dispatch write invalidates the cache', async () => {
    const { ws } = await makeCachingWorkspace()
    try {
      await ws.execute('echo v1 > /r/f.txt')
      expect(DEC.decode((await ws.execute('cat /r/f.txt')).stdout)).toContain('v1')
      await ws.dispatch('write', '/r/f.txt', [ENC.encode('v3-from-dispatch\n')])
      const after = DEC.decode((await ws.execute('cat /r/f.txt')).stdout)
      expect(after).toBe('v3-from-dispatch\n')
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('Workspace.dispatch rename drops the stale source cache entry', async () => {
    const { ws } = await makeCachingWorkspace()
    try {
      await ws.execute('echo v1 > /r/f.txt')
      expect(DEC.decode((await ws.execute('cat /r/f.txt')).stdout)).toContain('v1')
      await ws.dispatch('rename', '/r/f.txt', [PathSpec.fromStrPath('/r/g.txt')])
      const gone = await ws.execute('cat /r/f.txt')
      expect(gone.exitCode).not.toBe(0)
      const moved = DEC.decode((await ws.execute('cat /r/g.txt')).stdout)
      expect(moved).toContain('v1')
    } finally {
      await ws.close()
    }
  }, 60_000)
})
