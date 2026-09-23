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
import { Accessor } from '@struktoai/mirage-core/accessor/base'
import type { CommandIO } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { streamFromBytes } from '@struktoai/mirage-core/commands/builtin/utils/wrap'
import { vfsRefOf, type VFSStateBase } from '@struktoai/mirage-core/vfs/base'
import { GenericVFS } from '@struktoai/mirage-core/vfs/generic'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import {
  ContentType,
  FileStat,
  FileType,
  MountMode,
  type PathSpec,
} from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/utils/errors'
import { MountKey } from '@struktoai/mirage-core/workspace/snapshot/keys'
import { buildMountArgs, toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import { buildVfs, register } from './vfs/registry.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()

class NotesAccessor extends Accessor {
  constructor(public pages: Record<string, string>) {
    super()
  }
}

function key(path: PathSpec): string {
  return path.vfsPath.replace(/^\/+|\/+$/g, '')
}

function readdir(accessor: NotesAccessor, path: PathSpec): Promise<string[]> {
  const parent = path.virtual.replace(/\/+$/, '')
  return Promise.resolve(
    Object.keys(accessor.pages)
      .sort()
      .map((name) => `${parent}/${name}`),
  )
}

function readBytes(accessor: NotesAccessor, path: PathSpec): Promise<Uint8Array> {
  const page = accessor.pages[key(path)]
  if (page === undefined) throw enoent(path)
  return Promise.resolve(ENC.encode(page))
}

function stat(accessor: NotesAccessor, path: PathSpec): Promise<FileStat> {
  const k = key(path)
  const name = path.virtual.replace(/\/+$/, '').split('/').pop() ?? '/'
  if (k === '')
    return Promise.resolve(new FileStat({ name: '/', size: null, type: FileType.DIRECTORY }))
  const page = accessor.pages[k]
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

function notesIO(): CommandIO<NotesAccessor> {
  return {
    readdir,
    readBytes,
    readStream: (a, p, i) => streamFromBytes(readBytes, a, p, i),
    stat,
    isMounted: () => true,
    local: false,
  }
}

/** Content the VFS owns rides its state, so a version restores it. */
class Notes extends GenericVFS<NotesAccessor> {
  readonly notes: NotesAccessor

  constructor(pages: Record<string, string> = {}) {
    const notes = new NotesAccessor({ ...pages })
    super({ name: 'notes-test', accessor: notes, io: notesIO() })
    this.notes = notes
  }

  override getState(): VFSStateBase & { pages: Record<string, string> } {
    return { type: this.kind, pages: { ...this.notes.pages } }
  }

  override loadState(state: VFSStateBase): void {
    const pages = (state as { pages?: Record<string, string> }).pages
    this.notes.pages = { ...(pages ?? {}) }
  }
}

/** Keeps the default state, so it has to be handed back live. */
class Bare extends GenericVFS<NotesAccessor> {
  constructor() {
    super({ name: 'bare-test', accessor: new NotesAccessor({}), io: notesIO() })
  }
}

/** Inherits `kind`, so its state reports the builtin's `ram` type. */
class SeededRAM extends RAMVFS {}

describe('snapshot rebuild through the registry', () => {
  it('rebuilds a registered content VFS from its saved state, no override', async () => {
    register('notes-test', () => Promise.resolve(new Notes()))
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

  it('records the reference the registry built a VFS from', async () => {
    register('notes-test', () => Promise.resolve(new Notes()))
    const built = await buildVfs('notes-test')
    expect(vfsRefOf(built)).toBe('notes-test')
    expect(vfsRefOf(new Notes())).toBeNull()
    await built.close()
  })

  it('rebuilds an alias over a builtin through its ref, not its type', async () => {
    register('seeded-test', () => Promise.resolve(new SeededRAM()))
    const ws = new Workspace({ '/s/': await buildVfs('seeded-test') }, { mode: MountMode.WRITE })
    await ws.shell('echo one > /s/a.txt')
    const state = await toStateDict(ws)
    await ws.close()
    const [mount] = state.mounts
    if (mount === undefined) throw new Error('snapshot recorded no mounts')
    // The type alone names RAMVFS, which is what the mount used to
    // come back as; the ref is the door it was declared through.
    expect(mount.vfs_state.type).toBe('ram')
    expect(mount[MountKey.VFS_REF]).toBe('seeded-test')
    const restored = await Workspace.fromState(state)
    try {
      const seeded = restored.mounts().find((m) => m.prefix === '/s/')
      expect(seeded?.vfs).toBeInstanceOf(SeededRAM)
      expect(seeded === undefined ? null : vfsRefOf(seeded.vfs)).toBe('seeded-test')
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
