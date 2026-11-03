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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ByteSpool } from '../../io/spool.ts'
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return {
    ...actual,
    googleGet: vi.fn(),
    googleGetBytes: vi.fn(),
    googleDelete: vi.fn(),
    googleResumable: vi.fn(),
    googleSendBytes: vi.fn(),
  }
})

import type { TokenManager } from './client.ts'
import * as client from './client.ts'
import {
  deleteFile,
  downloadFile,
  downloadRevision,
  getFile,
  listAllFiles,
  listFiles,
  listSharedDrives,
  searchFiles,
  storageQuota,
  updateFileContent,
  uploadFile,
} from './drive.ts'

const STUB_TOKEN_MANAGER = {
  config: { clientId: 'cid', refreshToken: 'rt' },
} as TokenManager

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listFiles shared drive params', () => {
  it('sets corpus params when driveId is given', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ files: [] })
    await listFiles(STUB_TOKEN_MANAGER, { folderId: 'folder123', driveId: 'drive123' })
    const params = vi.mocked(client.googleGet).mock.calls[0]?.[2] as Record<string, unknown>
    expect(params.corpora).toBe('drive')
    expect(params.driveId).toBe('drive123')
    expect(params.includeItemsFromAllDrives).toBe('true')
    expect(params.supportsAllDrives).toBe('true')
  })

  it('omits corpus params when no driveId', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ files: [] })
    await listFiles(STUB_TOKEN_MANAGER, { folderId: 'folder123' })
    const params = vi.mocked(client.googleGet).mock.calls[0]?.[2] as Record<string, unknown>
    expect(params.corpora).toBeUndefined()
    expect(params.driveId).toBeUndefined()
  })
})

describe('listAllFiles', () => {
  it('searches every corpus', async () => {
    // The g* mounts must see Shared Drive files, like gdrive does. Without
    // the all-drives triple Drive answers from the user corpus only, so the
    // same account sees a Shared Drive spreadsheet under gdrive and not
    // under gsheets, with no error to explain the difference.
    vi.mocked(client.googleGet).mockResolvedValue({ files: [] })
    await listAllFiles(STUB_TOKEN_MANAGER)
    const params = vi.mocked(client.googleGet).mock.calls[0]?.[2] as Record<string, unknown>
    expect(params.corpora).toBe('allDrives')
    expect(params.includeItemsFromAllDrives).toBe('true')
    expect(params.supportsAllDrives).toBe('true')
    // allDrives is the union of every corpus, so naming one contradicts it.
    expect(params.driveId).toBeUndefined()
    // incompleteSearch is a partial-response field: unasked for, unreturned.
    expect(String(params.fields).startsWith('incompleteSearch,')).toBe(true)
  })

  it('reports an incomplete search from any page', async () => {
    vi.mocked(client.googleGet)
      .mockResolvedValueOnce({
        files: [{ id: 'f1', name: 'a.txt' }],
        incompleteSearch: true,
        nextPageToken: 'token2',
      })
      .mockResolvedValueOnce({ files: [{ id: 'f2', name: 'b.txt' }] })
    const { files, complete } = await listAllFiles(STUB_TOKEN_MANAGER)
    expect(files.map((f) => f.id)).toEqual(['f1', 'f2'])
    expect(complete).toBe(false)
  })
})

describe('listSharedDrives', () => {
  it('paginates across pages', async () => {
    vi.mocked(client.googleGet)
      .mockResolvedValueOnce({ drives: [{ id: 'drive1', name: 'Team' }], nextPageToken: 'next' })
      .mockResolvedValueOnce({ drives: [{ id: 'drive2', name: 'Projects' }] })
    const result = await listSharedDrives(STUB_TOKEN_MANAGER)
    expect(result).toEqual([
      { id: 'drive1', name: 'Team' },
      { id: 'drive2', name: 'Projects' },
    ])
    expect(vi.mocked(client.googleGet).mock.calls).toHaveLength(2)
    const firstParams = vi.mocked(client.googleGet).mock.calls[0]?.[2] as Record<string, unknown>
    const secondParams = vi.mocked(client.googleGet).mock.calls[1]?.[2] as Record<string, unknown>
    expect(firstParams.pageToken).toBeUndefined()
    expect(secondParams.pageToken).toBe('next')
  })
})

