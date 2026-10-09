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

import { runWithRecording } from '@struktoai/mirage-core/observe/context'
import { DEFAULT_READ_TTL, MountMode, PathSpec, ReadPolicy } from '@struktoai/mirage-core/types'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { ContentDriftError } from '@struktoai/mirage-core/workspace/snapshot/drift'
import { toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import { afterEach, describe, expect, it } from 'vitest'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { FakeHub, blobOid, serveHub } from '../../core/hf_hub/_test_util.ts'
import { read } from '../../core/hf_hub/read.ts'
import { Workspace } from '../../workspace.ts'
import { buildVfs } from '../registry.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const OLD = ENC.encode('version one\n')
const NEW = ENC.encode('version two, longer\n')

let hubs: FakeHub[] = []

afterEach(async () => {
  await Promise.all(hubs.map((hub) => hub.close()))
  hubs = []
})

async function hub(files: Record<string, Uint8Array>): Promise<FakeHub> {
  const fake = new FakeHub()
  for (const [path, data] of Object.entries(files)) fake.files().set(path, data)
  hubs.push(fake)
  return serveHub(fake)
}

function vfsOf(fake: FakeHub): Promise<BaseVFS> {
  return buildVfs('hf_models', { repo_id: 'acme/widget', endpoint: fake.url })
}

function ws(vfs: BaseVFS, policy: ReadPolicy = ReadPolicy.FRESH): Workspace {
  return new Workspace({
    '/m': new Mount(vfs, { mode: MountMode.READ, read: { policy, ttl: DEFAULT_READ_TTL } }),
    '/r': [new RAMVFS(), MountMode.WRITE],
  })
}

async function out(workspace: Workspace, command: string): Promise<Uint8Array> {
  const result = await workspace.shell(command)
  expect([result.exitCode, DEC.decode(result.stderr)], command).toEqual([0, ''])
  return result.stdout
}

describe('hf_hub under read: fresh', () => {
  it('never serves other bytes as fresh after a revert', async () => {
    // The listing still describes OLD while the download already serves NEW:
    // the read must not label NEW with OLD's oid, or a revert back to OLD
    // makes the probe agree and NEW is served as if it were OLD.
    const fake = await hub({ 'a.txt': NEW })
    fake.listed.set('a.txt', OLD)
    const vfs = await vfsOf(fake)
    const w = ws(vfs)
    try {
      expect(await out(w, 'cat /m/a.txt')).toEqual(NEW)
      // The fixture held: the listing was OLD's, and the cached copy carries
      // no token rather than OLD's oid.
      expect((vfs.accessor as HfHubAccessor).treeLoaded).toBe(true)
      expect(await w.cache.isFresh('/m/a.txt', blobOid(OLD))).toBe(false)
      fake.files().set('a.txt', OLD)
      let before = fake.count('resolve')
      expect(await out(w, 'cat /m/a.txt')).toEqual(OLD)
      expect(fake.count('resolve')).toBe(before + 1)
      // The refetch was verified, so it restamped and now serves warm.
      before = fake.count('resolve')
      expect(await out(w, 'cat /m/a.txt')).toEqual(OLD)
      expect(fake.count('resolve')).toBe(before)
    } finally {
      await w.close()
    }
  })

  it('never serves other bytes as fresh after a revert through cp', async () => {
    // The same revert through the bytes read: a cross-mount cp reads with
    // read, where cat reads with the stream.
    const fake = await hub({ 'a.txt': NEW })
    fake.listed.set('a.txt', OLD)
    const w = ws(await vfsOf(fake))
    try {
      await out(w, 'cp /m/a.txt /r/one')
      expect(await out(w, 'cat /r/one')).toEqual(NEW)
      fake.files().set('a.txt', OLD)
      const before = fake.count('resolve')
      await out(w, 'cp /m/a.txt /r/two')
      expect(await out(w, 'cat /r/two')).toEqual(OLD)
      expect(fake.count('resolve')).toBe(before + 1)
    } finally {
      await w.close()
    }
  })

  it('leaves find its whole listing after a probe', async () => {
    const fake = await hub({ 'a.txt': OLD, 'd/b.txt': NEW })
    const w = ws(await vfsOf(fake))
    try {
      await out(w, 'cat /m/a.txt')
      // The warm read's probes answer through paths-info; a probe that seeded
      // its one row as the mount's listing would leave find seeing a single
      // file, or walking again to recover.
      await out(w, 'cat /m/a.txt')
      const walks = fake.count('tree')
      const heads = fake.count('revision')
      const listed = DEC.decode(await out(w, 'find /m -type f'))
      expect(listed.split(/\s+/).filter(Boolean)).toEqual(['/m/a.txt', '/m/d/b.txt'])
      // find, a new command, re-checks the listing once under fresh: one head
      // check against its version, and no walk (Task 1.3).
      expect([fake.count('revision') - heads, fake.count('tree') - walks]).toEqual([1, 0])
    } finally {
      await w.close()
    }
  })

  it('fails loudly on a repo it cannot see', async () => {
    const fake = await hub({ 'a.txt': OLD })
    fake.fail.set('tree', [401, ''])
    const w = ws(await vfsOf(fake), ReadPolicy.BOUNDED)
    try {
      // A refusal reads as a directory the caller may not open, the error
      // every file tool already knows how to report and skip.
      const ls = await w.shell('ls /m')
      expect(ls.exitCode).not.toBe(0)
      expect(DEC.decode(ls.stderr)).toContain('Permission denied')
      const cat = await w.shell('cat /m/a.txt')
      expect([cat.exitCode, DEC.decode(cat.stderr)]).toEqual([
        1,
        'cat: /m/a.txt: Permission denied\n',
      ])
    } finally {
      await w.close()
    }
  })

  it('does not let a refused mount hide the other mounts', async () => {
    // One hf mount the token cannot see must not blank out a search across the
    // workspace: the walk reports that mount and keeps going.
    const fake = await hub({ 'a.txt': OLD })
    fake.fail.set('tree', [401, ''])
    const w = new Workspace({
      '/h': [await vfsOf(fake), MountMode.READ],
      '/r': [new RAMVFS(), MountMode.WRITE],
    })
    try {
      await w.shell('tee /r/n.txt', { stdin: ENC.encode('needle\n') })
      const grep = await w.shell('grep -r needle /')
      expect(DEC.decode(grep.stdout)).toBe('/r/n.txt:needle\n')
      expect(DEC.decode(grep.stderr)).toContain('Permission denied')
      const find = await w.shell('find / -type f')
      expect(DEC.decode(find.stdout)).toContain('/r/n.txt')
    } finally {
      await w.close()
    }
  })

  it('does not let a gated download hide the other mounts', async () => {
    // The tree lists but the file download is refused, as for a gated repo.
    const fake = await hub({ 'a.txt': ENC.encode('needle\n') })
    fake.fail.set('resolve', [403, ''])
    const w = new Workspace({
      '/h': [await vfsOf(fake), MountMode.READ],
      '/r': [new RAMVFS(), MountMode.WRITE],
    })
    try {
      await w.shell('tee /r/n.txt', { stdin: ENC.encode('needle\n') })
      const grep = await w.shell('grep -r needle /')
      expect(DEC.decode(grep.stdout)).toBe('/r/n.txt:needle\n')
      expect(DEC.decode(grep.stderr)).toContain('Permission denied')
    } finally {
      await w.close()
    }
  })

  it('keeps the overlay when the token expires', async () => {
    const fake = await hub({ 'a.txt': OLD })
    const w = ws(await vfsOf(fake))
    try {
      await out(w, 'cat /m/a.txt')
      await w.namespace.setAttrs('/m/a.txt', { mode: 0o600 })
      fake.fail.set('tree', [401, ''])
      fake.fail.set('paths_info', [401, ''])
      // Cross-mount cp reads through the dispatcher, the dispatcher whose "no such
      // file" drops the overlay; a plain cat never reaches it.
      const cp = await w.shell('cp /m/a.txt /r/x')
      expect(cp.exitCode).toBe(1)
      // The refusal, not "No such file": the tree the cold read rebuilt was
      // refused outright rather than read as empty.
      expect(DEC.decode(cp.stderr).endsWith('Permission denied\n')).toBe(true)
      expect(w.namespace.metaFor('/m/a.txt')?.mode).toBe(0o600)
    } finally {
      await w.close()
    }
  })
})

async function pinnedState(fake: FakeHub, vfs?: BaseVFS) {
  const w = ws(vfs ?? (await vfsOf(fake)))
  try {
    await out(w, 'cat /m/a.txt')
    return await toStateDict(w)
  } finally {
    await w.close()
  }
}

async function load(state: Awaited<ReturnType<typeof toStateDict>>, vfs: BaseVFS): Promise<void> {
  const loaded = await Workspace.fromState(state, {}, { '/m': vfs })
  try {
    await out(loaded, 'cat /m/a.txt')
  } finally {
    await loaded.close()
  }
}

describe('hf_hub snapshot pins', () => {
  it('pins a verified read, and a changed file drifts', async () => {
    const fake = await hub({ 'a.txt': OLD })
    const state = await pinnedState(fake)
    fake.files().set('a.txt', NEW)
    const walks = fake.count('tree')
    await expect(load(state, await vfsOf(fake))).rejects.toBeInstanceOf(ContentDriftError)
    // A restored mount has not loaded its tree, so the check walks it.
    expect(fake.count('tree')).toBeGreaterThan(walks)
  })

  it('pins nothing for an unverified read', async () => {
    const fake = await hub({ 'a.txt': NEW })
    fake.listed.set('a.txt', OLD)
    const state = await pinnedState(fake)
    fake.listed.clear()
    // Upstream is at NEW, which is what the agent actually read; a pin of the
    // listing's OLD oid would raise a drift that never happened.
    await load(state, await vfsOf(fake))
  })

  it('does not call a refused drift check drift', async () => {
    const fake = await hub({ 'a.txt': OLD })
    const state = await pinnedState(fake)
    fake.fail.set('tree', [401, ''])
    const err = await load(state, await vfsOf(fake)).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('EACCES')
  })

  it('asks one path when the drift check runs on a loaded mount', async () => {
    const fake = await hub({ 'a.txt': OLD })
    const vfs = await vfsOf(fake)
    const w = ws(vfs)
    try {
      await out(w, 'cat /m/a.txt')
      const state = await toStateDict(w)
      // The live mount is handed over, so it has loaded its tree and the check
      // asks for the one path rather than walking again.
      fake.files().set('a.txt', NEW)
      fake.log.length = 0
      await expect(load(state, vfs)).rejects.toBeInstanceOf(ContentDriftError)
      expect([fake.count('paths_info'), fake.count('tree')]).toEqual([1, 0])
      fake.fail.set('paths_info', [401, ''])
      const err = await load(state, vfs).catch((e: unknown) => e)
      expect((err as { code?: string }).code).toBe('EACCES')
    } finally {
      await w.close()
    }
  })
})

// Measured on the first green run, then pinned (test plan T31): each path ask
// is one reconcile probe, and a warm read makes no download. cat's own stat
// and the cache stage reuse the routing probe's answer. Cross-mount cp skips
// routing's probe, so
// only the cache stage asks, and its stat re-checks the listing its path
// resolves through, which fresh does once per command: one head check
// against the listing's version, where it was a whole tree walk (Task 1.3).
const WARM: [string, number, number, number][] = [
  ['cat /m/a.txt', 1, 0, 0],
  ['cat /m/a.txt | head -c 1', 1, 0, 0],
  ['cp /m/a.txt /r/a.txt', 1, 0, 1],
]

describe('hf_hub warm read cost', () => {
  it.each(WARM)('%s costs one path per probe', async (command, posts, walks, heads) => {
    const fake = await hub({ 'a.txt': OLD })
    const w = ws(await vfsOf(fake))
    try {
      await out(w, 'cat /m/a.txt')
      fake.log.length = 0
      await out(w, command)
      expect([
        fake.count('paths_info'),
        fake.count('tree'),
        fake.count('resolve'),
        fake.count('revision'),
      ]).toEqual([posts, walks, 0, heads])
    } finally {
      await w.close()
    }
  })

  it('a new mount loads its tree once and never asks one path', async () => {
    const fake = await hub({ 'a.txt': OLD })
    const w = ws(await vfsOf(fake), ReadPolicy.BOUNDED)
    try {
      await out(w, 'stat -c %s /m/a.txt')
      await out(w, 'stat -c %s /m/a.txt')
      await out(w, 'ls /m')
      // The fill resolves the head it walks the tree at (Task 1.3).
      expect([fake.count('tree'), fake.count('paths_info'), fake.count('revision')]).toEqual([
        1, 0, 1,
      ])
    } finally {
      await w.close()
    }
  })
})

describe('hf_hub ranged read', () => {
  it.each([
    [null, true],
    ['other', false],
  ])('stamps the whole file oid (etag override %s)', async (override, expected) => {
    const fake = await hub({ 'a.txt': OLD })
    if (override !== null) fake.etags.set('a.txt', override)
    const vfs = await vfsOf(fake)
    const spec = new PathSpec({ virtual: '/a.txt', directory: '/', vfsPath: 'a.txt' })
    let data: Uint8Array
    let records: { fingerprint: string | null }[]
    try {
      ;[data, records] = await runWithRecording(() =>
        read(vfs.accessor as HfHubAccessor, spec, undefined, { offset: 2, size: 3 }),
      )
    } finally {
      await vfs.close()
    }
    expect(data).toEqual(OLD.slice(2, 5))
    expect(records.map((r) => r.fingerprint)).toEqual(expected ? [blobOid(OLD)] : [null])
  })
})
