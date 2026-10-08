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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DriveModule from '../../core/google/drive.ts'

vi.mock('../../core/google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../../core/google/drive.ts')
  const { driveModuleMock } = await import('../../core/gdrive/_test_util.ts')
  return driveModuleMock(actual)
})

import type * as VersionsModule from '../../core/gdrive/versions.ts'

// A byte read pins Drive's head revision and downloads that revision; the
// shared fake serves neither, so they answer from it here, the way the
// Python fake's `capture_file_metadata` does.
const held = vi.hoisted(() => ({ fake: null as FakeDrive | null }))

vi.mock('../../core/gdrive/versions.ts', async () => {
  const actual = await vi.importActual<typeof VersionsModule>('../../core/gdrive/versions.ts')
  return {
    ...actual,
    captureFileMetadata: async (tm: unknown, fileId: string) => {
      if (held.fake === null) throw new Error('no fake drive')
      const file = await held.fake.getFile(tm as never, fileId)
      return [file.md5Checksum ?? null, file.headRevisionId ?? null]
    },
    downloadRevision: (tm: unknown, fileId: string) => {
      if (held.fake === null) throw new Error('no fake drive')
      return held.fake.downloadFile(tm as never, fileId)
    },
  }
})

import type { FakeDrive } from '../../core/gdrive/_test_util.ts'
import { resetFakeDrive } from '../../core/gdrive/_test_util.ts'
import { MountMode, ReadPolicy } from '../../types.ts'
import { md5Hex } from '../../utils/hash.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import {
  ContentDriftError,
  captureFingerprints,
  checkDrift,
} from '../../workspace/snapshot/drift.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { GDriveVFS } from './gdrive.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
let fake: FakeDrive

beforeEach(() => {
  fake = resetFakeDrive()
  held.fake = fake
})

describe('GDriveVFS re-list cleanup', () => {
  // The first read of an expired folder can be a stat of one child; the
  // re-list it warms still has to find the sibling that went away, which it
  // cannot if the old listing is thrown out before warming.
  it('cleans up a sibling a stat-driven re-list drops', async () => {
    const dir = fake.folder('dir')
    fake.add('a.txt', dir, undefined, ENC.encode('alpha\n'))
    const b = fake.add('b.txt', dir, undefined, ENC.encode('bravo\n'))
    const ws = new Workspace(
      { '/gd': new GDriveVFS({ clientId: 'i', clientSecret: 's', refreshToken: 'r' }) },
      { mode: MountMode.READ, shellParser: await getTestParser() },
    )
    try {
      expect(DEC.decode((await ws.shell('ls /gd/dir')).stdout)).toBe('a.txt\nb.txt\n')
      // Seeded directly: the byte read goes through Drive's revision API,
      // which this fake does not serve, and only its leftover matters here.
      await ws.cache.set('/gd/dir/b.txt', ENC.encode('bravo\n'))
      await ws.namespace.setAttrs('/gd/dir/b.txt', { mode: 0o600 })
      expect(await ws.cache.exists('/gd/dir/b.txt')).toBe(true)
      fake.items.delete(b)
      await ws.registry.mountFor('/gd/dir').index.invalidate()
      expect(DEC.decode((await ws.shell('stat -c %n /gd/dir/a.txt')).stdout)).toBe(
        '/gd/dir/a.txt\n',
      )
      expect(ws.namespace.metaFor('/gd/dir/b.txt')).toBeNull()
      expect(await ws.cache.exists('/gd/dir/b.txt')).toBe(false)
    } finally {
      await ws.close()
    }
  })

  // Under fresh the next command re-lists on its own; its first read is a
  // stat of a sibling, and that re-list still has to find b.txt gone.
  it('re-lists under fresh on a stat and cleans up a dropped sibling', async () => {
    const dir = fake.folder('dir')
    fake.add('a.txt', dir, undefined, ENC.encode('alpha\n'))
    const b = fake.add('b.txt', dir, undefined, ENC.encode('bravo\n'))
    const ws = new Workspace(
      { '/gd': new GDriveVFS({ clientId: 'i', clientSecret: 's', refreshToken: 'r' }) },
      {
        mode: MountMode.READ,
        read: { policy: ReadPolicy.FRESH, ttl: 600 },
        shellParser: await getTestParser(),
      },
    )
    try {
      expect(DEC.decode((await ws.shell('ls /gd/dir')).stdout)).toBe('a.txt\nb.txt\n')
      await ws.cache.set('/gd/dir/b.txt', ENC.encode('bravo\n'))
      await ws.namespace.setAttrs('/gd/dir/b.txt', { mode: 0o600 })
      fake.items.delete(b)
      expect(DEC.decode((await ws.shell('stat -c %n /gd/dir/a.txt')).stdout)).toBe(
        '/gd/dir/a.txt\n',
      )
      expect(ws.namespace.metaFor('/gd/dir/b.txt')).toBeNull()
      expect(await ws.cache.exists('/gd/dir/b.txt')).toBe(false)
    } finally {
      await ws.close()
    }
  })
})

