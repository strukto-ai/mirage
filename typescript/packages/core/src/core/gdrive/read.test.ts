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
import type * as DriveModule from '../google/drive.ts'
import type * as VersionsModule from './versions.ts'
import type * as ContextModule from '../../observe/context.ts'

// A read outside any recording scope reaches record() and returns early, so
// the token it computed is only visible here. Everything else passes through.
const UNRECORDED = vi.hoisted(() => ({ records: [] as [string, ContextModule.RecordOptions][] }))

vi.mock('../../observe/context.ts', async () => {
  const actual = await vi.importActual<typeof ContextModule>('../../observe/context.ts')
  return {
    ...actual,
    record: (
      op: string,
      path: string,
      source: string,
      nbytes: number,
      timer: ContextModule.OpTimer,
      options: ContextModule.RecordOptions = {},
    ): void => {
      if (!actual.recordingActive()) UNRECORDED.records.push([path, options])
      actual.record(op, path, source, nbytes, timer, options)
    },
  }
})

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  return { ...actual, listFiles: vi.fn(), downloadFile: vi.fn(), getFile: vi.fn() }
})

vi.mock('./versions.ts', async () => {
  const actual = await vi.importActual<typeof VersionsModule>('./versions.ts')
  return { ...actual, downloadRevision: vi.fn(), captureFileMetadata: vi.fn() }
})

vi.mock('../gdocs/read.ts', () => ({ readDoc: vi.fn() }))
vi.mock('../gsheets/read.ts', () => ({ readSpreadsheet: vi.fn() }))
vi.mock('../gslides/read.ts', () => ({ readPresentation: vi.fn() }))

import { GDriveAccessor } from '../../accessor/gdrive.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/client.ts'
import { runWithRecording, runWithRevisions } from '../../observe/context.ts'
import * as drive from '../google/drive.ts'
import { read, readFileVersioned } from './read.ts'
import { stat } from './stat.ts'
import * as versions from './versions.ts'
import * as gdocs from '../gdocs/read.ts'
import * as gsheets from '../gsheets/read.ts'
import * as gslides from '../gslides/read.ts'
import { md5Hex } from '../../utils/hash.ts'

const VERSIONED_ENTRY = new IndexEntry({
  id: 'f1',
  name: 'f.txt',
  resourceType: 'gdrive/file',
  vfsName: 'f.txt',
})

const STUB_TOKEN_MANAGER = {
  config: { clientId: 'cid', refreshToken: 'rt' },
} as TokenManager

