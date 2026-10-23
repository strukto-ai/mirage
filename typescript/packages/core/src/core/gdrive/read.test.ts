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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { GoogleDriveVFS } from '../../vfs/gdrive/gdrive.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { runWithRecording, runWithRevisions } from '../../observe/context.ts'
import { driveFingerprint } from './fingerprint.ts'
import { read, readFileVersioned } from './read.ts'
import { statFromItem } from './readdir.ts'
import { stat } from './stat.ts'
import type { DocsApi } from '../gdocs/api.ts'
import type { SheetsApi } from '../gsheets/api.ts'
import type { SlidesApi } from '../gslides/api.ts'
import { installApi } from '../../../tests/core/google/_test_util.ts'
import { md5Hex } from '../../utils/hash.ts'
import {
  type StubDrive,
  makeGDriveAccessor,
  stubDrive,
} from '../../../tests/core/gdrive/_test_util.ts'

// A row as a Drive listing names it, odd token shapes kept as given.
// Mirrors python's `_row`.
function row(
  fileId: string,
  name: string,
  resourceType = 'gdrive/file',
  modified = '',
  extra: Record<string, unknown> = {},
): FileStat {
  if (resourceType === 'gdrive/folder' || resourceType === 'gdrive/shared_drive') {
    return new FileStat({ name, type: FileType.DIRECTORY, extra: { file_id: fileId, ...extra } })
  }
  return new FileStat({
    name,
    type: FileType.FILE,
    modified,
    fingerprint: driveFingerprint(
      resourceType,
      extra.md5_checksum,
      extra.head_revision_id,
      modified,
    ),
    extra: { file_id: fileId, resource_type: resourceType, ...extra },
  })
}

const VERSIONED_ENTRY = row('f1', 'f.txt')

let drive: StubDrive

function makeAccessor(): GDriveAccessor {
  return makeGDriveAccessor(drive)
}

const docs = { readDoc: vi.fn<DocsApi['readDoc']>() }
const sheets = { readSpreadsheet: vi.fn<SheetsApi['readSpreadsheet']>() }
const slides = { readPresentation: vi.fn<SlidesApi['readPresentation']>() }

beforeEach(() => {
  vi.clearAllMocks()
  UNRECORDED.records.length = 0
  drive = stubDrive()
  drive.listSharedDrives.mockResolvedValue([])
  installApi({ docs, sheets, slides })
})

async function workspace(): Promise<Workspace> {
  const vfs = new GoogleDriveVFS({ clientId: 'x', refreshToken: 'y' })
  Object.assign(vfs, { accessor: makeAccessor() })
  return new Workspace(
    { '/drive/': vfs },
    { mode: MountMode.READ, shellParser: await getTestParser() },
  )
}

