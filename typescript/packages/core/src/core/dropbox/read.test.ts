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

import { materialize } from '../../io/types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'
import type * as ApiModule from './api.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, dropboxDownload: vi.fn(), dropboxDownloadStream: vi.fn() }
})

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, listFolder: vi.fn() }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { captureRead, runWithWriteContext } from '../../cache/context.ts'
import type { WriteContext } from '../../cache/types.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { handedAt } from '../../../tests/workspace/fixtures/handed.ts'
import * as client from './client.ts'
import type { DropboxTokenManager } from './client.ts'
import * as api from './api.ts'
import { read, readStream } from './read.ts'
import { DropboxVFS } from '../../vfs/dropbox/dropbox.ts'
import { readdir } from './readdir.ts'
import { runWithRecording } from '../../observe/context.ts'

const STUB_TM = {} as DropboxTokenManager

function makeAccessor(): DropboxAccessor {
  return new DropboxAccessor({ tokenManager: STUB_TM })
}

// The row a listing names for a file: Dropbox downloads by path, so it only
// says a file is there.
const NOTE = new FileStat({ name: 'note.txt', type: FileType.FILE })

// What the mount hands a read at `path`, found by listing as it would.
async function listed(accessor: DropboxAccessor, path: PathSpec): Promise<FileStat | null> {
  return (await handedAt((a, p) => readdir(a, p), accessor, path)).entry ?? null
}

describe('dropbox read', () => {
  it('downloads a file by stripping prefix and using path-based API', async () => {
    vi.mocked(api.listFolder).mockResolvedValue([
      {
        '.tag': 'file',
        id: 'id:1',
        name: 'note.txt',
        path_display: '/note.txt',
        size: 5,
      },
    ])
    vi.mocked(client.dropboxDownload).mockResolvedValue([new Uint8Array([104, 105, 33]), null])

    const accessor = makeAccessor()
    const path = new PathSpec({
      virtual: '/dropbox/note.txt',
      directory: '/dropbox',
      vfsPath: mountKey('/dropbox/note.txt', '/dropbox'),
    })
    const data = await read(accessor, path, undefined, await listed(accessor, path))
    expect(data).toEqual(new Uint8Array([104, 105, 33]))
    expect(client.dropboxDownload).toHaveBeenCalledWith(STUB_TM, '/note.txt', undefined)
  })

  it('downloads through the subfolder mount root', async () => {
    vi.mocked(api.listFolder).mockResolvedValue([
      {
        '.tag': 'file',
        id: 'id:1',
        name: 'note.txt',
        path_display: '/Team/data/note.txt',
        size: 5,
      },
    ])
    vi.mocked(client.dropboxDownload).mockResolvedValue([new Uint8Array([104, 105]), null])

    const accessor = new DropboxAccessor({ tokenManager: STUB_TM, rootPath: 'Team/data' })
    const path = new PathSpec({
      virtual: '/dropbox/note.txt',
      directory: '/dropbox',
      vfsPath: mountKey('/dropbox/note.txt', '/dropbox'),
    })
    const data = await read(accessor, path, undefined, await listed(accessor, path))
    expect(data).toEqual(new Uint8Array([104, 105]))
    expect(client.dropboxDownload).toHaveBeenCalledWith(STUB_TM, '/Team/data/note.txt', undefined)
  })

  it('throws EISDIR when path resolves to a folder', async () => {
    vi.mocked(api.listFolder).mockResolvedValue([
      { '.tag': 'folder', id: 'id:f', name: 'docs', path_display: '/docs' },
    ])

    const accessor = makeAccessor()
    const path = new PathSpec({ vfsPath: 'docs', virtual: '/docs', directory: '/docs' })
    const entry = await listed(accessor, path)
    await expect(
      read(accessor, path, undefined, entry),
      // The stamped code is the signal, not the message: the message is the
      // bare operand, which is what the shell renders and what Python's
      // IsADirectoryError(virtual) carries.
    ).rejects.toMatchObject({ code: 'EISDIR', virtualPath: '/docs' })
  })
})

