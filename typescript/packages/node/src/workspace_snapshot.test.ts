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

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Accessor } from '@struktoai/mirage-core/accessor/base'
import { BaseVFS, type VFSStateBase } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS, type RAMVFSState } from '@struktoai/mirage-core/vfs/ram/ram'
import type { RAMFileCacheStore } from '@struktoai/mirage-core/cache/file/ram'
import {
  ContentType,
  DEFAULT_READ_SPEC,
  FileStat,
  FileType,
  Limit,
  MountMode,
  type PathSpec,
  ReadPolicy,
  WritePolicy,
} from '@struktoai/mirage-core/types'
import { ALL_COMMANDS } from '@struktoai/mirage-core/policy/builtin/output_cap'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { MountOverrideError } from '@struktoai/mirage-core/workspace/mount/errors'
import { MountKey } from '@struktoai/mirage-core/workspace/snapshot/keys'
import {
  applyStateDict,
  buildMountArgs,
  toStateDict,
} from '@struktoai/mirage-core/workspace/snapshot/state'
import { DiskVFS } from './vfs/disk/disk.ts'
import { RedisVFS } from './vfs/redis/redis.ts'
import { buildVfs, registerVfs } from './vfs/registry.ts'
import type { WorkspaceStateDict } from '@struktoai/mirage-core/workspace/snapshot/types'
import { conditionalS3, s3Vfs } from '../tests/test-utils.ts'
import { Workspace } from './workspace.ts'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'

const ENC = new TextEncoder()

class NotesAccessor extends Accessor {
  constructor(public pages: Record<string, string>) {
    super()
  }
}

function key(path: PathSpec): string {
  return stripSlash(path.vfsPath)
}

/** A page per file, read from the accessor's pages. */
class NotesVFS extends BaseVFS<NotesAccessor> {
  override readdir(): Promise<FileStat[]> {
    return Promise.resolve(
      Object.entries(this.accessor.pages)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(
          ([name, page]) =>
            new FileStat({
              name,
              size: ENC.encode(page).length,
              type: FileType.FILE,
              content: ContentType.TEXT,
            }),
        ),
    )
  }

  override read(path: PathSpec): Promise<Uint8Array> {
    const page = this.accessor.pages[key(path)]
    if (page === undefined) throw enoent(path)
    return Promise.resolve(ENC.encode(page))
  }

  override stat(path: PathSpec): Promise<FileStat> {
    const k = key(path)
    const name = rstripSlash(path.virtual).split('/').pop() ?? '/'
    if (k === '')
      return Promise.resolve(new FileStat({ name: '/', size: null, type: FileType.DIRECTORY }))
    const page = this.accessor.pages[k]
    if (page === undefined) throw enoent(path)
    return Promise.resolve(
      new FileStat({
        name,
        size: ENC.encode(page).length,
        type: FileType.FILE,
        content: ContentType.TEXT,
      }),
    )
  }
}

/** Content the VFS owns rides its state, so a version restores it. */
class Notes extends NotesVFS {
  readonly notes: NotesAccessor

  constructor(pages: Record<string, string> = {}) {
    const notes = new NotesAccessor({ ...pages })
    super({ name: 'notes-test', accessor: notes })
    this.notes = notes
  }

  override getState(): VFSStateBase & { pages: Record<string, string> } {
    return { type: this.name, pages: { ...this.notes.pages } }
  }

  override loadState(state: VFSStateBase): void {
    const pages = (state as { pages?: Record<string, string> }).pages
    this.notes.pages = { ...(pages ?? {}) }
  }
}

/** Keeps the default state, so it has to be handed back live. */
class Bare extends NotesVFS {
  constructor() {
    super({ name: 'bare-test', accessor: new NotesAccessor({}) })
  }
}

/** Inherits `kind`, so its state reports the builtin's `ram` type. */
class SeededRAM extends RAMVFS {}

/** A RAM VFS that asks to be handed back live. */
class LiveRAM extends RAMVFS {
  override getState(): RAMVFSState {
    // Through a variable: the literal fails RAMVFSState's excess-property check.
    const state = { ...super.getState(), needs_override: true }
    return state
  }
}

/** A live VFS whose state, like S3's, carries no content. */
class ConfigOnlyRAM extends RAMVFS {
  override getState(): RAMVFSState {
    return { type: 'ram', needs_override: true } as unknown as RAMVFSState
  }

  override loadState(): void {
    return
  }
}