function makeAccessor(): GDriveAccessor {
  return new GDriveAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

beforeEach(() => {
  vi.clearAllMocks()
  UNRECORDED.records.length = 0
})

describe('gdrive read auto-bootstrap', () => {
  it('refetches root listing when entry is evicted from index', async () => {
    vi.mocked(drive.listFiles).mockImplementation((_tm, opts) => {
      if (opts?.folderId === 'root') {
        return Promise.resolve([
          {
            id: 'f1',
            name: 'report.pdf',
            mimeType: 'application/pdf',
            modifiedTime: '2026-04-01T00:00:00.000Z',
          },
        ])
      }
      throw new Error(`unexpected folderId=${String(opts?.folderId)}`)
    })
    vi.mocked(drive.downloadFile).mockResolvedValue(new TextEncoder().encode('pdf-bytes'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      vfsPath: 'report.pdf',
      virtual: '/report.pdf',
      directory: '/report.pdf',
    })
    const out = await read(accessor, path, index)
    expect(new TextDecoder().decode(out)).toBe('pdf-bytes')
  })

  it('throws ENOENT when file missing even after recursion', async () => {
    vi.mocked(drive.listFiles).mockImplementation((_tm, opts) => {
      if (opts?.folderId === 'root') {
        return Promise.resolve([
          {
            id: 'f1',
            name: 'other.txt',
            mimeType: 'text/plain',
            modifiedTime: '2026-04-01T00:00:00.000Z',
          },
        ])
      }
      throw new Error(`unexpected folderId=${String(opts?.folderId)}`)
    })
    vi.mocked(drive.downloadFile).mockRejectedValue(new Error('should not call downloadFile'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      vfsPath: 'missing.txt',
      virtual: '/missing.txt',
      directory: '/missing.txt',
    })
    await expect(read(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // Mirrors test_read_propagates_parent_refresh_failure: only an absent
  // parent may collapse into the operand's ENOENT.
  it('propagates a failed parent listing instead of reporting ENOENT', async () => {
    vi.mocked(drive.listFiles).mockRejectedValue(new Error('drive unavailable'))
    vi.mocked(drive.downloadFile).mockRejectedValue(new Error('should not call downloadFile'))
    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      vfsPath: 'missing.txt',
      virtual: '/missing.txt',
      directory: '/missing.txt',
    })
    await expect(read(accessor, path, index)).rejects.toThrow(/drive unavailable/)
  })

  it('throws EISDIR when reading a shared drive root', async () => {
    vi.mocked(drive.downloadFile).mockRejectedValue(new Error('should not call downloadFile'))
    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [
      [
        'Team Drive',
        new IndexEntry({
          id: 'drive1',
          name: 'Team Drive',
          resourceType: 'gdrive/shared_drive',
          vfsName: 'Team Drive',
          extra: { drive_id: 'drive1' },
        }),
      ],
    ])
    const path = new PathSpec({
      vfsPath: 'Team Drive',
      virtual: '/Team Drive',
      directory: '/Team Drive',
    })
    // The stamped code is the signal, not the message: the message is the
    // bare operand, which is what the shell renders (`cat: /Team Drive: Is a
    // directory`) and what Python's IsADirectoryError(virtual) carries.
    await expect(read(accessor, path, index)).rejects.toMatchObject({
      code: 'EISDIR',
      virtualPath: '/Team Drive',
    })
    expect(vi.mocked(drive.downloadFile)).not.toHaveBeenCalled()
  })
})

describe('gdrive versioned reads', () => {
  it('a pinned path reads that revision, not live content', async () => {
    const enc = new TextEncoder()
    vi.mocked(versions.downloadRevision).mockResolvedValue(enc.encode('pinned'))
    const data = await runWithRevisions(new Map([['/data/f.txt', 'r1']]), () =>
      readFileVersioned(STUB_TOKEN_MANAGER, 'f1', '/data/f.txt', VERSIONED_ENTRY),
    )
    expect(new TextDecoder().decode(data)).toBe('pinned')
    expect(versions.downloadRevision).toHaveBeenCalledWith(
      STUB_TOKEN_MANAGER,
      'f1',
      'r1',
      undefined,
    )
    expect(drive.downloadFile).not.toHaveBeenCalled()
  })

  it('an unpinned unrecorded read skips the metadata call', async () => {
    const enc = new TextEncoder()
    vi.mocked(drive.downloadFile).mockResolvedValue(enc.encode('live'))
    const data = await readFileVersioned(STUB_TOKEN_MANAGER, 'f1', '/data/f.txt', VERSIONED_ENTRY)
    expect(new TextDecoder().decode(data)).toBe('live')
    expect(versions.captureFileMetadata).not.toHaveBeenCalled()
  })
})

// A key named like its mount: neither `m/k.txt` nor `/m/k.txt` is virtual.
describe('gdrive read record path', () => {
  it('records the virtual path for a binary file', async () => {
    vi.mocked(versions.captureFileMetadata).mockResolvedValue([null, null, null])
    vi.mocked(drive.downloadFile).mockResolvedValue(new TextEncoder().encode('live'))
    const index = new RAMIndexCacheStore()
    await index.setDir('/m/m', [
      [
        'k.txt',
        new IndexEntry({
          id: 'f1',
          name: 'k.txt',
          resourceType: 'gdrive/file',
          vfsName: 'k.txt',
        }),
      ],
    ])
    const path = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })
    const [data, records] = await runWithRecording(() => read(makeAccessor(), path, index))
    expect(new TextDecoder().decode(data)).toBe('live')
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })
})