describe('shared-drive support flags', () => {
  it('downloadFile requests supportsAllDrives', async () => {
    vi.mocked(client.googleGetBytes).mockResolvedValue(new Uint8Array())
    await downloadFile(STUB_TOKEN_MANAGER, 'file123')
    expect(vi.mocked(client.googleGetBytes).mock.calls[0]?.[1]).toContain('supportsAllDrives=true')
  })

  it('deleteFile requests supportsAllDrives', async () => {
    vi.mocked(client.googleDelete).mockResolvedValue(undefined)
    await deleteFile(STUB_TOKEN_MANAGER, 'file123')
    expect(vi.mocked(client.googleDelete).mock.calls[0]?.[1]).toContain('supportsAllDrives=true')
  })
})

describe('the Drive field masks carry both content tokens', () => {
  beforeEach(() => {
    vi.mocked(client.googleGet).mockReset()
  })

  it('asks the listing for them inside files(...)', async () => {
    // The listing is where the freshness probe gets its token: _probe stats
    // with an empty index, so stat misses and warms through the parent
    // readdir, which is this call. Without these the probe's stat falls to
    // modifiedTime while the read stamps an md5.
    //
    // Asserted against the literal `files(` segment rather than the constant,
    // because a constant-identity assertion moves with the constant and none
    // of this repo's gdrive fakes honours a `fields` mask -- so this is the
    // only thing that catches a reverted FIELDS.
    vi.mocked(client.googleGet).mockResolvedValue({ files: [] })
    await listFiles(STUB_TOKEN_MANAGER, { folderId: 'root' })
    const params = vi.mocked(client.googleGet).mock.calls[0]?.[2] as Record<string, unknown>
    const fields = String(params.fields)
    const inner = fields.slice(fields.indexOf('files(') + 'files('.length)
    expect(inner).toContain('md5Checksum')
    expect(inner).toContain('headRevisionId')
  })

  it('asks files.get for them unwrapped', async () => {
    // A files.get answers a bare File resource, so its mask is top-level.
    // Wrapping these would ask for a field the response has no room for and
    // Drive would return neither, silently.
    vi.mocked(client.googleGet).mockResolvedValue({ id: 'f1' })
    await getFile(STUB_TOKEN_MANAGER, 'f1')
    const params = vi.mocked(client.googleGet).mock.calls[0]?.[2] as Record<string, unknown>
    const fields = String(params.fields)
    expect(fields).toContain('md5Checksum')
    expect(fields).toContain('headRevisionId')
    expect(fields).not.toContain('files(')
    expect(fields).toContain('owners')
    expect(fields).toContain('trashed')
  })
})

describe('searchFiles', () => {
  it('asks full text under the parents across every corpus', async () => {
    vi.mocked(client.googleGet)
      .mockResolvedValueOnce({ files: [{ id: 'f1', name: '' }], nextPageToken: 'p2' })
      .mockResolvedValueOnce({ files: [{ id: 'f2', name: '' }], incompleteSearch: true })
    const out = await searchFiles(STUB_TOKEN_MANAGER, "it's", ['root', 'f9'])
    expect(out).toEqual({ ids: ['f1', 'f2'], complete: false })
    const first = vi.mocked(client.googleGet).mock.calls[0]?.[2] as Record<string, unknown>
    expect(first.q).toBe(
      "fullText contains 'it\\'s' and trashed=false and ('root' in parents or 'f9' in parents)",
    )
    expect(first.corpora).toBe('allDrives')
    expect(first.orderBy).toBeUndefined()
    const second = vi.mocked(client.googleGet).mock.calls[1]?.[2] as Record<string, unknown>
    expect(second.pageToken).toBe('p2')
  })
})

describe('getFile', () => {
  it('sends the fields a caller names in place of the listing mask', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ id: 'f1' })
    await getFile(STUB_TOKEN_MANAGER, 'f1', 'headRevisionId,md5Checksum')
    const [, url, params] = vi.mocked(client.googleGet).mock.calls[0] ?? []
    expect(url).toMatch(/\/files\/f1$/)
    expect(params).toEqual({ fields: 'headRevisionId,md5Checksum', supportsAllDrives: 'true' })
  })
})

