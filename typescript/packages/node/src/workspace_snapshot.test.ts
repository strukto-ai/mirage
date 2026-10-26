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
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import {
  ContentType,
  FileStat,
  FileType,
  Limit,
  MountMode,
  type PathSpec,
  WritePolicy,
} from '@struktoai/mirage-core/types'
import { ALL_COMMANDS } from '@struktoai/mirage-core/policy/builtin/output_cap'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { MountKey } from '@struktoai/mirage-core/workspace/snapshot/keys'
import { buildMountArgs, toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
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
// mount comes back as RAM held to the workspace's limit.
describe('a rebuilt disk mount', () => {
  it.each([2, -1])('keeps its walk limit (%d)', async (limit) => {
    const root = await mkdtemp(join(tmpdir(), 'mirage-limit-'))
    const ws = new Workspace(
      { '/d': new DiskVFS({ root }) },
      { commandLimits: { [ALL_COMMANDS]: new Limit({ walkLimit: limit }) } },
    )
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

describe('the write policy in a snapshot', () => {
  const built: Workspace[] = []
  function track(ws: Workspace): Workspace {
    built.push(ws)
    return ws
  }
  afterEach(async () => {
    for (const ws of built.splice(0).reverse()) await ws.close()
  })
  async function savedState(
    mounts: Record<string, Mount | RAMVFS>,
    write: WritePolicy = WritePolicy.UNCONDITIONAL,
  ): Promise<WorkspaceStateDict> {
    const ws = new Workspace(mounts, { mode: MountMode.WRITE, write })
    try {
      return await toStateDict(ws)
    } finally {
      await ws.close()
    }
  }

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
