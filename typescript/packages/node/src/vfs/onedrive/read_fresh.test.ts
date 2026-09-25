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

import type { OneDriveAccessor } from '@struktoai/mirage-core/accessor/onedrive'
import { read, stream } from '@struktoai/mirage-core/core/onedrive/index'
import { runWithRecording } from '@struktoai/mirage-core/observe/context'
import { DEFAULT_READ_TTL, MountMode, PathSpec, ReadPolicy } from '@struktoai/mirage-core/types'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeGraph, ME, serveGraph } from '../../core/msgraph/_test_util.ts'
import { Workspace } from '../../workspace.ts'
import { buildVfs } from '../registry.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const OLD = ENC.encode('version one\n')
const NEW = ENC.encode('version two, longer\n')
const CAT = 'cat /m/a.txt'
const CP = 'cp /m/a.txt /r/x && cat /r/x'

let graphs: FakeGraph[] = []

afterEach(async () => {
  await Promise.all(graphs.map((graph) => graph.close()))
  graphs = []
})

async function graphOf(data: Uint8Array, childrenAllowed = 0): Promise<FakeGraph> {
  const graph = new FakeGraph({ [ME]: { 'a.txt': data } })
  graph.childrenAllowed = childrenAllowed
  graphs.push(graph)
  return serveGraph(graph)
}

function vfsOf(graph: FakeGraph): Promise<VFS> {
  return buildVfs('onedrive', { access_token: 't', graph_base_url: graph.url })
}

function ws(vfs: VFS): Workspace {
  return new Workspace({
    '/m': new Mount(vfs, {
      mode: MountMode.WRITE,
      read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL },
    }),
    '/r': [new RAMVFS(), MountMode.WRITE],
  })
}

async function out(workspace: Workspace, command: string): Promise<string> {
  const result = await workspace.shell(command)
  expect([result.exitCode, DEC.decode(result.stderr)], command).toEqual([0, ''])
  return DEC.decode(result.stdout)
}

const SPEC = new PathSpec({ virtual: '/a.txt', directory: '/', vfsPath: 'a.txt' })

describe('onedrive under read: fresh', () => {
  it.each([
    ['stream', CAT],
    ['bytes', CP],
  ])('refetches a write between the token and the bytes (%s)', async (_row, command) => {
    const graph = await graphOf(OLD)
    const w = ws(await vfsOf(graph))
    try {
      // The file changes after the bytes are taken and before they are sent,
      // so the read holds OLD while Graph already holds NEW. A token read
      // after the bytes would label OLD with NEW's cTag.
      graph.onBytes(() => {
        graph.write(ME, 'a.txt', NEW)
      })
      expect(await out(w, command)).toBe(DEC.decode(OLD))
      expect(graph.hookFired).toBe(1)
      const before = graph.fetches()
      expect(await out(w, command)).toBe(DEC.decode(NEW))
      expect(graph.fetches() - before).toBe(1)
      expect(graph.reach).toEqual([])
    } finally {
      await w.close()
    }
  })

  it('an unrecorded read fetches the bare item, then its bytes', async () => {
    const graph = await graphOf(OLD)
    const vfs = await vfsOf(graph)
    const data = await read(vfs.accessor as OneDriveAccessor, SPEC)
    expect(DEC.decode(data)).toBe(DEC.decode(OLD))
    // No version history: the revision only matters to a snapshot, and only a
    // recorded read can land in one.
    expect(graph.log).toEqual([
      ['item', 'a.txt', ''],
      ['download', 'a.txt', ''],
    ])
  })

  it.each(['bytes', 'stream'])('a recorded %s read keeps the revision snapshots pin', async (slot) => {
    const graph = await graphOf(OLD)
    graph.write(ME, 'a.txt', NEW)
    const accessor = (await vfsOf(graph)).accessor as OneDriveAccessor
    const [data, records] = await runWithRecording(async () => {
      if (slot === 'bytes') return read(accessor, SPEC)
      const parts: Uint8Array[] = []
      for await (const chunk of stream(accessor, SPEC)) parts.push(chunk)
      return Buffer.concat(parts)
    })
    expect(DEC.decode(data)).toBe(DEC.decode(NEW))
    expect(graph.queries('item')).toEqual(['$expand=versions'])
    expect(records.map((r) => [r.fingerprint, r.revision])).toEqual([['c2', '2.0']])
  })

  it('a ranged read stamps the whole item cTag', async () => {
    const graph = await graphOf(OLD)
    const accessor = (await vfsOf(graph)).accessor as OneDriveAccessor
    const [data, records] = await runWithRecording(() =>
      read(accessor, SPEC, undefined, { offset: 2, size: 3 }),
    )
    expect(DEC.decode(data)).toBe(DEC.decode(OLD.slice(2, 5)))
    expect(records.map((r) => r.fingerprint)).toEqual(['c1'])
    expect([graph.count('download'), graph.count('content')]).toEqual([1, 0])
  })

  it('a listed cTag never answers for a changed file', async () => {
    const graph = await graphOf(OLD, 1)
    const w = ws(await vfsOf(graph))
    try {
      // The listing leaves c1 in the mount index. A probe that trusted it
      // would match the c1 the cache holds and serve OLD.
      await out(w, 'ls /m')
      expect(await out(w, CAT)).toBe(DEC.decode(OLD))
      graph.write(ME, 'a.txt', NEW)
      expect(await out(w, CAT)).toBe(DEC.decode(NEW))
    } finally {
      await w.close()
    }
  })

  it('a metadata edit does not refetch', async () => {
    const graph = await graphOf(OLD)
    const w = ws(await vfsOf(graph))
    try {
      await out(w, CAT)
      // A rename or a property edit moves the eTag and the stamp, never the
      // cTag, so the cached bytes are still current.
      graph.touch(ME, 'a.txt')
      const before = graph.fetches()
      expect(await out(w, CAT)).toBe(DEC.decode(OLD))
      expect(graph.fetches() - before).toBe(0)
    } finally {
      await w.close()
    }
  })
})

// Measured in python on the first green run, then pinned; the two hosts must
// agree. The listing makes every ordinary stat an index hit, so what is left
// is the reconcile probes: cat pays routing's and the cache gate's, cp skips
// routing (write commands are not reconciled there) and keeps the gate. A
// warm read downloads nothing and lists nothing.
const WARM: [string, number][] = [
  [CAT, 2],
  ['cat /m/a.txt | head -c 1', 2],
  ['cp /m/a.txt /r/a.txt', 1],
]

describe('onedrive warm read cost', () => {
  it.each(WARM)('%s costs one item per probe', async (command, items) => {
    const graph = await graphOf(OLD, 1)
    const w = ws(await vfsOf(graph))
    try {
      await out(w, 'ls /m')
      await out(w, CAT)
      graph.log.length = 0
      await out(w, command)
      expect([graph.count('item'), graph.fetches(), graph.count('children')]).toEqual([items, 0, 0])
    } finally {
      await w.close()
    }
  })
})
