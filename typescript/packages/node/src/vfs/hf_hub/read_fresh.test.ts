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

import { recordingScope } from '@struktoai/mirage-core/observe/context'
import { DEFAULT_READ_TTL, MountMode, PathSpec, ReadPolicy } from '@struktoai/mirage-core/types'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { ContentDriftError } from '@struktoai/mirage-core/workspace/snapshot/drift'
import { toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { HfHubAccessor } from '@struktoai/mirage-core/accessor/hf_hub'
import {
  BRIDGE,
  type HubRepo,
  RESOLVE,
  blobOid,
  madeRepo,
} from '../../../../core/tests/fixtures/hub_repo.ts'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { rowAt } from '../../../tests/core/hf_hub/_test_util.ts'
import { read } from '@struktoai/mirage-core/core/hf_hub/read'
import { Workspace } from '../../workspace.ts'
import { buildVfs } from '../registry.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const OLD = ENC.encode('version one\n')
const NEW = ENC.encode('version two, longer\n')

let origin = ''
let repos: HubRepo[] = []

beforeAll(async () => {
  origin = await serve('hf_hub')
})

afterEach(async () => {
  await Promise.all(repos.map((repo) => repo.run.close()))
  repos = []
})

// A model repository of its own holding `files`, its requests recorded from
// then on.
async function hub(files: Record<string, Uint8Array>): Promise<HubRepo> {
  const repo = await madeRepo(origin)
  repos.push(repo)
  await repo.commit(files)
  await repo.run.recordRequests()
  return repo
}

function vfsOf(repo: HubRepo): Promise<BaseVFS> {
  return buildVfs('hf_models', repo.config())
}

// Land a commit of `next` while the next download waits, after the mount
// listed the file: the listing describes what it held before, and the
// download serves `next`. Plain, not Xet: storing one on Xet reloads the run,
// which would drop the download it holds.
async function listedBeforeTheBytes(repo: HubRepo, path: string, next: Uint8Array): Promise<void> {
  await repo.run.beforeNext([['GET', RESOLVE]], () => repo.commit({ [path]: next }, false))
}

function ws(vfs: BaseVFS, policy: ReadPolicy = ReadPolicy.FRESH): Workspace {
  return new Workspace(
    {
      '/m': new Mount(vfs, { mode: MountMode.READ, read: { policy, ttl: DEFAULT_READ_TTL } }),
      '/r': [new RAMVFS(), MountMode.WRITE],
    },
    { cache: {} },
  )
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
    const repo = await hub({ 'a.txt': OLD })
    await listedBeforeTheBytes(repo, 'a.txt', NEW)
    const vfs = await vfsOf(repo)
    const w = ws(vfs)
    try {
      expect(await out(w, 'cat /m/a.txt')).toEqual(NEW)
      // The fixture held: the listing was OLD's, and the cached copy carries
      // no token rather than OLD's oid.
      expect(await w.cache.isFresh('/m/a.txt', blobOid(OLD))).toBe(false)
      await repo.commit({ 'a.txt': OLD })
      expect(await out(w, 'cat /m/a.txt')).toEqual(OLD)
      expect(await repo.count('resolve')).toBe(1)
      // The refetch was verified, so it restamped and now serves warm.
      await repo.run.recordRequests()
      expect(await out(w, 'cat /m/a.txt')).toEqual(OLD)
      expect(await repo.count('resolve')).toBe(0)
    } finally {
      await w.close()
    }
  })

  it('never serves other bytes as fresh after a revert through cp', async () => {
    // The same revert through the bytes read: a cross-mount cp reads with
    // read, where cat reads with the stream.
    const repo = await hub({ 'a.txt': OLD })
    await listedBeforeTheBytes(repo, 'a.txt', NEW)
    const w = ws(await vfsOf(repo))
    try {
      await out(w, 'cp /m/a.txt /r/one')
      expect(await out(w, 'cat /r/one')).toEqual(NEW)
      await repo.commit({ 'a.txt': OLD })
      await out(w, 'cp /m/a.txt /r/two')
      expect(await out(w, 'cat /r/two')).toEqual(OLD)
      expect(await repo.count('resolve')).toBe(1)
    } finally {
      await w.close()
    }
  })

  it('leaves find its whole listing after a probe', async () => {
    const repo = await hub({ 'a.txt': OLD, 'd/b.txt': NEW })
    const w = ws(await vfsOf(repo))
    try {
      await out(w, 'cat /m/a.txt')
      // The warm read's probes answer through paths-info; a probe that seeded
      // its one row as the mount's listing would leave find seeing a single
      // file, or walking again to recover.
      await out(w, 'cat /m/a.txt')
      await repo.run.recordRequests()
      const listed = DEC.decode(await out(w, 'find /m -type f'))
      expect(listed.split(/\s+/).filter(Boolean)).toEqual(['/m/a.txt', '/m/d/b.txt'])
      // find, a new command, re-checks the listing once under fresh: one head
      // check against its version, and no walk (Task 1.3).
      expect([await repo.count('revision'), await repo.count('tree')]).toEqual([1, 0])
    } finally {
      await w.close()
    }
  })

  it('fails loudly on a repo it cannot see', async () => {
    const repo = await hub({ 'a.txt': OLD })
    await repo.refuse('tree', 401)
    const w = ws(await vfsOf(repo), ReadPolicy.BOUNDED)
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
    const repo = await hub({ 'a.txt': OLD })
    await repo.refuse('tree', 401)
    const w = new Workspace({
      '/h': [await vfsOf(repo), MountMode.READ],
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
    const repo = await hub({ 'a.txt': ENC.encode('needle\n') })
    await repo.refuse('resolve', 403)
    const w = new Workspace({
      '/h': [await vfsOf(repo), MountMode.READ],
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
    const repo = await hub({ 'a.txt': OLD })
    const w = ws(await vfsOf(repo))
    try {
      await out(w, 'cat /m/a.txt')
      await w.namespace.setAttrs('/m/a.txt', { mode: 0o600 })
      await repo.refuse('tree', 401)
      await repo.refuse('paths_info', 401)
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

async function pinnedState(repo: HubRepo, vfs?: BaseVFS) {
  const w = ws(vfs ?? (await vfsOf(repo)))
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
    const repo = await hub({ 'a.txt': OLD })
    const state = await pinnedState(repo)
    await repo.commit({ 'a.txt': NEW })
    await expect(load(state, await vfsOf(repo))).rejects.toBeInstanceOf(ContentDriftError)
    // The check asks for the one path rather than walking the tree.
    expect([await repo.count('paths_info'), await repo.count('tree')]).toEqual([1, 0])
  })

  it('pins nothing for an unverified read', async () => {
    const repo = await hub({ 'a.txt': OLD })
    await listedBeforeTheBytes(repo, 'a.txt', NEW)
    const state = await pinnedState(repo)
    // Upstream is at NEW, which is what the agent actually read; a pin of the
    // listing's OLD oid would raise a drift that never happened.
    await load(state, await vfsOf(repo))
  })

  it('does not call a refused drift check drift', async () => {
    const repo = await hub({ 'a.txt': OLD })
    const state = await pinnedState(repo)
    await repo.refuse('paths_info', 401)
    const err = await load(state, await vfsOf(repo)).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('EACCES')
  })

  it('asks one path when the drift check runs on a loaded mount', async () => {
    const repo = await hub({ 'a.txt': OLD })
    const vfs = await vfsOf(repo)
    const w = ws(vfs)
    try {
      await out(w, 'cat /m/a.txt')
      const state = await toStateDict(w)
      // The check asks for the one path rather than walking again.
      await repo.commit({ 'a.txt': NEW })
      await expect(load(state, vfs)).rejects.toBeInstanceOf(ContentDriftError)
      expect([await repo.count('paths_info'), await repo.count('tree')]).toEqual([1, 0])
      await repo.refuse('paths_info', 401)
      const err = await load(state, vfs).catch((e: unknown) => e)
      expect((err as { code?: string }).code).toBe('EACCES')
    } finally {
      await w.close()
    }
  })
})

// Measured on the first green run, then pinned (test plan T31): each path ask
// is one reconcile probe, and a warm read makes no download. The probe runs at
// the command's first lookup of the operand its line names, and the command's
// own stat and the cache stage reuse its answer, so a cross-mount cp
// re-checks no listing either (it was a head check, and before that a whole
// tree walk, Task 1.3).
const WARM: [string, number, number, number][] = [
  ['cat /m/a.txt', 1, 0, 0],
  ['cat /m/a.txt | head -c 1', 1, 0, 0],
  ['cp /m/a.txt /r/a.txt', 1, 0, 0],
]

describe('hf_hub warm read cost', () => {
  it.each(WARM)('%s costs one path per probe', async (command, posts, walks, heads) => {
    const repo = await hub({ 'a.txt': OLD })
    const w = ws(await vfsOf(repo))
    try {
      await out(w, 'cat /m/a.txt')
      await repo.run.recordRequests()
      await out(w, command)
      expect([
        await repo.count('paths_info'),
        await repo.count('tree'),
        await repo.count('resolve'),
        await repo.count('revision'),
      ]).toEqual([posts, walks, 0, heads])
    } finally {
      await w.close()
    }
  })

  it('a new mount loads its tree once and never asks one path', async () => {
    const repo = await hub({ 'a.txt': OLD })
    const w = ws(await vfsOf(repo), ReadPolicy.BOUNDED)
    try {
      await out(w, 'stat -c %s /m/a.txt')
      await out(w, 'stat -c %s /m/a.txt')
      await out(w, 'ls /m')
      // The fill resolves the head it walks the tree at (Task 1.3).
      expect([
        await repo.count('tree'),
        await repo.count('paths_info'),
        await repo.count('revision'),
      ]).toEqual([1, 0, 1])
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
    const repo = await hub({ 'a.txt': OLD })
    if (override !== null) {
      // The bytes' own answer with its ETag changed: one that names none of
      // the row's ids.
      await repo.run.answerNext('GET', BRIDGE, 206, OLD.slice(2, 5), 1, undefined, undefined, 0, {
        ETag: `"${override}"`,
        'Content-Range': `bytes 2-4/${String(OLD.length)}`,
        'Content-Type': 'application/octet-stream',
      })
    }
    const vfs = await vfsOf(repo)
    const spec = new PathSpec({ virtual: '/a.txt', directory: '/', vfsPath: 'a.txt' })
    let data: Uint8Array
    let records: { fingerprint: string | null }[]
    try {
      const accessor = vfs.accessor as HfHubAccessor
      const row = await rowAt(accessor, spec)
      ;[data, records] = await recordingScope(() =>
        read(accessor, spec, { offset: 2, size: 3 }, row),
      )
    } finally {
      await vfs.close()
    }
    expect(data).toEqual(OLD.slice(2, 5))
    expect(records.map((r) => r.fingerprint)).toEqual(expected ? [blobOid(OLD)] : [null])
  })
})