describe('a cold gdrive read through a mount', () => {
  it('lists its parent first', async () => {
    drive.listFiles.mockImplementation((opts) => {
      if (opts.folderId === 'root') {
        return Promise.resolve([
          {
            id: 'f1',
            name: 'report.pdf',
            mimeType: 'application/pdf',
            modifiedTime: '2026-04-01T00:00:00.000Z',
          },
        ])
      }
      throw new Error(`unexpected folderId=${opts.folderId}`)
    })
    drive.downloadFileStream.mockImplementation(async function* () {
      yield await Promise.resolve(new TextEncoder().encode('pdf-bytes'))
    })
    drive.captureFileMetadata.mockResolvedValue([null, null])
    const ws = await workspace()
    try {
      const out = (await ws.dispatch('read', '/drive/report.pdf')) as Uint8Array
      expect(new TextDecoder().decode(out)).toBe('pdf-bytes')
    } finally {
      await ws.close()
    }
  })

  it('never downloads a name its parent does not list', async () => {
    drive.listFiles.mockImplementation((opts) => {
      if (opts.folderId === 'root') {
        return Promise.resolve([
          {
            id: 'f1',
            name: 'other.txt',
            mimeType: 'text/plain',
            modifiedTime: '2026-04-01T00:00:00.000Z',
          },
        ])
      }
      throw new Error(`unexpected folderId=${opts.folderId}`)
    })
    drive.downloadFile.mockRejectedValue(new Error('should not call downloadFile'))
    const ws = await workspace()
    try {
      await expect(ws.dispatch('read', '/drive/missing.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await ws.close()
    }
  })

  // Mirrors test_read_propagates_parent_listing_failure: only an absent
  // parent may collapse into the operand's ENOENT.
  it('propagates a failed parent listing instead of reporting ENOENT', async () => {
    drive.listFiles.mockRejectedValue(new Error('drive unavailable'))
    drive.downloadFile.mockRejectedValue(new Error('should not call downloadFile'))
    const ws = await workspace()
    try {
      await expect(ws.dispatch('read', '/drive/missing.txt')).rejects.toThrow(/drive unavailable/)
    } finally {
      await ws.close()
    }
  })
})

describe('gdrive read', () => {
  it('answers ENOENT for nothing', async () => {
    await expect(
      read(makeAccessor(), PathSpec.fromStrPath('/missing/file.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws EISDIR when reading a shared drive root', async () => {
    drive.downloadFile.mockRejectedValue(new Error('should not call downloadFile'))
    const path = new PathSpec({
      vfsPath: 'Team Drive',
      virtual: '/Team Drive',
      directory: '/Team Drive',
    })
    // The stamped code is the signal, not the message: the message is the
    // bare operand, which is what the shell renders (`cat: /Team Drive: Is a
    // directory`) and what Python's IsADirectoryError(virtual) carries.
    await expect(
      read(
        makeAccessor(),
        path,
        undefined,
        row('drive1', 'Team Drive', 'gdrive/shared_drive', '', { drive_id: 'drive1' }),
      ),
    ).rejects.toMatchObject({ code: 'EISDIR', virtualPath: '/Team Drive' })
    expect(drive.downloadFile).not.toHaveBeenCalled()
  })
})

describe('gdrive versioned reads', () => {
  it('a pinned path reads that revision, not live content', async () => {
    const enc = new TextEncoder()
    drive.downloadRevision.mockResolvedValue(enc.encode('pinned'))
    const data = await runWithRevisions(new Map([['/data/f.txt', 'r1']]), () =>
      readFileVersioned(drive, 'f1', '/data/f.txt', VERSIONED_ENTRY),
    )
    expect(new TextDecoder().decode(data)).toBe('pinned')
    expect(drive.downloadRevision).toHaveBeenCalledWith('f1', 'r1', undefined)
    expect(drive.downloadFile).not.toHaveBeenCalled()
  })

  it('an unpinned unrecorded read skips the metadata call', async () => {
    const enc = new TextEncoder()
    drive.downloadFile.mockResolvedValue(enc.encode('live'))
    const data = await readFileVersioned(drive, 'f1', '/data/f.txt', VERSIONED_ENTRY)
    expect(new TextDecoder().decode(data)).toBe('live')
    expect(drive.captureFileMetadata).not.toHaveBeenCalled()
  })
})

// A key named like its mount: neither `m/k.txt` nor `/m/k.txt` is virtual.
describe('gdrive read record path', () => {
  it('records the virtual path for a binary file', async () => {
    drive.captureFileMetadata.mockResolvedValue([null, null])
    drive.downloadFile.mockResolvedValue(new TextEncoder().encode('live'))
    const path = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })
    const [data, records] = await runWithRecording(() =>
      read(makeAccessor(), path, undefined, row('f1', 'k.txt')),
    )
    expect(new TextDecoder().decode(data)).toBe('live')
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })
})

const CONTENT = new TextEncoder().encode('pdf content here')
const DIGEST = md5Hex(CONTENT)
const REVISION = 'file123-r1'
const STAMP = '2026-04-01T00:00:00.000Z'

function binaryRow(): FileStat {
  return row('file123', 'report.pdf', 'gdrive/file', STAMP, {
    md5_checksum: DIGEST,
    head_revision_id: REVISION,
  })
}

function specFor(name = 'report.pdf', mount = ''): PathSpec {
  return new PathSpec({ vfsPath: name, virtual: `${mount}/${name}`, directory: `${mount}/${name}` })
}

describe('the gdrive read record', () => {
  beforeEach(() => {
    drive.captureFileMetadata.mockResolvedValue([DIGEST, REVISION])
    drive.downloadFile.mockResolvedValue(CONTENT)
  })

  it('stamps the token stat stamps', async () => {
    // The whole defect in one assertion: a `fresh` mount compares the cache
    // entry's token against stat's, so the two must be the same value for the
    // same unchanged file. The literal md5 is asserted too, because equality
    // alone still holds under a chain mutated to md5-only while every native
    // file silently loses its token.
    const path = specFor()
    const [, records] = await runWithRecording(async () =>
      read(makeAccessor(), path, undefined, binaryRow()),
    )
    const st = await stat(makeAccessor(), path, binaryRow())
    expect(records[0]?.fingerprint).toBe(DIGEST)
    expect(st.fingerprint).toBe(records[0]?.fingerprint)
  })

  it('records the virtual path on a root mount too', async () => {
    // On a root mount the virtual and mount paths agree, so this is the
    // control for the /gd row: only that one tells them apart.
    const [, records] = await runWithRecording(async () =>
      read(makeAccessor(), specFor(), undefined, binaryRow()),
    )
    expect(records[0]?.path).toBe('/report.pdf')
  })

  it('keeps the boundary for a name sharing the prefix leading text', async () => {
    // A mount at /gd holding 'gd-report.pdf': the index key is derived from
    // the mount prefix, and a name sharing its leading text must still
    // resolve under /gd, or the read throws ENOENT before it records.
    const [, records] = await runWithRecording(async () =>
      read(makeAccessor(), specFor('gd-report.pdf', '/gd'), undefined, binaryRow()),
    )
    expect(records[0]?.path).toBe('/gd/gd-report.pdf')
  })

  it('stamps the token the row a listing builds from the Drive item names', async () => {
    const item = {
      id: 'file123',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      modifiedTime: STAMP,
      size: String(CONTENT.length),
      md5Checksum: DIGEST,
      headRevisionId: REVISION,
    }
    const listed = statFromItem(item)
    const [, records] = await runWithRecording(async () =>
      read(makeAccessor(), specFor(), undefined, listed),
    )
    expect(listed.fingerprint).toBe(DIGEST)
    expect(listed.fingerprint).toBe(records[0]?.fingerprint)
  })

  it('keeps the captured revision on a windowed read', async () => {
    // A window proves nothing about the revision: the bytes are a slice of
    // the object the capture named, so the pin is still true even though the
    // fingerprint cannot be stamped.
    const [, records] = await runWithRecording(async () =>
      read(makeAccessor(), specFor(), { offset: 1, size: 4 }, binaryRow()),
    )
    expect(records[0]?.fingerprint).toBeNull()
    expect(records[0]?.revision).toBe(REVISION)
  })

  it('drops a captured md5 that disagrees with the bytes', async () => {
    // The capture and the download are two separate requests, so a writer
    // that changes the file between them caches bytes B under md5(A). A later
    // revert to A then reads as FRESH and serves B, silently.
    drive.captureFileMetadata.mockResolvedValue([
      md5Hex(new TextEncoder().encode('the previous content')),
      REVISION,
    ])
    const [, records] = await runWithRecording(async () =>
      read(makeAccessor(), specFor(), undefined, binaryRow()),
    )
    expect(records[0]?.fingerprint).toBeNull()
    // And the revision goes with it: it came from the same capture, so the
    // disagreement is proof it describes the old content too. Keeping it
    // would be worse than keeping nothing, because a revision pin REPLACES
    // the drift check rather than supplementing it.
    expect(records[0]?.revision).toBeNull()
  })

  it('stamps no token on a size-capped read from zero', async () => {
    // `head -c N`: offset 0 alone does not make a read whole.
    const [, records] = await runWithRecording(async () =>
      read(makeAccessor(), specFor(), { offset: 0, size: 4 }, binaryRow()),
    )
    expect(records[0]?.fingerprint).toBeNull()
    expect(records[0]?.revision).toBe(REVISION)
  })

  it('stamps a capture with no md5 unverified', async () => {
    // Drive withholds md5Checksum for some binary files. There is nothing to
    // verify, and dropping the token would leave the read at null against
    // stat's head revision -- the mismatch this change removes.
    drive.captureFileMetadata.mockResolvedValue([null, REVISION])
    const [, records] = await runWithRecording(async () =>
      read(makeAccessor(), specFor(), undefined, binaryRow()),
    )
    expect(records[0]?.fingerprint).toBe(REVISION)
  })

  it('does not block the event loop while hashing', async () => {
    // md5Hex is a synchronous pure-JS MD5 -- WebCrypto has no MD5 and core
    // cannot import node:crypto -- so hashing a large read in one go stalls
    // the loop that serves a TS FUSE mount, and the kernel then fails every
    // later op with `Device not configured`. Big enough to span several
    // chunks, small enough to stay fast.
    const BIG = new Uint8Array(4 * 1024 * 1024).fill(7)
    drive.downloadFile.mockResolvedValue(BIG)
    drive.captureFileMetadata.mockResolvedValue([md5Hex(BIG), REVISION])
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
    const reading = runWithRecording(async () =>
      read(makeAccessor(), specFor(), undefined, binaryRow()),
    ).then((v) => {
      order.push('read')
      return v
    })
    const [, [, records]] = await Promise.all([timer, reading])
    expect(order[0]).toBe('timer')
    expect(records[0]?.fingerprint).toBe(md5Hex(BIG))
  })
})

const NATIVE: [string, string, () => { mockResolvedValue: (v: Uint8Array) => void }][] = [
  ['gdrive/gdoc', 'doc.gdoc.json', () => docs.readDoc],
  ['gdrive/gsheet', 'book.gsheet.json', () => sheets.readSpreadsheet],
  ['gdrive/gslide', 'deck.gslide.json', () => slides.readPresentation],
]

function nativeRow(resourceType: string, vfsName: string, headRevision?: string): FileStat {
  // Drive gives a native file neither md5Checksum nor headRevisionId, so the
  // default carries neither and the stamp is the only token -- the case the
  // chain's third step exists for. The revision test seeds one deliberately,
  // because its assertion would hold whatever the code did otherwise.
  return row(
    'doc123',
    vfsName,
    resourceType,
    STAMP,
    headRevision === undefined ? {} : { head_revision_id: headRevision },
  )
}

describe('the native gdrive read record', () => {
  for (const [resourceType, vfsName, renderer] of NATIVE) {
    it(`records no revision for ${vfsName}`, async () => {
      // A revision pin REPLACES the drift check and the native branch can
      // never honour one, so recording it would kill the check it displaced.
      renderer().mockResolvedValue(new TextEncoder().encode('{}'))
      const [, records] = await runWithRecording(async () =>
        read(
          makeAccessor(),
          specFor(vfsName, '/gd'),
          undefined,
          nativeRow(resourceType, vfsName, 'doc123-r1'),
        ),
      )
      expect(records[0]?.revision).toBeNull()
    })

    it(`stamps no token on a windowed read of ${vfsName}`, async () => {
      // The native branch runs the same whole-file guard the binary branch
      // does: the chain describes the whole render, so a window stamped with
      // it would cache a partial body that reads FRESH for the life of the
      // entry.
      renderer().mockResolvedValue(new TextEncoder().encode('{"tabs": [1,2,3]}'))
      const [, records] = await runWithRecording(async () =>
        read(
          makeAccessor(),
          specFor(vfsName, '/gd'),
          { offset: 2, size: 5 },
          nativeRow(resourceType, vfsName),
        ),
      )
      expect(records[0]?.bytes).toBe(5)
      expect(records[0]?.fingerprint).toBeNull()
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
  // Built rather than listed: a listing drops an empty or missing md5, so a
  // listed row could not carry the odd shapes these rows need.
  const offset = options?.offset ?? 0
  drive.downloadFile.mockResolvedValue(
    BODY.slice(offset, options?.size === undefined ? undefined : offset + options.size),
  )
  drive.captureFileMetadata.mockResolvedValue([null, null])
  await read(
    makeAccessor(),
    UNRECORDED_SPEC,
    options,
    row('file123', 'a.txt', 'gdrive/file', UNRECORDED_STAMP, extra),
  )
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

  it('stamps nothing when the entry has neither token', async () => {
    // A file with content never falls back to its modified stamp.
    const records = await readUnrecorded({})
    expect(records[0]?.[1].fingerprint).toBeNull()
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
    expect(drive.captureFileMetadata).not.toHaveBeenCalled()
  })

  it('stamps no entry token on a pinned read', async () => {
    // Pinned bytes are an old revision; the entry's md5 describes head.
    drive.downloadRevision.mockResolvedValue(BODY)
    await runWithRevisions(new Map([['/gd/a.txt', 'r1']]), () =>
      read(
        makeAccessor(),
        UNRECORDED_SPEC,
        undefined,
        row('file123', 'a.txt', 'gdrive/file', UNRECORDED_STAMP, { md5_checksum: BODY_MD5 }),
      ),
    )
    expect(UNRECORDED.records).toEqual([['/gd/a.txt', { fingerprint: null, revision: 'r1' }]])
    expect(drive.downloadFile).not.toHaveBeenCalled()
    expect(drive.downloadRevision).toHaveBeenCalledTimes(1)
  })

  it('a recorded read prefers the capture over the entry', async () => {
    // The capture is the fresher of the two; the entry can be a TTL old.
    drive.downloadFile.mockResolvedValue(BODY)
    drive.captureFileMetadata.mockResolvedValue([BODY_MD5, 'r9'])
    const [, records] = await runWithRecording(() =>
      read(
        makeAccessor(),
        UNRECORDED_SPEC,
        undefined,
        row('file123', 'a.txt', 'gdrive/file', UNRECORDED_STAMP, { md5_checksum: '0'.repeat(32) }),
      ),
    )
    expect(records.map((r) => [r.fingerprint, r.revision])).toEqual([[BODY_MD5, 'r9']])
  })
})

describe('the native gdrive read record path', () => {
  for (const [resourceType, vfsName, renderer] of NATIVE) {
    for (const mount of ['/gd', '']) {
      it(`records ${mount}/${vfsName} for a mount at '${mount || '/'}'`, async () => {
        // The cache fill matches on the virtual path; the mount path names
        // nothing under a mount at /gd.
        renderer().mockResolvedValue(new TextEncoder().encode('{}'))
        const [, records] = await runWithRecording(() =>
          read(
            makeAccessor(),
            specFor(vfsName, mount),
            undefined,
            nativeRow(resourceType, vfsName),
          ),
        )
        expect(records.map((r) => [r.path, r.fingerprint])).toEqual([
          [`${mount}/${vfsName}`, STAMP],
        ])
      })
    }
  }
})
