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
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import * as client from './client.ts'
import type { DropboxTokenManager } from './client.ts'
import * as api from './api.ts'
import { read, readStream } from './read.ts'
import { runWithRecording } from '../../observe/context.ts'

const STUB_TM = {} as DropboxTokenManager

function makeAccessor(): DropboxAccessor {
  return new DropboxAccessor({ tokenManager: STUB_TM })
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
    const index = new RAMIndexCacheStore()
    const data = await read(
      accessor,
      new PathSpec({
        virtual: '/dropbox/note.txt',
        directory: '/dropbox',
        vfsPath: mountKey('/dropbox/note.txt', '/dropbox'),
      }),
      index,
    )
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
    const index = new RAMIndexCacheStore()
    const data = await read(
      accessor,
      new PathSpec({
        virtual: '/dropbox/note.txt',
        directory: '/dropbox',
        vfsPath: mountKey('/dropbox/note.txt', '/dropbox'),
      }),
      index,
    )
    expect(data).toEqual(new Uint8Array([104, 105]))
    expect(client.dropboxDownload).toHaveBeenCalledWith(STUB_TM, '/Team/data/note.txt', undefined)
  })

  it('throws EISDIR when path resolves to a folder', async () => {
    vi.mocked(api.listFolder).mockResolvedValue([
      { '.tag': 'folder', id: 'id:f', name: 'docs', path_display: '/docs' },
    ])

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await expect(
      read(
        accessor,
        new PathSpec({ vfsPath: 'docs', virtual: '/docs', directory: '/docs' }),
        index,
      ),
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
    ['full-indexed', true, undefined],
    ['ranged-indexed', true, { offset: 2, size: 3 }],
    ['full-bare', false, undefined],
    ['ranged-bare', false, { offset: 2, size: 3 }],
  ] as const)('%s records the download token', async (_id, indexed, window) => {
    vi.mocked(api.listFolder).mockResolvedValue(LISTING)
    vi.mocked(client.dropboxDownload).mockResolvedValue([new Uint8Array([1, 2, 3]), HEADER])
    const [data, records] = await runWithRecording(() =>
      read(makeAccessor(), spec, indexed ? new RAMIndexCacheStore() : undefined, window),
    )
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
    const drain = async (): Promise<number[]> => {
      const out: number[] = []
      for await (const c of readStream(makeAccessor(), spec, new RAMIndexCacheStore())) {
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

  // The ops factory's emulated truncate reads with no index.
  it.each([
    [409, { code: 'ENOENT' }],
    [500, { status: 500 }],
  ] as const)('maps only an index-less %s to ENOENT', async (status, raised) => {
    vi.mocked(client.dropboxDownload).mockRejectedValue(
      new client.DropboxApiError('refused', status, 'path/not_found/...'),
    )
    await expect(read(makeAccessor(), spec)).rejects.toMatchObject(raised)
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
      captureRead(path.virtual, () => read(makeAccessor(), path, undefined, options)),
    )
    expect(tokens).toEqual(published)
  })
})