async function rootOnLive(live: RAMVFS): Promise<Workspace> {
  const ws = new Workspace({ '/a': new RAMVFS() }, { mode: MountMode.WRITE })
  let state: WorkspaceStateDict
  try {
    ws.addMount('/x', ws.mount('/').vfs, MountMode.WRITE)
    state = await toStateDict(ws)
  } finally {
    await ws.close()
  }
  return Workspace.fromState(state, {}, { '/x': live })
}

/** Counts the states loaded into it. */
class CountingRAM extends RAMVFS {
  loads = 0

  override loadState(state: RAMVFSState): void {
    this.loads += 1
    super.loadState(state)
  }
}

describe('snapshot rebuild through the registry', () => {
  it('rebuilds a registered content VFS from its saved state, no override', async () => {
    registerVfs('notes-test', () => Promise.resolve(new Notes()))
    const ws = new Workspace({ '/n/': new Notes({ 'a.md': 'one\n' }) }, { mode: MountMode.READ })
    const state = await toStateDict(ws)
    await ws.close()
    const [mount] = state.mounts
    if (mount === undefined) throw new Error('snapshot recorded no mounts')
    expect(mount.vfs_state).toEqual({ type: 'notes-test', pages: { 'a.md': 'one\n' } })
    // Constructed in code, so no registry reference was stamped: the
    // loader reaches the class through the registered name alone.
    expect(mount[MountKey.VFS_REF]).toBeNull()
    const restored = await Workspace.fromState(state)
    try {
      const out = await restored.shell('cat /n/a.md')
      expect(out.stdoutText).toBe('one\n')
      const notes = restored.mounts().find((m) => m.prefix === '/n/')
      expect(notes?.vfs).toBeInstanceOf(Notes)
    } finally {
      await restored.close()
    }
  })

  it('still asks for a generic VFS that keeps its default state', async () => {
    const ws = new Workspace({ '/b/': new Bare() }, { mode: MountMode.READ })
    const state = await toStateDict(ws)
    await ws.close()
    expect(state.mounts[0]?.vfs_state).toEqual({ type: 'bare-test', needs_override: true })
    expect(() => buildMountArgs(state)).toThrow(/mounts= must include overrides for: \/b\//)
    await expect(Workspace.fromState(state)).rejects.toThrow(/mounts= must include/)
  })

  // A config-only state loads into an override of another backend that
  // keeps content: the loader finds no files in it and loads none, where
  // disk and redis threw on the missing files. Mirrors the Python test of
  // the same name.
  it('a config-only state loads into an override keeping content', async () => {
    const ws = new Workspace({ '/b/': new Bare() }, { mode: MountMode.READ })
    const state = await toStateDict(ws)
    await ws.close()
    const root = await mkdtemp(join(tmpdir(), 'mirage-config-only-'))
    try {
      const restored = await Workspace.fromState(state, {}, { '/b/': new DiskVFS({ root }) })
      try {
        expect((await restored.shell('ls /b/')).exitCode).toBe(0)
        expect(await readdir(root)).toEqual([])
      } finally {
        await restored.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  const REDIS_URL = process.env.REDIS_URL
  it.skipIf(REDIS_URL === undefined)(
    'a config-only state loads into a redis override',
    async () => {
      const ws = new Workspace({ '/b/': new Bare() }, { mode: MountMode.READ })
      const state = await toStateDict(ws)
      await ws.close()
      const redis = new RedisVFS({
        ...(REDIS_URL !== undefined ? { url: REDIS_URL } : {}),
        keyPrefix: `mirage:fs:config-only:${String(Date.now())}:`,
      })
      try {
        const restored = await Workspace.fromState(state, {}, { '/b/': redis })
        try {
          expect((await restored.shell('ls /b/')).exitCode).toBe(0)
          expect(await redis.store.listFiles()).toEqual([])
        } finally {
          await restored.close()
        }
      } finally {
        await redis.store.clear()
        await redis.close()
      }
    },
  )

  it('records the reference a mount was placed with', async () => {
    const ws = new Workspace(
      { '/n/': new Mount(new Notes(), { vfsRef: 'notes-test' }), '/b/': new Notes() },
      { mode: MountMode.READ },
    )
    try {
      expect(ws.mount('/n/').vfsRef).toBe('notes-test')
      expect(ws.mount('/b/').vfsRef).toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('rebuilds an alias over a builtin through its ref, not its type', async () => {
    registerVfs('seeded-test', () => Promise.resolve(new SeededRAM()))
    const ws = new Workspace(
      { '/s/': new Mount(await buildVfs('seeded-test'), { vfsRef: 'seeded-test' }) },
      { mode: MountMode.WRITE },
    )
    await ws.shell('echo one > /s/a.txt')
    const state = await toStateDict(ws)
    await ws.close()
    const [mount] = state.mounts
    if (mount === undefined) throw new Error('snapshot recorded no mounts')
    // The type alone names RAMVFS, which is what the mount used to
    // come back as; the ref is the entry point it was declared through.
    expect(mount.vfs_state.type).toBe('ram')
    expect(mount[MountKey.VFS_REF]).toBe('seeded-test')
    const restored = await Workspace.fromState(state)
    try {
      const seeded = restored.mounts().find((m) => m.prefix === '/s/')
      expect(seeded?.vfs).toBeInstanceOf(SeededRAM)
      expect(seeded?.vfsRef).toBe('seeded-test')
      const out = await restored.shell('cat /s/a.txt')
      expect(out.stdoutText).toBe('one\n')
    } finally {
      await restored.close()
    }
  })

  it('refuses a ref it cannot resolve rather than guessing from the type', async () => {
    const ws = new Workspace({ '/s/': new RAMVFS() }, { mode: MountMode.READ })
    const state = await toStateDict(ws)
    await ws.close()
    const [mount] = state.mounts
    if (mount === undefined) throw new Error('snapshot recorded no mounts')
    // Saved by a process that had an alias registered; this one has not,
    // and the type would only say RAMVFS.
    mount.vfs_ref = 'ghost-test'
    await expect(Workspace.fromState(state)).rejects.toThrow(
      /mounts= must include overrides for: \/s\//,
    )
  })
})

// Twin of test_a_rebuilt_local_mount_keeps_its_walk_limit: a disk
// mount comes back as RAM held to the workspace's or its own limit.
describe('a rebuilt disk mount', () => {
  it.each([
    [2, 'workspace'],
    [-1, 'workspace'],
    [2, 'mount'],
    [-1, 'mount'],
  ])('keeps its walk limit (%d, %s)', async (limit, scope) => {
    const root = await mkdtemp(join(tmpdir(), 'mirage-limit-'))
    const commandLimits = { [ALL_COMMANDS]: new Limit({ walkLimit: limit }) }
    const vfs = new DiskVFS({ root })
    const ws =
      scope === 'workspace'
        ? new Workspace({ '/d': vfs }, { commandLimits })
        : new Workspace({ '/d': new Mount(vfs, { commandLimits }) })
    try {
      const restored = await Workspace.fromState(await toStateDict(ws))
      try {
        expect(restored.mount('/d/').vfs.walkLimit).toBe(limit)
      } finally {
        await restored.close()
      }
    } finally {
      await ws.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function savedState(
  mounts: Record<string, BaseVFS | Mount>,
  write: WritePolicy = WritePolicy.UNCONDITIONAL,
): Promise<WorkspaceStateDict> {
  const ws = new Workspace(mounts, { mode: MountMode.WRITE, write })
  try {
    return await toStateDict(ws)
  } finally {
    await ws.close()
  }
}

describe('the write policy in a snapshot', () => {
  const built: Workspace[] = []
  function track(ws: Workspace): Workspace {
    built.push(ws)
    return ws
  }
  afterEach(async () => {
    for (const ws of built.splice(0).reverse()) await ws.close()
  })
  it.each(['state', 'copy'])('survives the %s entry point', async (route) => {
    // Two mounts with two values and a workspace default for later mounts.
    const ws = track(
      new Workspace(
        {
          '/s3': s3Vfs(),
          '/d': new Mount(new RAMVFS(), { mode: MountMode.WRITE, write: 'unconditional' }),
        },
        { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL },
      ),
    )
    const back = track(
      route === 'copy'
        ? await ws.copy()
        : await Workspace.fromState(
            await toStateDict(ws),
            { mode: MountMode.WRITE },
            { '/s3/': s3Vfs() },
          ),
    )
    expect(back.mount('/s3/').write).toBe(WritePolicy.CONDITIONAL)
    expect(back.mount('/d/').write).toBe(WritePolicy.UNCONDITIONAL)
    expect(back.addMount('/more', s3Vfs(), MountMode.WRITE).write).toBe(WritePolicy.CONDITIONAL)
  })

  it.each([
    ['cannot honour', () => new RAMVFS(), 'ram does not'],
    [
      'names another',
      () => new Mount(s3Vfs(), { mode: MountMode.WRITE, write: WritePolicy.UNCONDITIONAL }),
      'saved write: conditional',
    ],
  ] as const)(
    'refuses a load override that %s the saved policy',
    async (_name, override, message) => {
      // Unlike read, the saved write policy is kept: an override is refused.
      const state = await savedState({ '/s3': conditionalS3() })
      await expect(
        Workspace.fromState(state, { mode: MountMode.WRITE }, { '/s3/': override() }),
      ).rejects.toThrow(message)
    },
  )

  it.each([
    ['mount', undefined, 'missing its write policy'],
    ['mount', 1, "unknown write policy '1'"],
    ['mount', 'staged', 'write: staged needs a staging layer'],
    ['mount', 'conditional', 'ram does not'],
    ['workspace', undefined, 'missing its workspace write policy'],
    ['workspace', 1, "unknown write policy '1'"],
  ] as const)('judges a saved %s write policy at load: %j', async (level, value, message) => {
    // A value no writer of ours would emit is refused, never cast.
    const state = await savedState({ '/d': new RAMVFS() })
    const holder = (level === 'mount'
      ? state.mounts.find((m) => m.prefix === '/d/')
      : state) as unknown as Record<string, unknown>
    if (value === undefined) delete holder.write
    else holder.write = value
    await expect(Workspace.fromState(state, { mode: MountMode.WRITE })).rejects.toThrow(message)
  })

  it('refuses an option naming another default', async () => {
    const state = await savedState(
      { '/d': new Mount(new RAMVFS(), { mode: MountMode.WRITE, write: 'unconditional' }) },
      WritePolicy.CONDITIONAL,
    )
    await expect(
      Workspace.fromState(state, { mode: MountMode.WRITE, write: 'unconditional' }),
    ).rejects.toThrow('saved write: conditional')
  })

  it('keeps the saved default when an option leaves write undefined', async () => {
    // A JS caller or a looser tsconfig can spread write: undefined in.
    const state = await savedState(
      { '/d': new Mount(new RAMVFS(), { mode: MountMode.WRITE, write: 'unconditional' }) },
      WritePolicy.CONDITIONAL,
    )
    const options = { mode: MountMode.WRITE, write: undefined } as unknown as Parameters<
      typeof Workspace.fromState
    >[1]
    const restored = track(await Workspace.fromState(state, options))
    expect(restored.addMount('/more', s3Vfs(), MountMode.WRITE).write).toBe(WritePolicy.CONDITIONAL)
  })

  it('leaves a version kept without bytes out', async () => {
    // It has no bytes to restore; captured, it would come back an empty file.
    const ws = track(new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE }))
    await ws.cache.set('/d/a', new TextEncoder().encode('bytes'), { fingerprint: 'v1' })
    await ws.cache.keepFingerprints({ '/d/b': 'v2' })
    const state = await toStateDict(ws)
    expect(state.cache.entries.map((e) => e.key)).toEqual(['/d/a'])
  })
})

// One VFS mounted at two prefixes stays one store through a copy or a load:
// a write through one shows at the other.
describe('a VFS mounted at several prefixes', () => {
  it.each([
    ['ram', 'copy'],
    ['ram', 'load'],
    ['disk', 'copy'],
    ['disk', 'load'],
  ])('stays one store (%s, %s)', async (backend, route) => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-same-vfs-'))
    try {
      const vfs = backend === 'ram' ? new RAMVFS() : new DiskVFS({ root: join(dir, 'd') })
      const ws = new Workspace({ '/a': vfs, '/b': vfs }, { mode: MountMode.WRITE })
      let restored: Workspace
      try {
        expect((await ws.shell('echo old > /a/x')).exitCode).toBe(0)
        if (route === 'copy') {
          restored = await ws.copy()
        } else {
          await ws.snapshot(join(dir, 's.tar'))
          restored = await Workspace.load(join(dir, 's.tar'))
        }
      } finally {
        await ws.close()
      }
      try {
        expect(restored.mount('/a/').vfs).toBe(restored.mount('/b/').vfs)
        expect((await restored.shell('echo hi > /b/x')).exitCode).toBe(0)
        expect((await restored.shell('cat /a/x')).stdoutText).toBe('hi\n')
      } finally {
        await restored.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // A registered VFS is rebuilt through the registry once, at the first
  // prefix, or not at all when an override for any prefix supplies it.
  it.each([
    ['no override', false],
    ['an override at the later prefix', true],
  ])('rebuilds a registered VFS once (%s)', async (_label, overridden) => {
    registerVfs('notes-test', () => Promise.resolve(new Notes()))
    const notes = new Notes({ 'a.md': 'one\n' })
    const state = await savedState({ '/a': notes, '/b': notes })
    const standIn = new Notes()
    const restored = await Workspace.fromState(state, {}, overridden ? { '/b/': standIn } : {})
    try {
      const vfs = restored.mount('/a/').vfs
      expect(vfs).toBeInstanceOf(Notes)
      expect(restored.mount('/b/').vfs).toBe(vfs)
      if (overridden) expect(vfs).toBe(standIn)
    } finally {
      await restored.close()
    }
  })

  it('names the first prefix of its store on every later row', async () => {
    const shared = new RAMVFS()
    const state = await savedState({ '/a': shared, '/b': shared, '/c': new RAMVFS() })
    const rows = Object.fromEntries(state.mounts.map((m) => [m.prefix, m]))
    expect(rows['/a/']).not.toHaveProperty(MountKey.SAME_VFS_AS)
    expect(rows['/b/']?.same_vfs_as).toBe('/a/')
    expect(rows['/c/']).not.toHaveProperty(MountKey.SAME_VFS_AS)
  })

  // An override for one prefix supplies the store for every prefix of the
  // group with none of its own, and that prefix then sits on the
  // override's backend, so it takes the default read policy as the
  // overridden one does.
  it.each([
    ['/a/', '/b/'],
    ['/b/', '/a/'],
  ])('takes an override for %s as the store of all', async (named, other) => {
    const s3 = s3Vfs()
    const ws = new Workspace(
      { '/a': s3, '/b': s3 },
      { mode: MountMode.WRITE, read: { policy: ReadPolicy.FRESH, ttl: 600 } },
    )
    let state: WorkspaceStateDict
    try {
      state = await toStateDict(ws)
    } finally {
      await ws.close()
    }
    const standIn = new RAMVFS()
    const commandLimits = { cat: new Limit({ maxLines: 1 }) }
    const restored = await Workspace.fromState(
      state,
      {},
      { [named]: new Mount(standIn, { commandLimits }) },
    )
    try {
      expect(restored.mount(other).vfs).toBe(standIn)
      expect(restored.mount(named).read).toEqual(DEFAULT_READ_SPEC)
      expect(restored.mount(other).read).toEqual(DEFAULT_READ_SPEC)
      expect(restored.mount(named).commandLimits.size).toBe(1)
      expect(restored.mount(other).commandLimits.size).toBe(0)
    } finally {
      await restored.close()
    }
  })

  it('refuses two overrides for one store that leave the rest ambiguous', async () => {
    const shared = new RAMVFS()
    const state = await savedState({ '/a': shared, '/b': shared, '/c': shared })
    const refused = (): unknown => buildMountArgs(state, { '/a': new RAMVFS(), '/b': new RAMVFS() })
    expect(refused).toThrow(MountOverrideError)
    expect(refused).toThrow(
      'Workspace.load: mounts= gives different VFSs for /a/, /b/, which were saved as one VFS; ' +
        'override /c/ too, or give them all one VFS',
    )
    const same = new RAMVFS()
    expect(buildMountArgs(state, { '/a': same, '/b': same }).mountArgs['/c/']?.vfs).toBe(same)
    const split = buildMountArgs(state, {
      '/a': new RAMVFS(),
      '/b': new RAMVFS(),
      '/c': new RAMVFS(),
    })
    expect(new Set(['/a/', '/b/', '/c/'].map((p) => split.mountArgs[p]?.vfs)).size).toBe(3)
  })

  it.each([
    ['/nope/', '/nope/'],
    ['/b/', '/b/'],
    ['/c/', '/c/'],
    [null, 'null'],
    [['/a/'], '["/a/"]'],
  ])('refuses a row naming %j as its VFS', async (target, shown) => {
    const shared = new RAMVFS()
    const state = await savedState({ '/a': shared, '/b': shared, '/c': shared })
    const row = state.mounts.find((m) => m.prefix === '/c/')
    if (row === undefined) throw new Error('no /c/ row')
    ;(row as { same_vfs_as?: unknown }).same_vfs_as = target
    expect(() => buildMountArgs(state)).toThrow(
      `Workspace.load: mount '/c/' shares the VFS of '${shown}', which no earlier mount ` +
        `leads; regenerate the snapshot`,
    )
  })

  // A checkout loads every saved row into the mount at its prefix, so two
  // separate live mounts each take the saved VFS's state.
  it('loads each of two split mounts on a checkout', async () => {
    const shared = new RAMVFS()
    const source = new Workspace({ '/a': shared, '/b': shared }, { mode: MountMode.WRITE })
    let state: WorkspaceStateDict
    try {
      expect((await source.shell('echo hi > /a/x')).exitCode).toBe(0)
      state = await toStateDict(source)
    } finally {
      await source.close()
    }
    const target = new Workspace(
      { '/a': new RAMVFS(), '/b': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    try {
      await applyStateDict(target, state)
      for (const prefix of ['/a', '/b']) {
        expect((await target.shell(`cat ${prefix}/x`)).stdoutText).toBe('hi\n')
      }
    } finally {
      await target.close()
    }
  })

  // The first saved row of a VFS decides how the load builds it, and every
  // prefix on one VFS carries the label of what supplied it, so the result
  // copies and loads again.
  it('gives a bare override of another class no saved label', async () => {
    const slack = await buildVfs('slack', { token: 'xoxb-secret' })
    const state = await savedState({
      '/a': new Mount(slack, { vfsRef: 'slack' }),
      '/b': new Mount(slack, { vfsRef: 'slack' }),
    })
    const restored = await Workspace.fromState(state, {}, { '/b/': new RAMVFS() })
    try {
      expect(['/a/', '/b/'].map((p) => restored.mount(p).vfsRef)).toEqual([null, null])
      await (await restored.copy()).close()
    } finally {
      await restored.close()
    }
  })

  it('lets the first row decide a VFS saved under two labels', async () => {
    registerVfs('seeded-test', () => Promise.resolve(new SeededRAM()))
    const seeded = new SeededRAM()
    const state = await savedState({
      '/a': seeded,
      '/b': new Mount(seeded, { vfsRef: 'seeded-test' }),
    })
    const restored = await Workspace.fromState(state)
    try {
      expect(restored.mount('/a/').vfs).toBe(restored.mount('/b/').vfs)
      expect(['/a/', '/b/'].map((p) => restored.mount(p).vfsRef)).toEqual([null, null])
    } finally {
      await restored.close()
    }
  })

  // The scratch root nobody mounted stays the anchor; a second prefix on its
  // VFS comes back on the root the load mounts, not on a store of its own.
  it.each(['copy', 'load'])('keeps a second prefix on the scratch root (%s)', async (route) => {
    const ws = new Workspace({ '/a': new RAMVFS() }, { mode: MountMode.WRITE })
    let restored: Workspace
    try {
      ws.addMount('/x', ws.mount('/').vfs, MountMode.WRITE)
      expect((await ws.shell('echo hi > /x/f')).exitCode).toBe(0)
      restored = route === 'copy' ? await ws.copy() : await Workspace.load(await ws.snapshot())
    } finally {
      await ws.close()
    }
    try {
      expect(restored.mount('/x/').vfs).toBe(restored.mount('/').vfs)
      expect((await restored.shell('cat /f')).stdoutText).toBe('hi\n')
      expect(restored.syntheticRoot).toBe(true)
      const root = (await toStateDict(restored)).mounts.find((m) => m.prefix === '/')
      expect(root?.anchor).toBe(true)
    } finally {
      await restored.close()
    }
  })

  it('reaches a scratch root shared with another prefix with the copy mode', async () => {
    const ws = new Workspace({ '/a': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      ws.addMount('/x', ws.mount('/').vfs, MountMode.WRITE)
      const copy = await ws.copy({ mode: MountMode.READ })
      try {
        expect(copy.mount('/').mode).toBe(MountMode.READ)
        expect(copy.mount('/x/').mode).toBe(MountMode.WRITE)
      } finally {
        await copy.close()
      }
    } finally {
      await ws.close()
    }
  })

  it('loads the state of a VFS saved at two prefixes once', async () => {
    const shared = new RAMVFS()
    const state = await savedState({ '/a': shared, '/b': shared })
    const counting = new CountingRAM()
    const restored = await Workspace.fromState(state, {}, { '/a': counting })
    try {
      expect(counting.loads).toBe(1)
    } finally {
      await restored.close()
    }
  })

  it('refuses a bad row on a checkout before it drops the cache', async () => {
    const shared = new RAMVFS()
    const state = await savedState({ '/a': shared, '/b': shared })
    const row = state.mounts.find((m) => m.prefix === '/b/')
    if (row === undefined) throw new Error('no /b/ row')
    row.same_vfs_as = '/nope/'
    const target = new Workspace(
      { '/a': new RAMVFS(), '/b': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    try {
      const cache = target.cache as RAMFileCacheStore
      await cache.set('/a/kept', ENC.encode('kept'))
      await target.vfsMd('/a/VFS.md')
      await expect(applyStateDict(target, state, { replaceCache: true })).rejects.toThrow('/nope/')
      expect(await cache.get('/a/kept')).toEqual(ENC.encode('kept'))
      expect((await target.shell('cat /a/VFS.md')).exitCode).toBe(0)
    } finally {
      await target.close()
    }
  })

  it('refuses a newer format before it reads the rows', async () => {
    const shared = new RAMVFS()
    const state = await savedState({ '/a': shared, '/b': shared })
    const row = state.mounts[1]
    if (row === undefined) throw new Error('no second row')
    row.same_vfs_as = '/nope/'
    await expect(Workspace.fromState({ ...state, version: 999 })).rejects.toThrow(
      'snapshot format v999',
    )
  })

  // A copy hands back the live VFSs it shares, the scratch root's among them,
  // and the root stays the scratch root.
  it('keeps a shared scratch root the scratch root through a copy', async () => {
    const loaded = await rootOnLive(new LiveRAM())
    try {
      const copied = await loaded.copy()
      try {
        expect(copied.mount('/').vfs).toBe(loaded.mount('/x/').vfs)
        expect(copied.syntheticRoot).toBe(true)
      } finally {
        await copied.close()
      }
    } finally {
      await loaded.close()
    }
  })

  it('keeps the label of a VFS rebuilt through it', async () => {
    registerVfs('notes-test', () => Promise.resolve(new Notes()))
    const seeded = new SeededRAM()
    const state = await savedState({
      '/a': new Mount(seeded, { vfsRef: 'notes-test' }),
      '/b': new Mount(seeded, { vfsRef: 'notes-test' }),
    })
    const restored = await Workspace.fromState(state)
    try {
      expect(restored.mount('/a/').vfs).toBeInstanceOf(Notes)
      expect(['/a/', '/b/'].map((p) => restored.mount(p).vfsRef)).toEqual([
        'notes-test',
        'notes-test',
      ])
    } finally {
      await restored.close()
    }
  })

  it('names each saved VFS once when an override is missing', async () => {
    const slack = await buildVfs('slack', { token: 'xoxb-secret' })
    const state = await savedState({ '/a': slack, '/b': slack })
    expect(() => buildMountArgs(state)).toThrow('must include overrides for: /a/. ')
  })

  it('loads each of two saved VFSs into one live VFS', async () => {
    const source = new Workspace(
      { '/a': new RAMVFS(), '/b': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    let state: WorkspaceStateDict
    try {
      expect((await source.shell('echo one > /a/f')).exitCode).toBe(0)
      expect((await source.shell('echo two > /b/f')).exitCode).toBe(0)
      state = await toStateDict(source)
    } finally {
      await source.close()
    }
    const counting = new CountingRAM()
    const restored = await Workspace.fromState(state, {}, { '/a': counting, '/b': counting })
    try {
      expect(counting.loads).toBe(2)
      expect((await restored.shell('cat /a/f')).stdoutText).toBe('two\n')
    } finally {
      await restored.close()
    }
  })

  // The scratch root is restored like any other prefix: a copy hands back
  // the live VFS it sits on, alone or not, and it stays the scratch root.
  it.each([
    ['LiveRAM', () => new LiveRAM()],
    ['ConfigOnlyRAM', () => new ConfigOnlyRAM()],
  ])('shares a scratch root left alone on a live VFS through a copy (%s)', async (_n, live) => {
    const loaded = await rootOnLive(live())
    try {
      expect((await loaded.shell('echo hi > /x/f')).exitCode).toBe(0)
      await loaded.unmount('/x')
      const copied = await loaded.copy()
      try {
        expect(copied.mount('/').vfs).toBe(loaded.mount('/').vfs)
        expect((await copied.shell('cat /f')).stdoutText).toBe('hi\n')
        expect(copied.syntheticRoot).toBe(true)
      } finally {
        await copied.close()
      }
    } finally {
      await loaded.close()
    }
  })

  it('asks for a scratch root left alone on a live VFS on a load', async () => {
    const loaded = await rootOnLive(new LiveRAM())
    let state: WorkspaceStateDict
    try {
      await loaded.unmount('/x')
      state = await toStateDict(loaded)
    } finally {
      await loaded.close()
    }
    await expect(Workspace.fromState(state)).rejects.toThrow('must include overrides for: /. ')
  })

  it('keeps the scratch root the scratch root under an override for it', async () => {
    const state = await savedState({ '/a': new RAMVFS() })
    const root = new RAMVFS()
    const restored = await Workspace.fromState(state, {}, { '/': root })
    try {
      expect(restored.mount('/').vfs).toBe(root)
      expect(restored.syntheticRoot).toBe(true)
      const row = (await toStateDict(restored)).mounts.find((m) => m.prefix === '/')
      expect(row?.anchor).toBe(true)
    } finally {
      await restored.close()
    }
  })

  it('refuses a number even when it names a mount', async () => {
    const shared = new RAMVFS()
    const state = await savedState({ '/5': shared, '/b': shared })
    const row = state.mounts.find((m) => m.prefix === '/b/')
    if (row === undefined) throw new Error('no /b/ row')
    ;(row as { same_vfs_as?: unknown }).same_vfs_as = 5
    expect(() => buildMountArgs(state)).toThrow("shares the VFS of '5'")
  })

  // A scratch root takes the workspace's index, as the root a workspace adds
  // does, so a redacted index asks for no override at a prefix nobody mounted.
  it('restores a scratch root under a redacted index without asking for it', async () => {
    const index = { type: 'redis' as const, url: 'redis://u:pw@localhost:6379/0', ttl: 37 }
    const vfs = new RAMVFS()
    const ws = new Workspace({ '/a': vfs }, { mode: MountMode.WRITE, index })
    let state: WorkspaceStateDict
    try {
      state = await toStateDict(ws)
    } finally {
      await ws.close()
    }
    const args = buildMountArgs(state, { '/a/': new Mount(new RAMVFS(), { index }) })
    expect(args.mountArgs['/']).toBeDefined()
    expect(args.anchored).toBe(true)
  })

  // The scratch root keeps an index of its own across round trips; one it
  // only inherits from the workspace is not saved, so it is never asked for.
  it.each(['copy', 'load'])("keeps the scratch root's own index through a %s", async (route) => {
    const state = await savedState({ '/a': new RAMVFS() })
    const index = { type: 'ram' as const, ttl: 41 }
    const loaded = await Workspace.fromState(state, {}, { '/': new Mount(new RAMVFS(), { index }) })
    let restored: Workspace
    try {
      restored =
        route === 'copy'
          ? await loaded.copy()
          : await Workspace.fromState(await toStateDict(loaded))
    } finally {
      await loaded.close()
    }
    try {
      expect(restored.mount('/').indexConfig?.ttl).toBe(41)
    } finally {
      await restored.close()
    }
  })

  it('ignores a scratch root marker off the root', async () => {
    const state = await savedState({ '/data': new RAMVFS() })
    for (const row of state.mounts) {
      if (row.prefix === '/data/') row.anchor = true
      if (row.prefix === '/') delete row.anchor
    }
    expect(buildMountArgs(state).anchored).toBeUndefined()
  })

  // A VFS shared by several prefixes runs one index, the first prefix's, so
  // an override's index serves every prefix and none asks for credentials.
  it.each(['/a/', '/b/'])(
    "serves every prefix of a VFS with an override's index (%s)",
    async (named) => {
      const shared = new RAMVFS()
      const redis = { type: 'redis' as const, url: 'redis://u:pw@localhost:6379/0', ttl: 30 }
      const state = await savedState({ '/a': new Mount(shared, { index: redis }), '/b': shared })
      const fresh = { type: 'ram' as const, ttl: 5 }
      const args = buildMountArgs(state, { [named]: new Mount(new RAMVFS(), { index: fresh }) })
      expect(args.mountArgs['/a/']?.options.index?.ttl).toBe(5)
    },
  )

  it("keeps a scratch root's own index equal to the workspace's through a copy", async () => {
    const index = { type: 'ram' as const, ttl: 41 }
    const state = await savedState({ '/a': new RAMVFS() })
    const loaded = await Workspace.fromState(
      state,
      { index },
      { '/': new Mount(new RAMVFS(), { index }) },
    )
    try {
      const copied = await loaded.copy()
      try {
        expect(copied.mount('/').indexConfig?.ttl).toBe(41)
      } finally {
        await copied.close()
      }
    } finally {
      await loaded.close()
    }
  })

  it.each([[['/a/', '/b/']], [['/b/', '/a/']]])(
    "takes the first saved prefix's override index (%j)",
    async (order) => {
      const shared = new RAMVFS()
      const state = await savedState({ '/a': shared, '/b': shared })
      const live = new RAMVFS()
      const given: Record<string, Mount> = {
        '/a/': new Mount(live, { index: { type: 'ram', ttl: 600 } }),
        '/b/': new Mount(live, { index: { type: 'ram', ttl: 1 } }),
      }
      const overrides: Record<string, Mount> = {}
      for (const p of order) {
        const mount = given[p]
        if (mount !== undefined) overrides[p] = mount
      }
      expect(buildMountArgs(state, overrides).mountArgs['/a/']?.options.index?.ttl).toBe(600)
    },
  )
})