const CONTENT = new TextEncoder().encode('pdf content here')
const DIGEST = md5Hex(CONTENT)
const REVISION = 'file123-r1'
const STAMP = '2026-04-01T00:00:00.000Z'

function binaryEntry(): IndexEntry {
  return new IndexEntry({
    id: 'file123',
    name: 'report',
    resourceType: 'gdrive/file',
    remoteTime: STAMP,
    vfsName: 'report.pdf',
    extra: { md5_checksum: DIGEST, head_revision_id: REVISION },
  })
}

function specFor(name = 'report.pdf', mount = ''): PathSpec {
  return new PathSpec({ vfsPath: name, virtual: `${mount}/${name}`, directory: `${mount}/${name}` })
}

describe('the gdrive read record', () => {
  beforeEach(() => {
    vi.mocked(versions.captureFileMetadata).mockResolvedValue([DIGEST, REVISION, STAMP])
    vi.mocked(drive.downloadFile).mockResolvedValue(CONTENT)
  })

  it('stamps the token stat stamps', async () => {
    // The whole defect in one assertion: a `fresh` mount compares the cache
    // entry's token against stat's, so the two must be the same value for the
    // same unchanged file. The literal md5 is asserted too, because equality
    // alone still holds under a chain mutated to md5-only while every native
    // file silently loses its token.
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [['report.pdf', binaryEntry()]])
    const path = specFor()
    const [, records] = await runWithRecording(async () => read(makeAccessor(), path, index))
    const st = await stat(makeAccessor(), path, index)
    expect(records[0]?.fingerprint).toBe(DIGEST)
    expect(st.fingerprint).toBe(records[0]?.fingerprint)
  })

  it('records the virtual path on a root mount too', async () => {
    // On a root mount the virtual and mount paths agree, so this is the
    // control for the /gd row: only that one tells them apart.
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [['report.pdf', binaryEntry()]])
    const [, records] = await runWithRecording(async () => read(makeAccessor(), specFor(), index))
    expect(records[0]?.path).toBe('/report.pdf')
  })

  it('keeps the boundary for a name sharing the prefix leading text', async () => {
    // A mount at /gd holding 'gd-report.pdf': the index key is derived from
    // the mount prefix, and a name sharing its leading text must still
    // resolve under /gd, or the read throws ENOENT before it records.
    const index = new RAMIndexCacheStore()
    await index.setDir('/gd', [['gd-report.pdf', binaryEntry()]])
    const [, records] = await runWithRecording(async () =>
      read(makeAccessor(), specFor('gd-report.pdf', '/gd'), index),
    )
    expect(records[0]?.path).toBe('/gd/gd-report.pdf')
  })

  it('stamps the same token through the API stat door', async () => {
    // stat has two doors and the index arm is only one of them: a cold cache
    // that cannot list the parent falls to statFromApi, which reads its own
    // getFile. Fixing the index arm alone leaves this one on a timestamp.
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [['report.pdf', binaryEntry()]])
    vi.mocked(drive.getFile).mockResolvedValue({
      id: 'file123',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      modifiedTime: STAMP,
      size: String(CONTENT.length),
      md5Checksum: DIGEST,
      headRevisionId: REVISION,
    })
    vi.mocked(drive.listFiles).mockResolvedValue([
      {
        id: 'file123',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        modifiedTime: STAMP,
      },
    ])
    const [, records] = await runWithRecording(async () => read(makeAccessor(), specFor(), index))
    // `undefined` index is statFromApi's own door, taken before any warm.
    const apiStat = await stat(makeAccessor(), specFor(), undefined)
    expect(apiStat.fingerprint).toBe(DIGEST)
    expect(apiStat.fingerprint).toBe(records[0]?.fingerprint)
  })

  it('records the virtual path', async () => {
    // latestFingerprint matches the record against the virtual cache key; the
    // mount path ('/report.pdf') names nothing under a mount at /gd.
    const index = new RAMIndexCacheStore()
    await index.setDir('/gd', [['report.pdf', binaryEntry()]])
    const [, records] = await runWithRecording(async () =>
      read(makeAccessor(), specFor(undefined, '/gd'), index),
    )
    expect(records[0]?.path).toBe('/gd/report.pdf')
  })

  it('keeps the captured revision on a windowed read', async () => {
    // A window proves nothing about the revision: the bytes are a slice of
    // the object the capture named, so the pin is still true even though the
    // fingerprint cannot be stamped.
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [['report.pdf', binaryEntry()]])
    const [, records] = await runWithRecording(async () =>
      read(makeAccessor(), specFor(), index, { offset: 1, size: 4 }),
    )
    expect(records[0]?.fingerprint).toBeNull()
    expect(records[0]?.revision).toBe(REVISION)
  })

  it('drops a captured md5 that disagrees with the bytes', async () => {
    // The capture and the download are two separate requests, so a writer
    // that changes the file between them caches bytes B under md5(A). A later
    // revert to A then reads as FRESH and serves B, silently.
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [['report.pdf', binaryEntry()]])
    vi.mocked(versions.captureFileMetadata).mockResolvedValue([
      md5Hex(new TextEncoder().encode('the previous content')),
      REVISION,
      STAMP,
    ])
    const [, records] = await runWithRecording(async () => read(makeAccessor(), specFor(), index))
    expect(records[0]?.fingerprint).toBeNull()
    // And the revision goes with it: it came from the same capture, so the
    // disagreement is proof it describes the old content too. Keeping it
    // would be worse than keeping nothing, because a revision pin REPLACES
    // the drift check rather than supplementing it.
    expect(records[0]?.revision).toBeNull()
  })

  it('stamps no token on a ranged read', async () => {
    // The stub answers the WHOLE content whatever the window, so the
    // whole-file guard is the only thing between this read and a stamp. A
    // stub that returned the window would make the digests disagree and this
    // would pass either way.
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [['report.pdf', binaryEntry()]])
    const [, records] = await runWithRecording(async () =>
      read(makeAccessor(), specFor(), index, { offset: 1, size: 4 }),
    )
    expect(records[0]?.fingerprint).toBeNull()
  })

  it('stamps no token on a size-capped read from zero', async () => {
    // The guard is `offset !== 0 || size !== null`, and a window at offset 1
    // trips both halves at once -- so dropping the size half would leave the
    // other ranged test green while `head -c N` stamped a whole-object token.
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [['report.pdf', binaryEntry()]])
    const [, records] = await runWithRecording(async () =>
      read(makeAccessor(), specFor(), index, { offset: 0, size: 4 }),
    )
    expect(records[0]?.fingerprint).toBeNull()
  })

  it('stamps the token on the whole-file control', async () => {
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [['report.pdf', binaryEntry()]])
    const [, records] = await runWithRecording(async () => read(makeAccessor(), specFor(), index))
    expect(records[0]?.fingerprint).toBe(DIGEST)
  })

  it('stamps a capture with no md5 unverified', async () => {
    // Drive withholds md5Checksum for some binary files. There is nothing to
    // verify, and dropping the token would leave the read at null against
    // stat's head revision -- the mismatch this change removes.
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [['report.pdf', binaryEntry()]])
    vi.mocked(versions.captureFileMetadata).mockResolvedValue([null, REVISION, STAMP])
    const [, records] = await runWithRecording(async () => read(makeAccessor(), specFor(), index))
    expect(records[0]?.fingerprint).toBe(REVISION)
  })

  it('does not block the event loop while hashing', async () => {
    // md5Hex is a synchronous pure-JS MD5 -- WebCrypto has no MD5 and core
    // cannot import node:crypto -- so hashing a large read in one go stalls
    // the loop that serves a TS FUSE mount, and the kernel then fails every
    // later op with `Device not configured`. Big enough to span several
    // chunks, small enough to stay fast.
    const BIG = new Uint8Array(4 * 1024 * 1024).fill(7)
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [['report.pdf', binaryEntry()]])
    vi.mocked(drive.downloadFile).mockResolvedValue(BIG)
    vi.mocked(versions.captureFileMetadata).mockResolvedValue([md5Hex(BIG), REVISION, STAMP])
    // Order, not eventual firing: `await timer` resolves only after the
    // callback that would set a flag, so a flag assertion cannot fail once
    // reached and passes against a fully synchronous hash too. The timeout is
    // queued before the read starts, and every dependency here is
    // mockResolvedValue, so a synchronous hash finishes in microtasks and
    // pushes 'read' first while a yielding one lets the macrotask in.
    const order: string[] = []
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push('timer')
        resolve()
      }, 0),
    )
    const reading = runWithRecording(async () => read(makeAccessor(), specFor(), index)).then(
      (v) => {
        order.push('read')
        return v
      },
    )
    const [, [, records]] = await Promise.all([timer, reading])
    expect(order[0]).toBe('timer')
    expect(records[0]?.fingerprint).toBe(md5Hex(BIG))
  })
})