function freshWs(parser: Awaited<ReturnType<typeof getTestParser>>): Workspace {
  return new Workspace(
    { '/gd': new GDriveVFS({ clientId: 'i', clientSecret: 's', refreshToken: 'r' }) },
    { mode: MountMode.READ, read: { policy: ReadPolicy.FRESH, ttl: 600 }, shellParser: parser },
  )
}

// Seeded under the token the stat answers, as the cold read would stamp it:
// the byte read goes through Drive's revision API, which this fake does not
// serve, so the warm half is what these tests can drive.
async function warmFile(ws: Workspace, depth: number): Promise<string> {
  let parent = 'root'
  const parts: string[] = []
  for (const name of ['a', 'b', 'c'].slice(0, depth)) {
    parent = fake.folder(name, parent)
    parts.push(name)
  }
  const bytes = ENC.encode('v1')
  fake.add('file.txt', parent, undefined, bytes)
  const path = `/gd/${[...parts, 'file.txt'].join('/')}`
  await ws.cache.set(path, bytes, { fingerprint: md5Hex(bytes) })
  return path
}

describe('GDriveVFS warm read under fresh', () => {
  // Cost is the contract, and the routing probe is the cost. A warm named
  // operand is probed at routing, with a fresh index, so the probe walks the
  // parent listings: one per level. The command's own stat and the gate both
  // reuse that answer for the rest of the command instead of asking again.
  // More means one of them reached Drive again.
  for (const [depth, listings] of [
    [0, 1],
    [3, 4],
  ] as const) {
    it(`costs one walk per probe at depth ${String(depth)}`, async () => {
      const ws = freshWs(await getTestParser())
      try {
        const path = await warmFile(ws, depth)
        fake.listLimits.length = 0
        const result = await ws.shell(`cat ${path}`)
        expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'v1'])
        expect(fake.listLimits).toHaveLength(listings)
      } finally {
        await ws.close()
      }
    })
  }

  // The command's stat now comes from the freshness probe rather than from
  // the command's own lookup; what it prints must not change with it.
  it('prints the same stat as a bounded mount', async () => {
    const parser = await getTestParser()
    const outs: string[] = []
    for (const read of [
      { policy: ReadPolicy.FRESH, ttl: 600 },
      { policy: ReadPolicy.BOUNDED, ttl: 600 },
    ]) {
      fake = resetFakeDrive()
      const ws = new Workspace(
        { '/gd': new GDriveVFS({ clientId: 'i', clientSecret: 's', refreshToken: 'r' }) },
        { mode: MountMode.READ, read, shellParser: parser },
      )
      try {
        const path = await warmFile(ws, 1)
        outs.push(DEC.decode((await ws.shell(`stat ${path}`)).stdout))
      } finally {
        await ws.close()
      }
    }
    expect(outs[0]).toBe(outs[1])
    expect(outs[0]).not.toBe('')
  })
})

describe('GDriveVFS snapshot capture on a written path', () => {
  // A read stamps a pin with a revision; the write after it must replace
  // that pin whole with the upload reply's md5, so a replay checks the
  // written bytes rather than pinning the pre-write revision.
  it('pins the write token and replays against it', async () => {
    const id = fake.add('file.txt', 'root', undefined, ENC.encode('v1'))
    const ws = new Workspace(
      { '/gd': new GDriveVFS({ clientId: 'i', clientSecret: 's', refreshToken: 'r' }) },
      {
        mode: MountMode.WRITE,
        read: { policy: ReadPolicy.FRESH, ttl: 600 },
        shellParser: await getTestParser(),
      },
    )
    try {
      await ws.shell('cat /gd/file.txt; echo x | tee /gd/file.txt')
      expect(DEC.decode(fake.items.get(id)?.content)).toBe('x\n')
      const pins = captureFingerprints(ws.records, ws.registry).filter(
        (e) => e.path === '/gd/file.txt',
      )
      const recorded = md5Hex(ENC.encode('x\n'))
      expect(pins).toEqual([{ path: '/gd/file.txt', mount_prefix: '/gd/', fingerprint: recorded }])
      // Drift checks stat with a fresh index, as the workspace's drift
      // drain does; the mount's index still holds the pre-change row.
      const statFn = (p: string): Promise<unknown> =>
        ws.dispatch('stat', p, [], { index: new RAMIndexCacheStore() })
      await checkDrift(ws.registry, statFn, '/gd/file.txt', recorded)
      const item = fake.items.get(id)
      if (item !== undefined) item.content = ENC.encode('changed')
      await expect(
        checkDrift(ws.registry, statFn, '/gd/file.txt', recorded),
      ).rejects.toBeInstanceOf(ContentDriftError)
    } finally {
      await ws.close()
    }
  })
})
