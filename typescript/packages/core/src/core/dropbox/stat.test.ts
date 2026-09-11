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
import type * as ClientModule from './client.ts'

// One stable seam: the JSON-RPC transport. listFolder, getMetadata and the
// token refresh all funnel through dropboxRpc, so mocking it makes stat
// hermetic (no live api.dropboxapi.com call, no token to seed) and drives
// readdir's real error mapping end to end; an unexpected endpoint throws
// loudly instead of leaking a live call.
vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, dropboxRpc: vi.fn(), dropboxDownload: vi.fn() }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { ContentType, FileType, PathSpec } from '../../types.ts'
import * as client from './client.ts'
import { DropboxApiError, type DropboxTokenManager } from './client.ts'
import type { DropboxEntry } from './api.ts'
import { stat } from './stat.ts'
import { read } from './read.ts'
import { readdir } from './readdir.ts'
import { FakeDropboxRpc } from './_test_util.ts'

const STUB_TM = {} as DropboxTokenManager

function makeAccessor(): DropboxAccessor {
  return new DropboxAccessor({ tokenManager: STUB_TM })
}

const FILE_ENTRY: DropboxEntry = {
  '.tag': 'file',
  id: 'id:a',
  name: 'a.txt',
  path_display: '/a.txt',
  size: 5,
  server_modified: '2026-04-01T00:00:00Z',
}

const FOLDER_ENTRY: DropboxEntry = {
  '.tag': 'folder',
  id: 'id:docs',
  name: 'docs',
  path_display: '/docs',
}

