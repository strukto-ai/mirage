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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it, vi } from 'vitest'
import type * as DriveModule from '../google/drive.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  return { ...actual, listAllFiles: vi.fn(), getFile: vi.fn() }
})

import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { PathSpec, type FileStat } from '../../types.ts'
import { GDocsVFS } from '../../vfs/gdocs/gdocs.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { TokenManager } from '../google/client.ts'
import * as drive from '../google/drive.ts'

const STUB_TOKEN_MANAGER = {
  config: { clientId: 'cid', refreshToken: 'rt' },
} as TokenManager

function makeAccessor(): GDocsAccessor {
  return new GDocsAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

// The account behind a mount at /gdocs, which keeps each listing as a command's
// walk does.
async function mounted(accessor: GDocsAccessor): Promise<Workspace> {
  const vfs = Object.assign(
    new GDocsVFS({ clientId: 'id', clientSecret: 's', refreshToken: 'rt' }),
    { accessor },
  )
  return new Workspace({ '/gdocs/': vfs }, { shellParser: await getTestParser() })
}

// A directory's children through the mount; a glob word, the children it
// matches.
async function readdir(_accessor: GDocsAccessor, path: PathSpec, ws: Workspace): Promise<string[]> {
  if (path.pattern === null) return (await ws.dispatch('readdir', path.virtual)) as string[]
  const words = (await ws.shell(`echo ${path.virtual}`)).stdoutText.trim().split(/\s+/)
  return words.length === 1 && words[0] === path.virtual ? [] : words
}

function stat(_accessor: GDocsAccessor, path: PathSpec, ws: Workspace): Promise<FileStat> {
  return ws.dispatch('stat', path.virtual) as Promise<FileStat>
}

describe('gdocs readdir', () => {
  it('pushes modified range to drive when pattern is a date glob', async () => {
    const captured: { modifiedAfter?: string | null; modifiedBefore?: string | null } = {}
    vi.mocked(drive.listAllFiles).mockImplementation(((_tm, opts) => {
      captured.modifiedAfter = opts?.modifiedAfter ?? null
      captured.modifiedBefore = opts?.modifiedBefore ?? null
      return Promise.resolve({ files: [], complete: true })
    }) as typeof drive.listAllFiles)

    const accessor = makeAccessor()
    const ws = await mounted(accessor)
    await readdir(
      accessor,
      new PathSpec({
        virtual: '/gdocs/owned/2026-05-*',
        directory: '/gdocs/owned',
        pattern: '2026-05-*',
        vfsPath: mountKey('/gdocs/owned/2026-05-*', '/gdocs'),
      }),
      ws,
    )

    expect(captured.modifiedAfter).toBe('2026-05-01T00:00:00Z')
    expect(captured.modifiedBefore).toBe('2026-06-01T00:00:00Z')
  })

  it('omits modified range when no pattern', async () => {
    const captured: { modifiedAfter?: string | null; modifiedBefore?: string | null } = {}
    vi.mocked(drive.listAllFiles).mockImplementation(((_tm, opts) => {
      captured.modifiedAfter = opts?.modifiedAfter ?? null
      captured.modifiedBefore = opts?.modifiedBefore ?? null
      return Promise.resolve({ files: [], complete: true })
    }) as typeof drive.listAllFiles)

    const accessor = makeAccessor()
    const ws = await mounted(accessor)
    await readdir(
      accessor,
      new PathSpec({
        virtual: '/gdocs/owned',
        directory: '/gdocs/owned',
        vfsPath: mountKey('/gdocs/owned', '/gdocs'),
      }),
      ws,
    )

    expect(captured.modifiedAfter).toBeNull()
    expect(captured.modifiedBefore).toBeNull()
  })

  it('omits modified range for non-date pattern', async () => {
    const captured: { modifiedAfter?: string | null; modifiedBefore?: string | null } = {}
    vi.mocked(drive.listAllFiles).mockImplementation(((_tm, opts) => {
      captured.modifiedAfter = opts?.modifiedAfter ?? null
      captured.modifiedBefore = opts?.modifiedBefore ?? null
      return Promise.resolve({ files: [], complete: true })
    }) as typeof drive.listAllFiles)

    const accessor = makeAccessor()
    const ws = await mounted(accessor)
    await readdir(
      accessor,
      new PathSpec({
        virtual: '/gdocs/owned/*foo*',
        directory: '/gdocs/owned',
        pattern: '*foo*',
        vfsPath: mountKey('/gdocs/owned/*foo*', '/gdocs'),
      }),
      ws,
    )

    expect(captured.modifiedAfter).toBeNull()
    expect(captured.modifiedBefore).toBeNull()
  })

  it('filtered listing does not clobber unfiltered cache', async () => {
    const full = [
      {
        id: 'may',
        name: 'MayDoc',
        modifiedTime: '2026-05-15T00:00:00.000Z',
        owners: [{ me: true }],
      },
      {
        id: 'jan',
        name: 'JanDoc',
        modifiedTime: '2026-01-15T00:00:00.000Z',
        owners: [{ me: true }],
      },
    ]
    const mayOnly = full.slice(0, 1)
    let calls = 0
    vi.mocked(drive.listAllFiles).mockImplementation(((_tm, opts) => {
      calls += 1
      if (opts?.modifiedAfter) return Promise.resolve({ files: mayOnly, complete: true })
      return Promise.resolve({ files: full, complete: true })
    }) as typeof drive.listAllFiles)

    const accessor = makeAccessor()
    const ws = await mounted(accessor)
    await readdir(
      accessor,
      new PathSpec({
        virtual: '/gdocs/owned/2026-05-*',
        directory: '/gdocs/owned',
        pattern: '2026-05-*',
        vfsPath: mountKey('/gdocs/owned/2026-05-*', '/gdocs'),
      }),
      ws,
    )
    const result = await readdir(
      accessor,
      new PathSpec({
        virtual: '/gdocs/owned',
        directory: '/gdocs/owned',
        vfsPath: mountKey('/gdocs/owned', '/gdocs'),
      }),
      ws,
    )
    expect(calls).toBe(2)
    expect(result.length).toBe(2)
  })

  it('answers a stat after a filtered listing', async () => {
    vi.mocked(drive.listAllFiles).mockResolvedValue({
      files: [
        {
          id: 'may1',
          name: 'MayDoc',
          modifiedTime: '2026-05-15T00:00:00.000Z',
          owners: [{ me: false }],
        },
      ],
      complete: true,
    })

    vi.mocked(drive.getFile).mockResolvedValue({
      id: 'may1',
      name: 'MayDoc',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: '2026-05-15T00:00:00.000Z',
      owners: [{ me: false }],
    })

    const accessor = makeAccessor()
    const ws = await mounted(accessor)
    const listed = await readdir(
      accessor,
      new PathSpec({
        virtual: '/gdocs/shared/2026-05-*',
        directory: '/gdocs/shared',
        pattern: '2026-05-*',
        vfsPath: mountKey('/gdocs/shared/2026-05-*', '/gdocs'),
      }),
      ws,
    )
    expect(listed.length).toBe(1)
    const matched = listed[0]
    if (matched === undefined) throw new Error('expected one match')
    vi.mocked(drive.getFile).mockClear()
    const result = await stat(
      accessor,
      new PathSpec({
        virtual: matched,
        directory: matched,
        vfsPath: mountKey(matched, '/gdocs'),
      }),
      ws,
    )
    // The filtered result is not the directory, but the rows it lists are
    // real, so the stat is answered from them.
    expect(result.extra.doc_id).toBe('may1')
    expect(drive.getFile).not.toHaveBeenCalled()
  })

  it('keeps entry size null, Drive source size lands in extra', async () => {
    vi.mocked(drive.listAllFiles).mockResolvedValue({
      files: [
        {
          id: 'doc1',
          name: 'My Doc',
          modifiedTime: '2026-04-01T00:00:00.000Z',
          size: '1234',
          owners: [{ me: true }],
        },
      ],
      complete: true,
    })

    const accessor = makeAccessor()
    const ws = await mounted(accessor)
    const listed = await readdir(
      accessor,
      new PathSpec({
        virtual: '/gdocs/owned',
        directory: '/gdocs/owned',
        vfsPath: mountKey('/gdocs/owned', '/gdocs'),
      }),
      ws,
    )

    // Drive's source size never becomes the row's size: the rendered
    // JSON length is unknown until read.
    const listedPath = listed[0]
    if (listedPath === undefined) throw new Error('expected one entry')
    const result = await stat(
      accessor,
      new PathSpec({
        virtual: listedPath,
        directory: listedPath,
        vfsPath: mountKey(listedPath, '/gdocs'),
      }),
      ws,
    )
    expect(result.size).toBeNull()
    expect(result.extra.source_size).toBe(1234)
  })
})

describe('gdocs incomplete search', () => {
  it('does not cache a short listing as the directory', async () => {
    // Drive reporting a corpus it skipped means the listing is short.
    // Keeping it would pin the short listing until it expires, so a Shared
    // Drive document stays invisible long after the cause clears: the next
    // listing asks Drive again until one finishes.
    const files = [
      {
        id: 'd1',
        name: 'Doc',
        modifiedTime: '2026-05-15T00:00:00.000Z',
        owners: [{ me: true }],
      },
    ]
    let complete = false
    let listings = 0
    vi.mocked(drive.listAllFiles).mockImplementation((() => {
      listings += 1
      return Promise.resolve({ files, complete })
    }) as typeof drive.listAllFiles)

    const accessor = makeAccessor()
    const ws = await mounted(accessor)
    const owned = new PathSpec({
      virtual: '/gdocs/owned',
      directory: '/gdocs/owned',
      vfsPath: mountKey('/gdocs/owned', '/gdocs'),
    })
    const listed = await readdir(accessor, owned, ws)
    expect(listed).toHaveLength(1)
    await readdir(accessor, owned, ws)
    expect(listings).toBe(2)

    complete = true
    await readdir(accessor, owned, ws)
    await readdir(accessor, owned, ws)
    expect(listings).toBe(3)
  })
})
