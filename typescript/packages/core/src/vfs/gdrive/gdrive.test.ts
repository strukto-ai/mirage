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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { GoogleAccount } from '../../../tests/core/google/account.ts'
import { MountMode, ReadPolicy } from '../../types.ts'
import { md5Hex } from '../../utils/hash.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import {
  ContentDriftError,
  captureFingerprints,
  checkDrift,
} from '../../workspace/snapshot/drift.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { GoogleDriveVFS, VFS_MD } from './gdrive.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

beforeEach(() => {
  account = new GoogleAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function workspace(mode: MountMode, read?: { policy: ReadPolicy; ttl: number }): Workspace {
  return new Workspace(
    { '/gd': new GoogleDriveVFS(account.config()) },
    { cache: {}, mode, ...(read === undefined ? {} : { read }) },
  )
}

describe('GoogleDriveVFS re-list cleanup', () => {
  // The first read of an expired folder can be a stat of one child; the
  // re-list it warms still has to find the sibling that went away, which it
  // cannot if the old listing is thrown out before warming.
  it('cleans up a sibling a stat-driven re-list drops', async () => {
    const dir = await account.folder('dir')
    await account.upload('a.txt', 'alpha\n', dir)
    const b = await account.upload('b.txt', 'bravo\n', dir)
    const ws = workspace(MountMode.READ)
    try {
      expect(DEC.decode((await ws.shell('ls /gd/dir')).stdout)).toBe('a.txt\nb.txt\n')
      await ws.cache.set('/gd/dir/b.txt', ENC.encode('bravo\n'))
      await ws.namespace.setAttrs('/gd/dir/b.txt', { mode: 0o600 })
      expect(await ws.cache.exists('/gd/dir/b.txt')).toBe(true)
      await account.delete(b)
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
    const dir = await account.folder('dir')
    await account.upload('a.txt', 'alpha\n', dir)
    const b = await account.upload('b.txt', 'bravo\n', dir)
    const ws = workspace(MountMode.READ, { policy: ReadPolicy.FRESH, ttl: 600 })
    try {
      expect(DEC.decode((await ws.shell('ls /gd/dir')).stdout)).toBe('a.txt\nb.txt\n')
      await ws.cache.set('/gd/dir/b.txt', ENC.encode('bravo\n'))
      await ws.namespace.setAttrs('/gd/dir/b.txt', { mode: 0o600 })
      await account.delete(b)
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

/** Make `file.txt` holding `v1`, `depth` folders down, and answer its path. */
async function fileAt(depth: number): Promise<string> {
  let parent = 'root'
  const parts: string[] = []
  for (const name of ['a', 'b', 'c'].slice(0, depth)) {
    parent = await account.folder(name, parent)
    parts.push(name)
  }
  await account.upload('file.txt', 'v1', parent)
  return `/gd/${[...parts, 'file.txt'].join('/')}`
}

/** Hold `path`'s bytes in the workspace's cache, stamped with their md5. */
async function warm(ws: Workspace, path: string): Promise<void> {
  const bytes = ENC.encode('v1')
  await ws.cache.set(path, bytes, { fingerprint: md5Hex(bytes) })
}

describe('GoogleDriveVFS warm read under fresh', () => {
  // Cost is the contract, and the operand probe is the cost. A warm named
  // operand is probed at the command's first lookup of it, with a fresh index, so the probe walks the
  // parent listings: one per level. The command's own stat and the gate both
  // reuse that answer for the rest of the command instead of asking again.
  // More means one of them reached Drive again.
  for (const [depth, listings] of [
    [0, 1],
    [3, 4],
  ] as const) {
    it(`costs one walk per probe at depth ${String(depth)}`, async () => {
      const ws = workspace(MountMode.READ, { policy: ReadPolicy.FRESH, ttl: 600 })
      try {
        const path = await fileAt(depth)
        await warm(ws, path)
        await account.run.recordRequests()
        const result = await ws.shell(`cat ${path}`)
        expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'v1'])
        expect((await account.listings()).filter((l) => !l.level)).toHaveLength(listings)
      } finally {
        await ws.close()
      }
    })
  }

  // The command's stat now comes from the freshness probe rather than from
  // the command's own lookup; what it prints must not change with it.
  it('prints the same stat as a bounded mount', async () => {
    const path = await fileAt(1)
    const outs: string[] = []
    for (const read of [
      { policy: ReadPolicy.FRESH, ttl: 600 },
      { policy: ReadPolicy.BOUNDED, ttl: 600 },
    ]) {
      const ws = workspace(MountMode.READ, read)
      try {
        await warm(ws, path)
        outs.push(DEC.decode((await ws.shell(`stat ${path}`)).stdout))
      } finally {
        await ws.close()
      }
    }
    expect(outs[0]).toBe(outs[1])
    expect(outs[0]).not.toBe('')
  })
})

describe('GoogleDriveVFS snapshot capture on a written path', () => {
  // A read stamps a pin with a revision; the write after it must replace
  // that pin whole with the upload reply's md5, so a replay checks the
  // written bytes rather than pinning the pre-write revision.
  it('pins the write token and replays against it', async () => {
    const id = await account.upload('file.txt', 'v1')
    const ws = workspace(MountMode.WRITE, { policy: ReadPolicy.FRESH, ttl: 600 })
    try {
      await ws.shell('cat /gd/file.txt; echo x | tee /gd/file.txt')
      expect(await account.content(id)).toBe('x\n')
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
      await account.update(id, 'changed')
      await expect(
        checkDrift(ws.registry, statFn, '/gd/file.txt', recorded),
      ).rejects.toBeInstanceOf(ContentDriftError)
    } finally {
      await ws.close()
    }
  })
})

describe('VFS_MD', () => {
  it('cross-references the per-service shapes and notes scope', () => {
    const rendered = VFS_MD.replace(/\{prefix\}/g, '/gdrive')
    expect(rendered).toContain('.gdoc.json')
    expect(rendered).toContain('.gsheet.json')
    expect(rendered).toContain('.gslide.json')
    expect(rendered).toContain('the gdocs gdoc.json shape')
    expect(rendered).toContain('the gsheets gsheet.json shape')
    expect(rendered).toContain('the gslides gslide.json shape')
    expect(rendered).toContain('no `owned/` and `shared/` split')
  })
})