const NATIVE: [string, string, () => { mockResolvedValue: (v: Uint8Array) => void }][] = [
  ['gdrive/gdoc', 'doc.gdoc.json', () => vi.mocked(gdocs.readDoc)],
  ['gdrive/gsheet', 'book.gsheet.json', () => vi.mocked(gsheets.readSpreadsheet)],
  ['gdrive/gslide', 'deck.gslide.json', () => vi.mocked(gslides.readPresentation)],
]

function nativeEntry(resourceType: string, vfsName: string, headRevision?: string): IndexEntry {
  // Drive gives a native file neither md5Checksum nor headRevisionId, so the
  // default carries neither and the stamp is the only token -- the case the
  // chain's third step exists for. The revision test seeds one deliberately,
  // because its assertion would hold whatever the code did otherwise.
  return new IndexEntry({
    id: 'doc123',
    name: 'doc',
    resourceType,
    remoteTime: STAMP,
    vfsName,
    extra: headRevision === undefined ? {} : { head_revision_id: headRevision },
  })
}

describe('the native gdrive read record', () => {
  for (const [resourceType, vfsName, renderer] of NATIVE) {
    it(`records no revision for ${vfsName}`, async () => {
      // A revision pin REPLACES the drift check and the native branch can
      // never honour one, so recording it would kill the check it displaced.
      const index = new RAMIndexCacheStore()
      await index.setDir('/gd', [[vfsName, nativeEntry(resourceType, vfsName, 'doc123-r1')]])
      renderer().mockResolvedValue(new TextEncoder().encode('{}'))
      const [, records] = await runWithRecording(async () =>
        read(makeAccessor(), specFor(vfsName, '/gd'), index),
      )
      expect(records[0]?.revision).toBeNull()
    })

    it(`stamps no token on a windowed read of ${vfsName}`, async () => {
      // The native branch runs the same whole-file guard the binary branch
      // does: the chain describes the whole render, so a window stamped with
      // it would cache a partial body that reads FRESH for the life of the
      // entry.
      const index = new RAMIndexCacheStore()
      await index.setDir('/gd', [[vfsName, nativeEntry(resourceType, vfsName)]])
      renderer().mockResolvedValue(new TextEncoder().encode('{"tabs": [1,2,3]}'))
      const [, records] = await runWithRecording(async () =>
        read(makeAccessor(), specFor(vfsName, '/gd'), index, { offset: 2, size: 5 }),
      )
      expect(records[0]?.bytes).toBe(5)
      expect(records[0]?.fingerprint).toBeNull()
    })

    it(`records its token at the virtual path for ${vfsName}`, async () => {
      // Without this record a `fresh` mount re-renders every gdoc on every
      // read. The native arm makes its own record() call, so its path is
      // asserted here rather than inherited from the binary rows.
      const index = new RAMIndexCacheStore()
      await index.setDir('/gd', [[vfsName, nativeEntry(resourceType, vfsName)]])
      const rendered = new TextEncoder().encode('{"tabs": []}')
      renderer().mockResolvedValue(rendered)
      const [, records] = await runWithRecording(async () =>
        read(makeAccessor(), specFor(vfsName, '/gd'), index),
      )
      expect(records.length).toBe(1)
      expect(records[0]?.path).toBe(`/gd/${vfsName}`)
      expect(records[0]?.fingerprint).toBe(STAMP)
    })
  }
})

