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
import { resourceRefOf, type ResourceStateBase } from '@struktoai/mirage-core/resource/base'
import { GenericResource } from '@struktoai/mirage-core/resource/generic'
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
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
import { buildResource, register } from './resource/registry.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()

class NotesAccessor extends Accessor {
  constructor(public pages: Record<string, string>) {
    super()
  }
}

function key(path: PathSpec): string {
  return path.resourcePath.replace(/^\/+|\/+$/g, '')
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

/** Content the resource owns rides its state, so a version restores it. */
class Notes extends GenericResource<NotesAccessor> {
  readonly notes: NotesAccessor

  constructor(pages: Record<string, string> = {}) {
    const notes = new NotesAccessor({ ...pages })
    super({ name: 'notes-test', accessor: notes, io: notesIO() })
    this.notes = notes
  }

  override getState(): ResourceStateBase & { pages: Record<string, string> } {
    return { type: this.kind, pages: { ...this.notes.pages } }
  }

  override loadState(state: ResourceStateBase): void {
    const pages = (state as { pages?: Record<string, string> }).pages
    this.notes.pages = { ...(pages ?? {}) }
  }
}

/** Keeps the default state, so it has to be handed back live. */
class Bare extends GenericResource<NotesAccessor> {
  constructor() {
    super({ name: 'bare-test', accessor: new NotesAccessor({}), io: notesIO() })
  }
}

/** Inherits `kind`, so its state reports the builtin's `ram` type. */
class SeededRAM extends RAMResource {}

describe('snapshot rebuild through the registry', () => {
  it('rebuilds a registered content resource from its saved state, no override', async () => {
    register('notes-test', () => Promise.resolve(new Notes()))
    const ws = new Workspace({ '/n/': new Notes({ 'a.md': 'one\n' }) }, { mode: MountMode.READ })
    const state = await toStateDict(ws)
    await ws.close()
    const [mount] = state.mounts
    if (mount === undefined) throw new Error('snapshot recorded no mounts')
    expect(mount.resource_state).toEqual({ type: 'notes-test', pages: { 'a.md': 'one\n' } })
    // Constructed in code, so no registry reference was stamped: the
    // loader reaches the class through the registered name alone.
    expect(mount[MountKey.RESOURCE_REF]).toBeNull()
    const restored = await Workspace.fromState(state)
    try {
      const out = await restored.execute('cat /n/a.md')
      expect(out.stdoutText).toBe('one\n')
      const notes = restored.mounts().find((m) => m.prefix === '/n/')
      expect(notes?.resource).toBeInstanceOf(Notes)
    } finally {
      await restored.close()
    }
  })

  it('still asks for a generic resource that keeps its default state', async () => {
    const ws = new Workspace({ '/b/': new Bare() }, { mode: MountMode.READ })
    const state = await toStateDict(ws)
    await ws.close()
    expect(state.mounts[0]?.resource_state).toEqual({ type: 'bare-test', needs_override: true })
    expect(() => buildMountArgs(state)).toThrow(/resources= must include overrides for: \/b\//)
    await expect(Workspace.fromState(state)).rejects.toThrow(/resources= must include/)
  })

  it('records the reference the registry built a resource from', async () => {
    register('notes-test', () => Promise.resolve(new Notes()))
    const built = await buildResource('notes-test')
    expect(resourceRefOf(built)).toBe('notes-test')
    expect(resourceRefOf(new Notes())).toBeNull()
    await built.close()
  })

  it('rebuilds an alias over a builtin through its ref, not its type', async () => {
    register('seeded-test', () => Promise.resolve(new SeededRAM()))
    const ws = new Workspace(
      { '/s/': await buildResource('seeded-test') },
      { mode: MountMode.WRITE },
    )
    await ws.execute('echo one > /s/a.txt')
    const state = await toStateDict(ws)
    await ws.close()
    const [mount] = state.mounts
    if (mount === undefined) throw new Error('snapshot recorded no mounts')
    // The type alone names RAMResource, which is what the mount used to
    // come back as; the ref is the door it was declared through.
    expect(mount.resource_state.type).toBe('ram')
    expect(mount[MountKey.RESOURCE_REF]).toBe('seeded-test')
    const restored = await Workspace.fromState(state)
    try {
      const seeded = restored.mounts().find((m) => m.prefix === '/s/')
      expect(seeded?.resource).toBeInstanceOf(SeededRAM)
      expect(seeded === undefined ? null : resourceRefOf(seeded.resource)).toBe('seeded-test')
      const out = await restored.execute('cat /s/a.txt')
      expect(out.stdoutText).toBe('one\n')
    } finally {
      await restored.close()
    }
  })

  it('refuses a ref it cannot resolve rather than guessing from the type', async () => {
    const ws = new Workspace({ '/s/': new RAMResource() }, { mode: MountMode.READ })
    const state = await toStateDict(ws)
    await ws.close()
    const [mount] = state.mounts
    if (mount === undefined) throw new Error('snapshot recorded no mounts')
    // Saved by a process that had an alias registered; this one has not,
    // and the type would only say RAMResource.
    mount.resource_ref = 'ghost-test'
    await expect(Workspace.fromState(state)).rejects.toThrow(
      /resources= must include overrides for: \/s\//,
    )
  })
})
