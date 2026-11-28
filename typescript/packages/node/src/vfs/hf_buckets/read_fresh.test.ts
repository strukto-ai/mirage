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

import { materialize } from '@struktoai/mirage-core/io/types'
import { createHash } from 'node:crypto'
import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import type { RAMFileCacheStore } from '@struktoai/mirage-core/cache/file/ram'
import { DEFAULT_READ_TTL, MountMode, PathSpec, ReadPolicy } from '@struktoai/mirage-core/types'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { ContentDriftError } from '@struktoai/mirage-core/workspace/snapshot/drift'
import { toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { HfBucket } from '../../../tests/fixtures/hf_bucket.ts'
import { Workspace } from '../../workspace.ts'
import { buildVfs } from '../registry.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const OLD = ENC.encode('version one\n')
const NEW = ENC.encode('version two, longer\n')

let origin = ''
let buckets: HfBucket[] = []

beforeAll(async () => {
  origin = await serve('hf')
})

afterEach(async () => {
  // A stat or read that fell back to opendal would answer the same bytes, so
  // only the request list can tell.
  const watched = buckets
  buckets = []
  for (const b of watched) {
    const reads = await b.count('opendal_read')
    await b.close()
    expect(reads).toBe(0)
  }
})

// A bucket of its own after another client wrote `files` to it, the requests
// recorded from then on.
async function bucket(files: Record<string, Uint8Array>): Promise<HfBucket> {
  const b = new HfBucket(origin)
  buckets.push(b)
  await b.reset()
  await b.put(files)
  await b.run.recordRequests()
  return b
}

function vfsOf(b: HfBucket, extra: Record<string, string> = {}): Promise<BaseVFS> {
  return buildVfs('hf_buckets', b.fields(extra))
}

function ws(vfs: BaseVFS, policy: ReadPolicy = ReadPolicy.FRESH): Workspace {
  return new Workspace(
    {
      '/m': new Mount(vfs, { mode: MountMode.WRITE, read: { policy, ttl: DEFAULT_READ_TTL } }),
      '/r': [new RAMVFS(), MountMode.WRITE],
    },
    { cache: {} },
  )
}

async function out(workspace: Workspace, command: string, stdin?: Uint8Array): Promise<Uint8Array> {
  const result = await workspace.shell(command, stdin === undefined ? {} : { stdin })
  expect([result.exitCode, DEC.decode(result.stderr)], command).toEqual([0, ''])
  return result.stdout
}

function storedFingerprint(workspace: Workspace, path: string): string | null | undefined {
  const cache = workspace.cache as unknown as RAMFileCacheStore
  return cache.snapshotEntries().find((e) => e.key === path)?.entry.fingerprint
}

describe('hf_buckets under read: fresh', () => {
  it('heals a written path in one read', async () => {
    // #1138. A bucket write stamps no token (opendal reports none, and #1101
    // Phase 1 adds no stat after a write), so the written entry verifies
    // against nothing: the first fresh read refetches once, and that read's
    // stamp makes every read after it warm.
    const b = await bucket({})
    const w = ws(await vfsOf(b))
    try {
      await out(w, 'tee /m/w.txt', ENC.encode('hi\n'))
      const writes = w.records
        .filter((r) => !r.isCache && r.op === 'write')
        .map((r) => r.fingerprint)
      expect(writes).toEqual([null])
      // Absent, not merely different: an invented token would pass a check
      // that only compared it with the xet hash.
      expect(storedFingerprint(w, '/m/w.txt') ?? null).toBeNull()
      expect(
        await w.cache.isFresh('/m/w.txt', createHash('md5').update('hi\n').digest('hex')),
      ).toBe(false)
      const before = await b.count('resolve')
      expect(DEC.decode(await out(w, 'cat /m/w.txt'))).toBe('hi\n')
      expect(await b.count('resolve')).toBe(before + 1)
      expect(DEC.decode(await out(w, 'cat /m/w.txt'))).toBe('hi\n')
      expect(await b.count('resolve')).toBe(before + 1)
    } finally {
      await w.close()
    }
  })

  it.each([
    [401, ''],
    [404, 'RepoNotFound'],
  ])('keeps the overlay when the probe is refused (%i %s)', async (status, code) => {
    const b = await bucket({ 'a.txt': OLD })
    const w = ws(await vfsOf(b))
    try {
      await out(w, 'cat /m/a.txt')
      await w.namespace.setAttrs('/m/a.txt', { mode: 0o600 })
      await b.refuse('paths_info', status, code)
      // Cross-mount cp reads through the dispatcher, the dispatcher whose "no such
      // file" drops the overlay; a plain cat never reaches it.
      const cp = await w.shell('cp /m/a.txt /r/x')
      expect(cp.exitCode).toBe(1)
      expect(DEC.decode(cp.stderr)).toBe("cp: cannot stat '/m/a.txt': Permission denied\n")
      await b.run.clearAnswers()
      expect(w.namespace.metaFor('/m/a.txt')?.mode).toBe(0o600)
    } finally {
      await w.close()
    }
  })

  it('keeps the overlay on a download 404 that is not EntryNotFound', async () => {
    const b = await bucket({ 'a.txt': OLD })
    const w = ws(await vfsOf(b))
    try {
      await out(w, 'cat /m/a.txt')
      await w.namespace.setAttrs('/m/a.txt', { mode: 0o600 })
      await w.cache.remove('/m/a.txt')
      // A CDN-shaped 404 carries no error code: it is a failed download, not a
      // deleted file. Measured on the first green run: the raw Hub error.
      await b.refuse('resolve', 404, '')
      const cp = await w.shell('cp /m/a.txt /r/x')
      expect([cp.exitCode, DEC.decode(cp.stderr)]).toEqual([1, 'cp: fake resolve refused\n'])
      expect(w.namespace.metaFor('/m/a.txt')?.mode).toBe(0o600)
    } finally {
      await w.close()
    }
  })

  it('does not let a gated bucket hide the other mounts', async () => {
    const b = await bucket({ 'a.txt': ENC.encode('needle\n') })
    await b.refuse('resolve', 403, '')
    const w = new Workspace({
      '/m': [await vfsOf(b), MountMode.READ],
      '/r': [new RAMVFS(), MountMode.WRITE],
    })
    try {
      await out(w, 'tee /r/n.txt', ENC.encode('needle\n'))
      const grep = await w.shell('grep -r needle /')
      expect(DEC.decode(grep.stdout)).toBe('/r/n.txt:needle\n')
      expect(DEC.decode(grep.stderr)).toContain('Permission denied')
      const cat = await w.shell('cat /m/a.txt')
      expect(cat.exitCode).toBe(1)
      expect(DEC.decode(cat.stderr)).toBe('cat: /m/a.txt: Permission denied\n')
    } finally {
      await w.close()
    }
  })

  // `ls` of a file reaches paths-info through the listing's file probe
  // (object_store readdir `probeFile`); find and du answer from the opendal
  // listing alone, so only the dispatcher can mistake a refusal for an absence.
  it('never lists a refused bucket as absent', async () => {
    const b = await bucket({ 'a.txt': OLD })
    await b.refuse('paths_info', 401, '')
    const vfs = await vfsOf(b)
    const w = ws(vfs, ReadPolicy.BOUNDED)
    try {
      const result = await w.shell('ls /m/a.txt')
      // The raw refusal, never "No such file"; pinned on the first green run.
      expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([
        1,
        'ls: fake paths_info refused\n',
      ])
      expect((await w.mount('/m').indexStore.get('/m/a.txt')).entry ?? null).toBeNull()
    } finally {
      await w.close()
    }
  })

  it('leaves find its whole prefixed listing after a probe', async () => {
    // A fresh probe stats through a throwaway index and writes nothing back,
    // so a find after a warm read still lists the whole prefixed subtree.
    const b = await bucket({
      'pfx/a.txt': OLD,
      'pfx/sub/b.txt': NEW,
      'a.txt': ENC.encode('decoy\n'),
    })
    const w = ws(await vfsOf(b, { keyPrefix: 'pfx/' }))
    try {
      expect(DEC.decode(await out(w, 'cat /m/a.txt'))).toBe(DEC.decode(OLD))
      expect(DEC.decode(await out(w, 'cat /m/a.txt'))).toBe(DEC.decode(OLD))
      expect(DEC.decode(await out(w, 'find /m'))).toBe('/m\n/m/a.txt\n/m/sub\n/m/sub/b.txt\n')
    } finally {
      await w.close()
    }
  })
})

// Measured on the first green run, then pinned (test plan T23): the operand
// probe, at the command's first lookup of its operand; the handler's own stat
// and the cache stage reuse its answer.
const WARM: [string, string, number][] = [
  ['', 'cat /m/a.txt', 1],
  ['ls /m', 'cat /m/a.txt', 1],
  ['', 'cat /m/a.txt | head -c 1', 1],
  ['', 'cp /m/a.txt /r/a.txt', 1],
]

describe('hf_buckets warm read cost', () => {
  it.each(WARM)('%s; %s costs paths-info and no download', async (prep, command, posts) => {
    const b = await bucket({ 'a.txt': OLD })
    const w = ws(await vfsOf(b))
    try {
      await out(w, 'cat /m/a.txt')
      if (prep !== '') await out(w, prep)
      await b.run.recordRequests()
      await out(w, command)
      expect([await b.count('paths_info'), await b.count('resolve')]).toEqual([posts, 0])
    } finally {
      await w.close()
    }
  })
})

async function pinnedState(b: HfBucket) {
  const w = ws(await vfsOf(b))
  try {
    await out(w, 'cat /m/a.txt')
    return await toStateDict(w)
  } finally {
    await w.close()
  }
}

async function load(
  state: Awaited<ReturnType<typeof toStateDict>>,
  vfs: BaseVFS,
  command = 'cat /m/a.txt',
): Promise<void> {
  // The drift check drains on the first command after the load.
  const loaded = await Workspace.fromState(state, {}, { '/m': vfs })
  try {
    await out(loaded, command)
  } finally {
    await loaded.close()
  }
}

describe('hf_buckets snapshot pins', () => {
  it('pins a read, and a changed file drifts', async () => {
    const b = await bucket({ 'a.txt': OLD })
    const state = await pinnedState(b)
    await b.put({ 'a.txt': NEW })
    await expect(load(state, await vfsOf(b))).rejects.toBeInstanceOf(ContentDriftError)
  })

  it('pins the read own token', async () => {
    const b = await bucket({ 'a.txt': OLD })
    await b.serveEtag(OLD, '"other"')
    const state = await pinnedState(b)
    // Upstream never changed; the pin is what the read vouched for, and stat's
    // token differs from it, which the check reports.
    const err = await load(state, await vfsOf(b)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContentDriftError)
    expect((err as ContentDriftError).liveFingerprint).toBe((await b.row('a.txt')).xetHash)
  })

  it('does not call a refused drift check drift', async () => {
    const b = await bucket({ 'a.txt': OLD })
    const state = await pinnedState(b)
    await b.refuse('paths_info', 401, '')
    const err = await load(state, await vfsOf(b)).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('EACCES')
  })

  it('loads an unchanged file on one paths-info', async () => {
    const b = await bucket({ 'a.txt': OLD })
    const state = await pinnedState(b)
    await b.run.recordRequests()
    await load(state, await vfsOf(b), 'true')
    expect([await b.count('paths_info'), await b.count('resolve')]).toEqual([1, 0])
  })

  it('drifts to nothing for a file deleted upstream', async () => {
    const b = await bucket({ 'a.txt': OLD })
    const state = await pinnedState(b)
    await b.remove('a.txt')
    const err = await load(state, await vfsOf(b), 'true').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContentDriftError)
    expect((err as ContentDriftError).liveFingerprint ?? null).toBeNull()
  })
})

describe('hf_buckets past EOF', () => {
  it('reads a window past EOF as empty on every entry point', async () => {
    const b = await bucket({ 'a.txt': ENC.encode('abc') })
    const vfs = await vfsOf(b)
    const w = ws(vfs, ReadPolicy.BOUNDED)
    const spec = new PathSpec({ virtual: '/m/a.txt', directory: '/m/', vfsPath: 'a.txt' })
    try {
      // The dispatcher folds a 416 for every backend; the VFS's own windowed
      // read has no fold, so it must answer one itself.
      const viaOp = (await w.mount('/m').callKeyed('read', spec, [], {
        index: new RAMIndexCacheStore(),
        offset: 99,
        size: 5,
      })) as Uint8Array
      expect(viaOp.byteLength).toBe(0)
      const direct = await materialize(await vfs.read(spec, undefined, 99, 5))
      expect(direct.byteLength).toBe(0)
    } finally {
      await w.close()
    }
  })
})