const BODY = new TextEncoder().encode('quarterly numbers\n')
const BODY_MD5 = md5Hex(BODY)
const UNRECORDED_STAMP = '2026-01-02T00:00:00Z'
const UNRECORDED_SPEC = new PathSpec({ virtual: '/gd/a.txt', directory: '/gd/', vfsPath: 'a.txt' })

async function readUnrecorded(
  extra: Record<string, unknown>,
  options?: { offset?: number; size?: number },
): Promise<[string, ContextModule.RecordOptions][]> {
  // Seeded straight into the index rather than warmed through readdir:
  // readdir drops an empty or missing md5, so a warmed entry could not carry
  // the odd shapes these rows need.
  const index = new RAMIndexCacheStore()
  await index.setDir('/gd', [
    [
      'a.txt',
      new IndexEntry({
        id: 'file123',
        name: 'a.txt',
        resourceType: 'gdrive/file',
        remoteTime: UNRECORDED_STAMP,
        vfsName: 'a.txt',
        extra,
      }),
    ],
  ])
  const offset = options?.offset ?? 0
  vi.mocked(drive.downloadFile).mockResolvedValue(
    BODY.slice(offset, options?.size === undefined ? undefined : offset + options.size),
  )
  vi.mocked(versions.captureFileMetadata).mockResolvedValue([null, null, null])
  await read(makeAccessor(), UNRECORDED_SPEC, index, options)
  return UNRECORDED.records
}

