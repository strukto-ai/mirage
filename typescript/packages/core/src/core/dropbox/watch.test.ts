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

import { describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, listFolder: vi.fn(), listFolderState: vi.fn(), continueFolder: vi.fn() }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { PathSpec, type WalkEntry } from '../../types.ts'
import { DropboxApiError } from './client.ts'
import type { DropboxTokenManager } from './client.ts'
import * as api from './api.ts'
import { DropboxDeltaHook, DropboxWalk } from './watch.ts'

const STUB_TM = {} as DropboxTokenManager

function accessor(rootPath: string): DropboxAccessor {
  return new DropboxAccessor({ tokenManager: STUB_TM, rootPath })
}

function root(): PathSpec {
  return new PathSpec({ virtual: '/m', directory: '/m', resourcePath: '' })
}

async function collect(walk: DropboxWalk, at: PathSpec): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  for await (const entry of walk.walk(at)) out.push(entry)
  return out
}

describe('DropboxWalk root stripping', () => {
  it('strips the root when the server casing differs', async () => {
    // Dropbox paths are case-insensitive: path_display carries the
    // server's casing and rootPath the user's. Comparing them exactly
    // left the root on the front of every virtual path, which put every
    // event outside the watch scope and silently disabled delivery.
    vi.mocked(api.listFolder).mockResolvedValue([
      {
        '.tag': 'file',
        id: 'id:1',
        name: 'notes.txt',
        path_display: '/Team/notes.txt',
        path_lower: '/team/notes.txt',
        size: 4,
        rev: 'r1',
      },
    ])
    const entries = await collect(new DropboxWalk(accessor('/team')), root())
    expect(entries.map((e) => e.virtual)).toEqual(['/m/notes.txt'])
  })

  it('preserves the casing below the root', async () => {
    vi.mocked(api.listFolder).mockResolvedValue([
      {
        '.tag': 'file',
        id: 'id:1',
        name: 'Report.TXT',
        path_display: '/Team/Notes/Report.TXT',
        path_lower: '/team/notes/report.txt',
        size: 4,
        rev: 'r1',
      },
    ])
    const entries = await collect(new DropboxWalk(accessor('/team')), root())
    expect(entries.map((e) => e.virtual)).toEqual(['/m/Notes/Report.TXT'])
  })
})

function fileEntry(pathDisplay: string, digest: string, size = 4) {
  return {
    '.tag': 'file' as const,
    name: pathDisplay.slice(pathDisplay.lastIndexOf('/') + 1),
    path_display: pathDisplay,
    path_lower: pathDisplay.toLowerCase(),
    size,
    content_hash: digest,
    rev: digest.slice(0, 8),
  }
}