describe('storageQuota', () => {
  it('asks /about for the storage quota', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ storageQuota: { limit: '10', usage: '3' } })
    expect(await storageQuota(STUB_TOKEN_MANAGER)).toEqual({ limit: '10', usage: '3' })
    const [, url, params] = vi.mocked(client.googleGet).mock.calls[0] ?? []
    expect(url).toMatch(/\/about$/)
    expect(params).toEqual({ fields: 'storageQuota' })
  })

  it('answers empty when Drive gives no quota', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ storageQuota: null })
    expect(await storageQuota(STUB_TOKEN_MANAGER)).toEqual({})
  })
})

describe('downloadRevision', () => {
  it('reads the pinned revision over its window', async () => {
    const window = { offset: 3, size: 5 }
    vi.mocked(client.googleGetBytes).mockResolvedValue(new TextEncoder().encode('old'))
    const data = await downloadRevision(STUB_TOKEN_MANAGER, 'f1', 'r1', window)
    expect(new TextDecoder().decode(data)).toBe('old')
    const [, url, sent] = vi.mocked(client.googleGetBytes).mock.calls[0] ?? []
    expect(url).toMatch(/\/files\/f1\/revisions\/r1\?alt=media$/)
    expect(sent).toBe(window)
  })
})

const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const MIB = 1024 * 1024

// Drive takes at most 5 MB in one multipart or media request (its upload
// guide, not probed), so past 4 MiB an upload goes resumable whatever holds
// the bytes.
describe('drive upload protocol', () => {
  it.each(
    [false, true].flatMap((updating) =>
      [false, true].flatMap((spooled) =>
        [4 * MIB, 4 * MIB + 1].map((size) => [updating, spooled, size] as const),
      ),
    ),
  )(
    'a drive upload past 4 MiB goes resumable: update %s, spooled %s, %i bytes',
    async (updating, spooled, size) => {
      const payload = new Uint8Array(size).fill(97)
      const spool = new ByteSpool()
      await spool.append(payload)
      const data = spooled ? spool : payload
      vi.mocked(client.googleResumable).mockResolvedValue({ id: 'resumed' })
      vi.mocked(client.googleSendBytes).mockResolvedValue({ id: 'sent' })
      try {
        const reply = updating
          ? await updateFileContent(STUB_TOKEN_MANAGER, 'f1', data)
          : await uploadFile(STUB_TOKEN_MANAGER, 'a.txt', 'p1', data)
        if (size <= 4 * MIB) {
          expect(reply).toEqual({ id: 'sent' })
          expect(client.googleResumable).not.toHaveBeenCalled()
          const body = vi.mocked(client.googleSendBytes).mock.calls[0]?.[3] ?? new Uint8Array()
          if (updating) expect(Buffer.compare(body, payload)).toBe(0)
          else expect(Buffer.from(body).includes(Buffer.from(payload))).toBe(true)
          return
        }
        expect(reply).toEqual({ id: 'resumed' })
        expect(client.googleSendBytes).not.toHaveBeenCalled()
        const args = vi.mocked(client.googleResumable).mock.calls[0] ?? []
        expect(args.slice(0, 4)).toEqual(
          updating
            ? [STUB_TOKEN_MANAGER, 'PATCH', `${UPLOAD}/f1`, {}]
            : [STUB_TOKEN_MANAGER, 'POST', UPLOAD, { name: 'a.txt', parents: ['p1'] }],
        )
        // The input itself: a spool is streamed from, never read into memory.
        expect(args[4]).toBe(data)
        expect(args[5]).toBe('application/octet-stream')
        expect(args[6]).toEqual({
          supportsAllDrives: 'true',
          fields:
            'id,name,mimeType,driveId,size,quotaBytesUsed,createdTime,modifiedTime,md5Checksum,headRevisionId,parents,owners,trashed',
        })
      } finally {
        await spool.close()
      }
    },
  )
})