describe('dropbox stat', () => {
  it('is a directory at the mount root with no I/O', async () => {
    const fake = new FakeDropboxRpc()
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    const out = await stat(
      makeAccessor(),
      new PathSpec({ resourcePath: '', virtual: '/', directory: '/' }),
      new RAMIndexCacheStore(),
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('/')
    expect(fake.listRequests).toBe(0)
  })

  it('resolves a file directly through get_metadata without an index', async () => {
    // No index: stat resolves through get_metadata (unlink/rmdir
    // classification and the wired find core take this path).
    const fake = new FakeDropboxRpc({ metadata: FILE_ENTRY })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    const out = await stat(makeAccessor(), PathSpec.fromStrPath('/a.txt'))
    expect(out.content).toBe(ContentType.TEXT)
    expect(out.name).toBe('a.txt')
    expect(out.size).toBe(5)
    expect(out.modified).toBe('2026-04-01T00:00:00Z')
    expect(out.fingerprint).toBe('2026-04-01T00:00:00Z')
    expect(out.extra.dropbox_id).toBe('id:a')
    expect(out.extra.resource_type).toBe('dropbox/file')
  })

  it('resolves a folder directly through get_metadata without an index', async () => {
    const fake = new FakeDropboxRpc({ metadata: FOLDER_ENTRY })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    const out = await stat(makeAccessor(), PathSpec.fromStrPath('/docs'))
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('docs')
    expect(out.size).toBeNull()
    expect(out.extra.dropbox_id).toBe('id:docs')
  })

  it('maps a 409 to ENOENT without an index', async () => {
    const fake = new FakeDropboxRpc({ metadata: null })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    await expect(stat(makeAccessor(), PathSpec.fromStrPath('/ghost.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
      virtualPath: '/ghost.txt',
    })
  })

  it('propagates a non-409 error without an index', async () => {
    // A rate-limit or server error is not absence: it must surface.
    vi.mocked(client.dropboxRpc).mockRejectedValue(new DropboxApiError('boom', 500))
    await expect(stat(makeAccessor(), PathSpec.fromStrPath('/a.txt'))).rejects.toMatchObject({
      status: 500,
    })
  })

  // statFromEntry fallbacks: server_modified→client_modified→'',
  // id→path_display→name, and a non-number/absent size renders as null (the
  // unknown-size machinery, never a fabricated number).
  const fallbackCases: [DropboxEntry, string, number | null, string, string | null][] = [
    [
      {
        '.tag': 'file',
        id: 'id:x',
        name: 'f.txt',
        client_modified: '2026-01-02T00:00:00Z',
        size: 3,
      },
      'id:x',
      3,
      '2026-01-02T00:00:00Z',
      '2026-01-02T00:00:00Z',
    ],
    [{ '.tag': 'file', id: 'id:x', name: 'f.txt', size: 3 }, 'id:x', 3, '', null],
    [{ '.tag': 'file', name: 'f.txt', path_display: '/d/f.txt', size: 3 }, '/d/f.txt', 3, '', null],
    [{ '.tag': 'file', name: 'f.txt', size: 3 }, 'f.txt', 3, '', null],
    [{ '.tag': 'file', id: 'id:x', name: 'f.txt' }, 'id:x', null, '', null],
    // size is typed number, but the wire is untyped JSON; a non-number
    // from the API must render as null, not a fabricated size.
    [
      { '.tag': 'file', id: 'id:x', name: 'f.txt', size: 'big' as unknown as number },
      'id:x',
      null,
      '',
      null,
    ],
  ]
  it.each(fallbackCases)(
    'renders entry field fallbacks (%#)',
    async (entry, dropboxId, size, modified, fingerprint) => {
      const fake = new FakeDropboxRpc({ metadata: entry })
      vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
      const out = await stat(makeAccessor(), PathSpec.fromStrPath('/f.txt'))
      expect(out.extra.dropbox_id).toBe(dropboxId)
      expect(out.size).toBe(size)
      expect(out.modified).toBe(modified)
      expect(out.fingerprint).toBe(fingerprint)
    },
  )

  it('populates from the parent listing on an index miss', async () => {
    const fake = new FakeDropboxRpc({ entries: [FILE_ENTRY] })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    const out = await stat(
      makeAccessor(),
      new PathSpec({ resourcePath: 'a.txt', virtual: '/a.txt', directory: '/' }),
      new RAMIndexCacheStore(),
    )
    expect(out.content).toBe(ContentType.TEXT)
    expect(out.name).toBe('a.txt')
    expect(out.size).toBe(5)
    expect(out.modified).toBe('2026-04-01T00:00:00Z')
    expect(out.fingerprint).toBe('2026-04-01T00:00:00Z')
    expect(out.extra.dropbox_id).toBe('id:a')
    expect(out.extra.resource_type).toBe('dropbox/file')
    expect(fake.listRequests).toBe(1)
  })

  it('serves an index hit without a second listing', async () => {
    // Once a parent listing populates the index, a stat of any sibling
    // serves from cache. metadata:null makes a stray get_metadata blow up
    // as a 409, so a single list request proves both came from the index.
    const fake = new FakeDropboxRpc({ entries: [FOLDER_ENTRY, FILE_ENTRY], metadata: null })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    const index = new RAMIndexCacheStore()
    const accessor = makeAccessor()
    const fileOut = await stat(
      accessor,
      new PathSpec({ resourcePath: 'a.txt', virtual: '/a.txt', directory: '/' }),
      index,
    )
    const dirOut = await stat(
      accessor,
      new PathSpec({ resourcePath: 'docs', virtual: '/docs', directory: '/' }),
      index,
    )
    expect(fileOut.content).toBe(ContentType.TEXT)
    expect(dirOut.type).toBe(FileType.DIRECTORY)
    expect(dirOut.extra.dropbox_id).toBe('id:docs')
    expect(fake.listRequests).toBe(1)
  })

  it('reports ENOENT when the parent lists but omits the child', async () => {
    // The parent lists cleanly without the child: stat's own
    // re-check-then-ENOENT, distinct from readdir's 409 mapping.
    const other: DropboxEntry = {
      '.tag': 'file',
      id: 'id:o',
      name: 'other.txt',
      path_display: '/other.txt',
      size: 1,
    }
    const fake = new FakeDropboxRpc({ entries: [other] })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    await expect(
      stat(
        makeAccessor(),
        new PathSpec({ resourcePath: 'note.txt', virtual: '/note.txt', directory: '/' }),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT', virtualPath: '/note.txt' })
    expect(fake.listRequests).toBe(1)
  })

  it('honors the mount prefix on an index miss', async () => {
    const fake = new FakeDropboxRpc({ entries: [FILE_ENTRY] })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    const out = await stat(
      makeAccessor(),
      new PathSpec({
        virtual: '/dropbox/a.txt',
        directory: '/dropbox',
        resourcePath: mountKey('/dropbox/a.txt', '/dropbox'),
      }),
      new RAMIndexCacheStore(),
    )
    expect(out.content).toBe(ContentType.TEXT)
    expect(out.name).toBe('a.txt')
    expect(out.size).toBe(5)
  })

  it('reports ENOENT when the parent is genuinely missing', async () => {
    // 409 on the listing and on every ancestor probe: readdir reports
    // ENOENT, and stat answers its own ENOENT naming the child.
    vi.mocked(client.dropboxRpc).mockImplementation(() =>
      Promise.reject(new DropboxApiError('nf', 409, 'path/not_found/...')),
    )
    await expect(
      stat(
        makeAccessor(),
        new PathSpec({
          resourcePath: 'ghost/missing.txt',
          virtual: '/ghost/missing.txt',
          directory: '/ghost',
        }),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT', virtualPath: '/ghost/missing.txt' })
  })

  it('propagates a 5xx from the parent listing instead of ENOENT', async () => {
    // A 5xx/429 while listing the parent is not absence: readdir re-raises
    // it and stat must let it surface, never collapse it into a
    // (destructively actionable) false ENOENT.
    vi.mocked(client.dropboxRpc).mockImplementation((_tm, endpoint) => {
      if (endpoint === '/files/list_folder') return Promise.reject(new DropboxApiError('boom', 500))
      throw new Error(`unexpected endpoint ${endpoint}`)
    })
    await expect(
      stat(
        makeAccessor(),
        new PathSpec({
          resourcePath: 'ghost/missing.txt',
          virtual: '/ghost/missing.txt',
          directory: '/ghost',
        }),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ status: 500 })
  })

  it('propagates ENOTDIR for a path under a file', async () => {
    // A path under a file is ENOTDIR, not ENOENT: readdir's ancestor walk
    // classifies it and stat must let it escape.
    vi.mocked(client.dropboxRpc).mockImplementation((_tm, endpoint, body) => {
      if (endpoint === '/files/list_folder') {
        return Promise.reject(new DropboxApiError('nf', 409, 'path/not_folder/...'))
      }
      if (endpoint === '/files/get_metadata') {
        if ((body as { path?: string }).path === '/a.txt') {
          return Promise.resolve({ '.tag': 'file', name: 'a.txt' })
        }
        return Promise.reject(new DropboxApiError('nf', 409, 'path/not_found/...'))
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    })
    await expect(
      stat(
        makeAccessor(),
        new PathSpec({ resourcePath: 'a.txt/x', virtual: '/a.txt/x', directory: '/a.txt' }),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('serves a size for every listed file that matches its read length', async () => {
    // The fskit invariant behind SIZES_ALWAYS_KNOWN: the size stat serves
    // from the listing must equal the byte length a read delivers, 0-byte
    // files included. Listings go through the transport seam; the content
    // channel (dropboxDownload) does not, so it keeps its own seam.
    const tree: Record<string, DropboxEntry[]> = {
      '': [
        { '.tag': 'folder', id: 'id:docs', name: 'docs', path_display: '/docs' },
        {
          '.tag': 'file',
          id: 'id:a',
          name: 'a.txt',
          path_display: '/a.txt',
          size: 5,
          server_modified: '2026-04-01T00:00:00Z',
        },
        {
          '.tag': 'file',
          id: 'id:empty',
          name: 'empty.txt',
          path_display: '/empty.txt',
          size: 0,
          server_modified: '2026-04-01T00:00:00Z',
        },
      ],
      '/docs': [
        {
          '.tag': 'file',
          id: 'id:b',
          name: 'b.bin',
          path_display: '/docs/b.bin',
          size: 3,
          server_modified: '2026-04-01T00:00:00Z',
        },
      ],
    }
    const contents: Record<string, Uint8Array> = {
      '/a.txt': new Uint8Array([104, 101, 108, 108, 111]),
      '/empty.txt': new Uint8Array([]),
      '/docs/b.bin': new Uint8Array([97, 98, 99]),
    }
    vi.mocked(client.dropboxRpc).mockImplementation((_tm, endpoint, body) => {
      if (endpoint === '/files/list_folder') {
        const p = (body as { path: string }).path
        return Promise.resolve({ entries: tree[p], cursor: 'c', has_more: false })
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    })
    vi.mocked(client.dropboxDownload).mockImplementation((_tm, path) => {
      const data = contents[path]
      if (data === undefined) throw new Error(`no content for ${path}`)
      return Promise.resolve(data)
    })

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const files: string[] = []
    const stack = ['/']
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) break
      const listing = await readdir(accessor, PathSpec.fromStrPath(current), index)
      for (const child of listing) {
        const trimmed = child.replace(/\/$/, '')
        const info = await stat(accessor, PathSpec.fromStrPath(trimmed), index)
        if (info.type === FileType.DIRECTORY) {
          stack.push(trimmed)
          continue
        }
        expect(info.size).not.toBeNull()
        const bytes = await read(accessor, PathSpec.fromStrPath(trimmed), index)
        expect(info.size).toBe(bytes.length)
        files.push(trimmed)
      }
    }
    expect(files.sort()).toEqual(['/a.txt', '/docs/b.bin', '/empty.txt'])
  })
})