describe('DropboxDeltaHook native pull', () => {
  it('emits nothing on a baseline pull', async () => {
    vi.mocked(api.listFolderState).mockResolvedValue({
      entries: [fileEntry('/team/keep.txt', 'h1')],
      cursor: 'c0',
    })
    const hook = new DropboxDeltaHook(accessor('/team'))
    const delta = await hook.pull(root(), null)
    expect(delta.changes).toEqual([])
    expect(delta.checkpoint).toContain('"_dbx":1')
  })

  it('classifies continue rows as create, update, and delete', async () => {
    vi.mocked(api.listFolderState).mockResolvedValue({
      entries: [fileEntry('/team/keep.txt', 'h1'), fileEntry('/team/gone.txt', 'h0')],
      cursor: 'c0',
    })
    const hook = new DropboxDeltaHook(accessor('/team'))
    const base = await hook.pull(root(), null)
    vi.mocked(api.continueFolder).mockResolvedValue({
      entries: [
        fileEntry('/team/keep.txt', 'h2'),
        fileEntry('/team/new.txt', 'h3'),
        {
          '.tag': 'deleted',
          name: 'gone.txt',
          path_display: '/team/gone.txt',
          path_lower: '/team/gone.txt',
        },
      ],
      cursor: 'c1',
    })
    const delta = await hook.pull(root(), base.checkpoint)
    const kinds = new Set(delta.changes.map((c) => `${c.path.virtual}:${c.kind}`))
    expect(kinds.has('/m/keep.txt:update')).toBe(true)
    expect(kinds.has('/m/new.txt:create')).toBe(true)
    expect(kinds.has('/m/gone.txt:delete')).toBe(true)
  })

  it('resets through a full listing when the cursor is invalid', async () => {
    vi.mocked(api.listFolderState).mockResolvedValue({
      entries: [fileEntry('/team/keep.txt', 'h1')],
      cursor: 'c0',
    })
    const hook = new DropboxDeltaHook(accessor('/team'))
    const base = await hook.pull(root(), null)
    vi.mocked(api.continueFolder).mockRejectedValue(new DropboxApiError('reset', 409, 'reset/...'))
    vi.mocked(api.listFolderState).mockResolvedValue({
      entries: [fileEntry('/team/keep.txt', 'h1'), fileEntry('/team/extra.txt', 'h9')],
      cursor: 'c9',
    })
    const delta = await hook.pull(root(), base.checkpoint)
    const kinds = new Set(delta.changes.map((c) => `${c.path.virtual}:${c.kind}`))
    expect(kinds.has('/m/extra.txt:create')).toBe(true)
  })

  it('upgrades a listing-era checkpoint to a native cursor', async () => {
    vi.mocked(api.listFolderState).mockResolvedValue({
      entries: [fileEntry('/team/keep.txt', 'h1')],
      cursor: 'c0',
    })
    const hook = new DropboxDeltaHook(accessor('/team'))
    const base = await hook.pull(root(), null)
    const snap = (JSON.parse(base.checkpoint ?? '{}') as { s: Record<string, string> }).s
    vi.mocked(api.listFolderState).mockResolvedValue({
      entries: [fileEntry('/team/keep.txt', 'h1'), fileEntry('/team/extra.txt', 'h9')],
      cursor: 'c2',
    })
    const delta = await hook.pull(root(), JSON.stringify(snap))
    const kinds = new Set(delta.changes.map((c) => `${c.path.virtual}:${c.kind}`))
    expect(kinds.has('/m/extra.txt:create')).toBe(true)
    expect(delta.checkpoint).toContain('"_dbx":1')
  })

  it('emits nothing when continue is empty', async () => {
    vi.mocked(api.listFolderState).mockResolvedValue({
      entries: [fileEntry('/team/keep.txt', 'h1')],
      cursor: 'c0',
    })
    const hook = new DropboxDeltaHook(accessor('/team'))
    const base = await hook.pull(root(), null)
    vi.mocked(api.continueFolder).mockResolvedValue({ entries: [], cursor: 'c1' })
    const delta = await hook.pull(root(), base.checkpoint)
    expect(delta.changes).toEqual([])
    expect(JSON.parse(delta.checkpoint ?? '{}')).toMatchObject({ c: 'c1' })
  })

  it('drops descendants when a folder is deleted', async () => {
    vi.mocked(api.listFolderState).mockResolvedValue({
      entries: [
        {
          '.tag': 'folder',
          name: 'dir',
          path_display: '/team/dir',
          path_lower: '/team/dir',
        },
        fileEntry('/team/dir/a.txt', 'h1'),
      ],
      cursor: 'c0',
    })
    const hook = new DropboxDeltaHook(accessor('/team'))
    const base = await hook.pull(root(), null)
    vi.mocked(api.continueFolder).mockResolvedValue({
      entries: [
        {
          '.tag': 'deleted',
          name: 'dir',
          path_display: '/team/dir',
          path_lower: '/team/dir',
        },
      ],
      cursor: 'c1',
    })
    const delta = await hook.pull(root(), base.checkpoint)
    const kinds = new Set(delta.changes.map((c) => `${c.path.virtual}:${c.kind}`))
    expect(kinds.has('/m/dir:delete')).toBe(true)
    expect(kinds.has('/m/dir/a.txt:delete')).toBe(true)
  })

  it('keeps no cursor when a reset lands on a missing root', async () => {
    // A root that 409s hands back no cursor, and list_folder/continue
    // refuses an empty one, so encoding it would wedge every later pull
    // on a 400 and the walk would never be reached again.
    vi.mocked(api.listFolderState).mockResolvedValue({
      entries: [fileEntry('/team/keep.txt', 'h1')],
      cursor: 'c0',
    })
    const hook = new DropboxDeltaHook(accessor('/team'))
    const base = await hook.pull(root(), null)
    vi.mocked(api.continueFolder).mockRejectedValue(new DropboxApiError('reset', 409, 'reset/...'))
    const gone = new DropboxApiError('gone', 409, 'path/not_found/...')
    vi.mocked(api.listFolderState).mockRejectedValue(gone)
    vi.mocked(api.listFolder).mockRejectedValue(gone)
    const delta = await hook.pull(root(), base.checkpoint)
    const kinds = new Set(delta.changes.map((c) => `${c.path.virtual}:${c.kind}`))
    expect(kinds.has('/m/keep.txt:delete')).toBe(true)
    expect(JSON.parse(delta.checkpoint ?? '')).toEqual({})
  })

  it('upgrades back to a cursor once the root comes back', async () => {
    vi.mocked(api.listFolderState).mockResolvedValue({
      entries: [fileEntry('/team/keep.txt', 'h1')],
      cursor: 'c7',
    })
    const hook = new DropboxDeltaHook(accessor('/team'))
    const delta = await hook.pull(root(), '{}')
    const kinds = new Set(delta.changes.map((c) => `${c.path.virtual}:${c.kind}`))
    expect(kinds.has('/m/keep.txt:create')).toBe(true)
    expect(JSON.parse(delta.checkpoint ?? '{}')).toMatchObject({ c: 'c7' })
  })
})
