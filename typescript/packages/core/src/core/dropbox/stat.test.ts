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
import { ContentType, FileType, PathSpec } from '../../types.ts'
import * as client from './client.ts'
import { DropboxApiError, type DropboxTokenManager } from './client.ts'
import type { DropboxEntry } from './api.ts'
import { stat } from './stat.ts'
import { read } from './read.ts'
import { readdir } from './readdir.ts'
import { FakeDropboxRpc } from './_test_util.ts'
import { handedAt } from '../../workspace/fixtures/handed.ts'

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
  content_hash: 'hash-a',
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
      new PathSpec({ vfsPath: '', virtual: '/', directory: '/' }),
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('/')
    expect(fake.listRequests).toBe(0)
  })

  it('resolves a file through get_metadata', async () => {
    // Dropbox addresses by path: stat is one get_metadata.
    const fake = new FakeDropboxRpc({ metadata: FILE_ENTRY })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    const out = await stat(makeAccessor(), PathSpec.fromStrPath('/a.txt'))
    expect(out.content).toBe(ContentType.TEXT)
    expect(out.name).toBe('a.txt')
    expect(out.size).toBe(5)
    expect(out.modified).toBe('2026-04-01T00:00:00Z')
    expect(out.fingerprint).toBe('hash-a')
    expect(out.extra.dropbox_id).toBe('id:a')
    expect(out.extra.resource_type).toBe('dropbox/file')
  })

  it('resolves a folder through get_metadata', async () => {
    const fake = new FakeDropboxRpc({ metadata: FOLDER_ENTRY })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    const out = await stat(makeAccessor(), PathSpec.fromStrPath('/docs'))
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('docs')
    expect(out.size).toBeNull()
    expect(out.extra.dropbox_id).toBe('id:docs')
  })

  it('maps a 409 to ENOENT', async () => {
    const fake = new FakeDropboxRpc({ metadata: null })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    await expect(stat(makeAccessor(), PathSpec.fromStrPath('/ghost.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
      virtualPath: '/ghost.txt',
    })
  })

  it('propagates a non-409 error', async () => {
    // A rate-limit or server error is not absence: it must surface.
    vi.mocked(client.dropboxRpc).mockRejectedValue(new DropboxApiError('boom', 500))
    await expect(stat(makeAccessor(), PathSpec.fromStrPath('/a.txt'))).rejects.toMatchObject({
      status: 500,
    })
  })

  // statFromEntry fallbacks: server_modified→client_modified→'',
  // id→path_display→name, no content_hash is no token, and a non-number/absent
  // size renders as null (the unknown-size machinery, never a fabricated
  // number).
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
      null,
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

  // Every other test runs on an unprefixed mount; this pins the prefix
  // arithmetic of the path get_metadata is asked for.
  it('honors the mount prefix', async () => {
    const fake = new FakeDropboxRpc({ metadata: FILE_ENTRY })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    const out = await stat(
      makeAccessor(),
      new PathSpec({
        virtual: '/dropbox/a.txt',
        directory: '/dropbox',
        vfsPath: mountKey('/dropbox/a.txt', '/dropbox'),
      }),
    )
    expect(out.content).toBe(ContentType.TEXT)
    expect(out.name).toBe('a.txt')
    expect(out.size).toBe(5)
    expect(fake.metadataPaths).toEqual(['/a.txt'])
  })

  it('serves a size for every listed file that matches its read length', async () => {
    // The fskit invariant behind sizes_always_known: the size stat serves
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
    const byPath = new Map(
      Object.values(tree).flatMap((kids) => kids.map((e) => [e.path_display, e])),
    )
    vi.mocked(client.dropboxRpc).mockImplementation((_tm, endpoint, body) => {
      if (endpoint === '/files/list_folder') {
        const p = (body as { path: string }).path
        return Promise.resolve({ entries: tree[p], cursor: 'c', has_more: false })
      }
      if (endpoint === '/files/get_metadata') {
        return Promise.resolve(byPath.get((body as { path: string }).path))
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    })
    vi.mocked(client.dropboxDownload).mockImplementation((_tm, path) => {
      const data = contents[path]
      if (data === undefined) throw new Error(`no content for ${path}`)
      return Promise.resolve([data, null])
    })

    const accessor = makeAccessor()
    const files: string[] = []
    const stack = ['/']
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) break
      const listing = await readdir(accessor, PathSpec.fromStrPath(current))
      for (const child of listing) {
        const trimmed = `${current.replace(/\/$/, '')}/${child.name}`
        const spec = PathSpec.fromStrPath(trimmed)
        const info = await stat(accessor, spec)
        if (info.type === FileType.DIRECTORY) {
          stack.push(trimmed)
          continue
        }
        expect(info.size).not.toBeNull()
        const handed = await handedAt(readdir, accessor, spec)
        const bytes = await read(accessor, spec, undefined, handed.entry)
        expect(info.size).toBe(bytes.length)
        files.push(trimmed)
      }
    }
    expect(files.sort()).toEqual(['/a.txt', '/docs/b.bin', '/empty.txt'])
  })

  // One get_metadata, never a listing of the parent: the mount keeps
  // listings and answers a listed path itself.
  it('asks one lookup', async () => {
    const fake = new FakeDropboxRpc({ entries: [FILE_ENTRY], metadata: FILE_ENTRY })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    const out = await stat(
      makeAccessor(),
      new PathSpec({ vfsPath: 'a.txt', virtual: '/a.txt', directory: '/' }),
    )
    expect(out.fingerprint).toBe('hash-a')
    expect(fake.listRequests).toBe(0)
    expect(fake.metadataPaths).toEqual(['/a.txt'])
  })

  // A restricted file exists, so a fresh probe must not hear ENOENT and drop
  // its overlay; a 5xx body naming not_found is a relay's.
  const answers: [string, number, string, Record<string, unknown>][] = [
    ['not-found', 409, 'path/not_found/..', { code: 'ENOENT' }],
    ['not-folder', 409, 'path/not_folder/..', { code: 'ENOENT' }],
    ['restricted', 409, 'path/restricted_content/..', { status: 409 }],
    ['5xx', 502, 'path/not_found/..', { status: 502 }],
  ]
  it.each(answers)('reads only a miss as ENOENT (%s)', async (_id, status, summary, raised) => {
    vi.mocked(client.dropboxRpc).mockRejectedValue(new DropboxApiError('refused', status, summary))
    await expect(
      stat(makeAccessor(), new PathSpec({ vfsPath: 'a.txt', virtual: '/a.txt', directory: '/' })),
    ).rejects.toMatchObject(raised)
  })

  // get_metadata matches case-insensitively where a listing is exact.
  it('reports ENOENT when get_metadata answers another case', async () => {
    const fake = new FakeDropboxRpc({ metadata: FILE_ENTRY })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    await expect(stat(makeAccessor(), PathSpec.fromStrPath('/A.TXT'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