describe('an unrecorded gdrive read', () => {
  it('stamps the entry md5', async () => {
    const records = await readUnrecorded({ md5_checksum: BODY_MD5 })
    expect(records).toEqual([['/gd/a.txt', { fingerprint: BODY_MD5, revision: null }]])
  })

  it('drops a stale entry md5', async () => {
    // The listing predates the download; an md5 that no longer describes the
    // bytes must not label them.
    const records = await readUnrecorded({ md5_checksum: '0'.repeat(32), head_revision_id: 'r7' })
    expect(records[0]?.[1].fingerprint).toBeNull()
  })

  it('stamps the head revision when the entry has no md5 key', async () => {
    // The key is absent, not null: an unguarded `!== null` would hash the
    // body against `undefined` and drop every token.
    const records = await readUnrecorded({ head_revision_id: 'r7' })
    expect(records[0]?.[1].fingerprint).toBe('r7')
  })

  it('stamps the modified time when the entry has neither', async () => {
    const records = await readUnrecorded({})
    expect(records[0]?.[1].fingerprint).toBe(UNRECORDED_STAMP)
  })

  for (const [label, odd] of [
    ['empty', ''],
    ['non-string', 123],
  ] as const) {
    it(`falls through an ${label} md5 to the head revision`, async () => {
      // An empty string is what a listing that omits the field leaves once
      // coerced, and a non-string is what a restored index can hold.
      const records = await readUnrecorded({ md5_checksum: odd, head_revision_id: 'r7' })
      expect(records[0]?.[1].fingerprint).toBe('r7')
    })
  }

  it('stamps no token on a windowed read', async () => {
    // No md5 on the entry, so the check cannot drop the token for it: only
    // the window can. The whole-file control is the head-revision row.
    const records = await readUnrecorded({ head_revision_id: 'r7' }, { offset: 1 })
    expect(records[0]?.[1].fingerprint).toBeNull()
  })

  it('pins no revision', async () => {
    // The entry's revision can be a TTL old; pinning a replay to it could
    // serve bytes this read never saw.
    const records = await readUnrecorded({ md5_checksum: BODY_MD5, head_revision_id: 'r7' })
    expect(records[0]?.[1].revision).toBeNull()
  })

  it('issues no metadata request', async () => {
    await readUnrecorded({ md5_checksum: BODY_MD5 })
    expect(drive.downloadFile).toHaveBeenCalledTimes(1)
    expect(versions.captureFileMetadata).not.toHaveBeenCalled()
  })

  it('stamps no entry token on a pinned read', async () => {
    // Pinned bytes are an old revision; the entry's md5 describes head.
    const index = new RAMIndexCacheStore()
    await index.setDir('/gd', [
      [
        'a.txt',
        new IndexEntry({
          id: 'file123',
          name: 'a.txt',
          resourceType: 'gdrive/file',
          remoteTime: UNRECORDED_STAMP,
          vfsName: 'a.txt',
          extra: { md5_checksum: BODY_MD5 },
        }),
      ],
    ])
    vi.mocked(versions.downloadRevision).mockResolvedValue(BODY)
    await runWithRevisions(new Map([['/gd/a.txt', 'r1']]), () =>
      read(makeAccessor(), UNRECORDED_SPEC, index),
    )
    expect(UNRECORDED.records).toEqual([['/gd/a.txt', { fingerprint: null, revision: 'r1' }]])
    expect(drive.downloadFile).not.toHaveBeenCalled()
    expect(versions.downloadRevision).toHaveBeenCalledTimes(1)
  })

  it('a recorded read prefers the capture over the entry', async () => {
    // The capture is the fresher of the two; the entry can be a TTL old.
    const index = new RAMIndexCacheStore()
    await index.setDir('/gd', [
      [
        'a.txt',
        new IndexEntry({
          id: 'file123',
          name: 'a.txt',
          resourceType: 'gdrive/file',
          remoteTime: UNRECORDED_STAMP,
          vfsName: 'a.txt',
          extra: { md5_checksum: '0'.repeat(32) },
        }),
      ],
    ])
    vi.mocked(drive.downloadFile).mockResolvedValue(BODY)
    vi.mocked(versions.captureFileMetadata).mockResolvedValue([BODY_MD5, 'r9', null])
    const [, records] = await runWithRecording(() => read(makeAccessor(), UNRECORDED_SPEC, index))
    expect(records.map((r) => [r.fingerprint, r.revision])).toEqual([[BODY_MD5, 'r9']])
  })
})

describe('the native gdrive read record path', () => {
  for (const [resourceType, vfsName, renderer] of NATIVE) {
    for (const mount of ['/gd', '']) {
      it(`records ${mount}/${vfsName} for a mount at '${mount || '/'}'`, async () => {
        // The cache fill matches on the virtual path; the mount path names
        // nothing under a mount at /gd.
        const index = new RAMIndexCacheStore()
        await index.setDir(mount || '/', [[vfsName, nativeEntry(resourceType, vfsName)]])
        renderer().mockResolvedValue(new TextEncoder().encode('{}'))
        const [, records] = await runWithRecording(() =>
          read(makeAccessor(), specFor(vfsName, mount), index),
        )
        expect(records.map((r) => r.path)).toEqual([`${mount}/${vfsName}`])
      })
    }
  }
})