describe('dropbox read stamps content_hash', () => {
  // The listing that resolved the entry lags the bytes: the token must come
  // from the download's own Dropbox-API-Result, never the row.
  const LISTING = [
    {
      '.tag': 'file' as const,
      id: 'id:1',
      name: 'note.txt',
      path_display: '/note.txt',
      size: 10,
      content_hash: 'stale',
    },
  ]
  const HEADER = JSON.stringify({ name: 'note.txt', content_hash: 'fresh' })
  const spec = new PathSpec({ virtual: '/note.txt', directory: '/', vfsPath: 'note.txt' })

  // A ranged read is answered 206 and still carries Dropbox-API-Result.
  it.each([
    ['full', undefined],
    ['ranged', { offset: 2, size: 3 }],
  ] as const)('%s records the download token', async (_id, window) => {
    vi.mocked(api.listFolder).mockResolvedValue(LISTING)
    vi.mocked(client.dropboxDownload).mockResolvedValue([new Uint8Array([1, 2, 3]), HEADER])
    const accessor = makeAccessor()
    const entry = await listed(accessor, spec)
    const [data, records] = await runWithRecording(() => read(accessor, spec, window, entry))
    expect(data).toEqual(new Uint8Array([1, 2, 3]))
    expect(records.map((r) => [r.op, r.bytes, r.fingerprint])).toEqual([['read', 3, 'fresh']])
  })

  // Outside a shell line (FUSE, a programmatic read) there is no recorder,
  // and the stream must still stream.
  it.each([true, false])('a stream records the token its response names (%s)', async (line) => {
    vi.mocked(api.listFolder).mockResolvedValue(LISTING)
    vi.mocked(client.dropboxDownloadStream).mockImplementation(
      async function* (_tm, _path, onResponse) {
        await Promise.resolve()
        onResponse?.({ 'dropbox-api-result': HEADER })
        yield new Uint8Array([1, 2])
        yield new Uint8Array([3])
      },
    )
    const accessor = makeAccessor()
    const entry = await listed(accessor, spec)
    const drain = async (): Promise<number[]> => {
      const out: number[] = []
      for await (const c of readStream(accessor, spec, entry)) {
        out.push(c.byteLength)
      }
      return out
    }
    if (!line) {
      expect(await drain()).toEqual([2, 1])
      return
    }
    const [sizes, records] = await runWithRecording(drain)
    expect(sizes).toEqual([2, 1])
    expect(records.map((r) => [r.op, r.bytes, r.fingerprint])).toEqual([['read', 3, 'fresh']])
  })

  // A miss says the listed file is no longer there, which the mount reads as
  // a stale row and lists again; anything else is a failure.
  it.each([
    [409, 'path/not_found/..', { code: 'ENOENT' }],
    [409, 'path/not_file/..', { code: 'EISDIR' }],
    [409, 'path/restricted_content/..', { status: 409 }],
    [500, 'path/not_found/..', { status: 500 }],
  ] as const)('maps only a listed read %s %s to ENOENT', async (status, summary, raised) => {
    vi.mocked(client.dropboxDownload).mockRejectedValue(
      new client.DropboxApiError('refused', status, summary),
    )
    await expect(read(makeAccessor(), spec, undefined, NOTE)).rejects.toMatchObject(raised)
  })

  // Dropbox matches a path without case: with N stored and no row for n,
  // truncate reads N's bytes and cuts them, where calling it absent would
  // upload zeros over N.
  it('keeps the file Dropbox resolves for a truncate with no row', async () => {
    const result = JSON.stringify({ '.tag': 'file', name: 'N', content_hash: 'h' })
    vi.mocked(client.dropboxDownload).mockResolvedValue([
      new TextEncoder().encode('abcdef'),
      result,
    ])
    const vfs = new DropboxVFS({ clientId: 'c', clientSecret: 's', refreshToken: 'r' })
    const written: Uint8Array[] = []
    vfs.write = async (_path, data) => {
      written.push(await materialize(data))
      return null
    }
    await vfs.truncate(new PathSpec({ virtual: '/n', directory: '/', vfsPath: 'n' }), 4)
    expect(written.map((data) => new TextDecoder().decode(data))).toEqual(['abcd'])
  })
})

describe('dropbox read publishes its token on a conditional mount', () => {
  const context: WriteContext = {
    vfs: 'dropbox',
    conditions: ['put', 'copy', 'delete'],
    readVersion: () => Promise.resolve(null),
    readVersions: (paths) => Promise.resolve(paths.map(() => null)),
    drop: () => Promise.resolve(),
    keep: () => Promise.resolve(),
  }

  it.each([
    ['whole', true, undefined, ['h1']],
    ['ranged', true, { offset: 2, size: 3 }, []],
    ['unconditional', false, undefined, []],
  ] as const)('%s', async (_name, conditional, options, published) => {
    vi.mocked(client.dropboxDownload).mockResolvedValue([
      new Uint8Array([104, 105]),
      JSON.stringify({ content_hash: 'h1' }),
    ])
    const path = new PathSpec({ virtual: '/a.txt', directory: '/', vfsPath: 'a.txt' })
    const [, tokens] = await runWithWriteContext('/', conditional ? context : null, () =>
      captureRead(path.virtual, () => read(makeAccessor(), path, options, NOTE)),
    )
    expect(tokens).toEqual(published)
  })
})
