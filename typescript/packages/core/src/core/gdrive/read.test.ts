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

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

import { FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { ManualClock } from '../../utils/clock.ts'
import { GoogleDriveVFS } from '../../vfs/gdrive/gdrive.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { currentCaller, bindCaller } from '../../context/session_context.ts'
import { recordingScope } from '../../observe/context.ts'
import { GoogleApiError } from '../google/client.ts'
import { md5Hex } from '../../utils/hash.ts'
import type { OpRecord } from '../../observe/record.ts'
import type { DriveApi } from './api.ts'
import { driveFingerprint } from './fingerprint.ts'
import { read, readFileVersioned, readStream } from './read.ts'
import { statFromItem } from './readdir.ts'
import { stat } from './stat.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import {
  FILE,
  FILES,
  GoogleAccount,
  MEDIA_QUERY,
  UNTIL_CLEARED,
} from '../../../tests/core/google/account.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

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

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

beforeEach(() => {
  UNRECORDED.records.length = 0
  account = new GoogleAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

// A workspace binds its own clock to its mounts' clients, so retries in a
// test that refuses one wait on the clock it is handed.
function workspace(clock?: ManualClock): Workspace {
  const vfs = new GoogleDriveVFS(account.config())
  return new Workspace(
    { '/drive/': vfs },
    { mode: MountMode.READ, ...(clock === undefined ? {} : { clock }) },
  )
}

describe('a cold gdrive read through a mount', () => {
  it('lists its parent first', async () => {
    const made = await account.upload('report.pdf', 'pdf-bytes')
    await account.run.recordRequests()
    const ws = workspace()
    try {
      const out = (await ws.dispatch('read', '/drive/report.pdf')) as Uint8Array
      expect(DEC.decode(out)).toBe('pdf-bytes')
    } finally {
      await ws.close()
    }
    const log = await account.log()
    expect(log[0]?.[0]).toBe('list')
    expect(log).toContainEqual(['media', made])
  })

  it('never downloads a name its parent does not list', async () => {
    await account.upload('other.txt', 'other')
    await account.run.recordRequests()
    const ws = workspace()
    try {
      await expect(ws.dispatch('read', '/drive/missing.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await ws.close()
    }
    expect((await account.log()).map(([name]) => name)).not.toContain('media')
  })

  // Mirrors test_read_propagates_parent_listing_failure: only an absent
  // parent may collapse into the operand's ENOENT.
  it('propagates a failed parent listing instead of reporting ENOENT', async () => {
    await account.refuse('GET', FILES, 503, 'Backend Error', {
      reason: 'backendError',
      times: UNTIL_CLEARED,
    })
    const ws = workspace(new ManualClock())
    try {
      const failed = ws.dispatch('read', '/drive/missing.txt')
      await expect(failed).rejects.toBeInstanceOf(GoogleApiError)
      await expect(failed).rejects.toThrow(/Backend Error/)
    } finally {
      await ws.close()
    }
  })
})

describe('gdrive read', () => {
  it('answers ENOENT for nothing', async () => {
    await expect(
      read(account.driveAccessor(), PathSpec.fromStrPath('/missing/file.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws EISDIR when reading a shared drive root', async () => {
    const drive = await account.sharedDrive('Team Drive')
    const path = new PathSpec({
      vfsPath: 'Team Drive',
      virtual: '/Team Drive',
      directory: '/Team Drive',
    })
    await account.run.recordRequests()
    // The stamped code is the signal, not the message: the message is the
    // bare operand, which is what the shell renders (`cat: /Team Drive: Is a
    // directory`) and what Python's IsADirectoryError(virtual) carries.
    await expect(
      read(
        account.driveAccessor(),
        path,
        undefined,
        row(drive, 'Team Drive', 'gdrive/shared_drive', '', { drive_id: drive }),
      ),
    ).rejects.toMatchObject({ code: 'EISDIR', virtualPath: '/Team Drive' })
    expect(await account.log()).toEqual([])
  })
})

describe('gdrive versioned reads', () => {
  it('a pinned path reads that revision, not live content', async () => {
    const made = await account.upload('f.txt', 'pinned')
    const pinned = (await account.item(made)).headRevisionId as string
    await account.update(made, 'live')
    await account.run.recordRequests()
    const data = await bindCaller(
      { ...currentCaller(), revisions: { map: new Map([['/data/f.txt', pinned]]) } },
      () =>
        readFileVersioned(account.driveAccessor().drive, made, '/data/f.txt', row(made, 'f.txt')),
    )
    expect(DEC.decode(data)).toBe('pinned')
    expect(await account.log()).toEqual([['revision', pinned]])
  })

  it('an unpinned unrecorded read skips the metadata call', async () => {
    const made = await account.upload('f.txt', 'live')
    await account.run.recordRequests()
    const data = await readFileVersioned(
      account.driveAccessor().drive,
      made,
      '/data/f.txt',
      row(made, 'f.txt'),
    )
    expect(DEC.decode(data)).toBe('live')
    expect(await account.log()).toEqual([['media', made]])
  })
})

// A key named like its mount: neither `m/k.txt` nor `/m/k.txt` is virtual.
describe('gdrive read record path', () => {
  it('records the virtual path for a binary file', async () => {
    const made = await account.upload('k.txt', 'live')
    const path = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })
    const [data, records] = await recordingScope(() =>
      read(account.driveAccessor(), path, undefined, row(made, 'k.txt')),
    )
    expect(DEC.decode(data)).toBe('live')
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })
})

const CONTENT = 'pdf content here'
const DIGEST = md5Hex(ENC.encode(CONTENT))
const STAMP = '2026-04-01T00:00:00.000Z'

function binaryRow(fileId: string, revision: string): FileStat {
  return row(fileId, 'report.pdf', 'gdrive/file', STAMP, {
    md5_checksum: DIGEST,
    head_revision_id: revision,
  })
}

function specFor(name = 'report.pdf', mount = ''): PathSpec {
  return new PathSpec({ vfsPath: name, virtual: `${mount}/${name}`, directory: `${mount}/${name}` })
}

/** Upload `report.pdf` holding `data` and answer its id and head revision. */
async function uploaded(data = CONTENT): Promise<[string, string]> {
  const made = await account.upload('report.pdf', data)
  return [made, (await account.item(made)).headRevisionId as string]
}

/**
 * Hold the next capture of a file's metadata until its download has reached
 * the fake too, then serve it, or answer it with `status`. The download's
 * hold is armed first, so it is the one the download's request meets; the
 * other catches the capture's. A read that asks for the metadata first and
 * downloads after never sends the download while its capture waits, so it
 * never finishes. Mirrors python's `hold_capture_for_download`.
 */
async function holdCaptureForDownload(status?: number): Promise<void> {
  let downloading: () => void = () => undefined
  const downloaded = new Promise<void>((resolve) => {
    downloading = resolve
  })
  await account.run.beforeNext([['GET', FILE]], () => downloading(), undefined, MEDIA_QUERY)
  await account.run.beforeNext([['GET', FILE]], () => downloaded, status)
}

/**
 * Stream `report.pdf` under a live recorder; answers what was handed on, the
 * error that ended the stream if one did, and the records. Mirrors python's
 * `stream_recording`.
 */
async function streamRecording(entry: FileStat): Promise<[Uint8Array[], unknown, OpRecord[]]> {
  const got: Uint8Array[] = []
  let error: unknown = null
  const [, records] = await recordingScope(async () => {
    try {
      for await (const chunk of readStream(account.driveAccessor(), specFor(), entry)) {
        got.push(chunk)
      }
    } catch (err) {
      error = err
    }
  })
  return [got, error, records]
}

describe('a recorded gdrive read', () => {
  // Twin of test_a_recorded_read_asks_its_metadata_beside_the_download.
  it('asks its metadata beside the download', async () => {
    const [made, revision] = await uploaded()
    await holdCaptureForDownload()
    const [data, records] = await recordingScope(async () =>
      read(account.driveAccessor(), specFor(), undefined, binaryRow(made, revision)),
    )
    expect(DEC.decode(data)).toBe(CONTENT)
    expect([records[0]?.fingerprint, records[0]?.revision]).toEqual([DIGEST, revision])
  }, 5000)

  // Twin of test_a_recorded_stream_asks_its_metadata_beside_the_download.
  it('streams with its metadata asked beside the download', async () => {
    const [made, revision] = await uploaded()
    await holdCaptureForDownload()
    const [got, error, records] = await streamRecording(binaryRow(made, revision))
    expect(error).toBeNull()
    expect(DEC.decode(Buffer.concat(got))).toBe(CONTENT)
    expect([records[0]?.fingerprint, records[0]?.revision]).toEqual([DIGEST, revision])
  }, 5000)

  // Twin of test_a_stream_whose_capture_fails_hands_on_no_byte: the download
  // is out before the capture is answered, but its first chunk waits for the
  // capture, so a capture that fails fails the read with nothing handed on.
  it('hands on no byte when its capture fails', async () => {
    const [made, revision] = await uploaded()
    await holdCaptureForDownload(404)
    const [got, error] = await streamRecording(binaryRow(made, revision))
    expect(got).toEqual([])
    expect(error).toBeInstanceOf(GoogleApiError)
  }, 5000)
})

describe('the gdrive read record', () => {
  it('stamps the token stat stamps', async () => {
    // The whole defect in one assertion: a `fresh` mount compares the cache
    // entry's token against stat's, so the two must be the same value for the
    // same unchanged file. The literal md5 is asserted too, because equality
    // alone still holds under a chain mutated to md5-only while every native
    // file silently loses its token.
    const [made, revision] = await uploaded()
    const path = specFor()
    const [, records] = await recordingScope(async () =>
      read(account.driveAccessor(), path, undefined, binaryRow(made, revision)),
    )
    const st = await stat(account.driveAccessor(), path, binaryRow(made, revision))
    expect(records[0]?.fingerprint).toBe(DIGEST)
    expect(st.fingerprint).toBe(records[0]?.fingerprint)
  })

  it('records the virtual path on a root mount too', async () => {
    // On a root mount the virtual and mount paths agree, so this is the
    // control for the /gd row: only that one tells them apart.
    const [made, revision] = await uploaded()
    const [, records] = await recordingScope(async () =>
      read(account.driveAccessor(), specFor(), undefined, binaryRow(made, revision)),
    )
    expect(records[0]?.path).toBe('/report.pdf')
  })

  it('keeps the boundary for a name sharing the prefix leading text', async () => {
    // A mount at /gd holding 'gd-report.pdf': the index key is derived from
    // the mount prefix, and a name sharing its leading text must still
    // resolve under /gd, or the read throws ENOENT before it records.
    const [made, revision] = await uploaded()
    const [, records] = await recordingScope(async () =>
      read(
        account.driveAccessor(),
        specFor('gd-report.pdf', '/gd'),
        undefined,
        binaryRow(made, revision),
      ),
    )
    expect(records[0]?.path).toBe('/gd/gd-report.pdf')
  })

  it('stamps the token the row a listing builds from the Drive item names', async () => {
    const [made] = await uploaded()
    const listed = statFromItem(await account.item(made))
    const [, records] = await recordingScope(async () =>
      read(account.driveAccessor(), specFor(), undefined, listed),
    )
    expect(listed.fingerprint).toBe(DIGEST)
    expect(listed.fingerprint).toBe(records[0]?.fingerprint)
  })

  it('keeps the captured revision on a windowed read', async () => {
    // A window proves nothing about the revision: the bytes are a slice of
    // the object the capture named, so the pin is still true even though the
    // fingerprint cannot be stamped.
    const [made, revision] = await uploaded()
    const [, records] = await recordingScope(async () =>
      read(account.driveAccessor(), specFor(), { offset: 1, size: 4 }, binaryRow(made, revision)),
    )
    expect(records[0]?.fingerprint).toBeNull()
    expect(records[0]?.revision).toBe(revision)
  })

  it('drops a captured md5 that disagrees with the bytes', async () => {
    // The capture and the download are two separate requests, so a writer
    // that changes the file between them caches bytes B under md5(A). A later
    // revert to A then reads as FRESH and serves B, silently. Here another
    // client writes just before the download is served.
    const [made, revision] = await uploaded('the previous content')
    await account.run.beforeNext(
      [['GET', FILE]],
      () => account.update(made, CONTENT),
      undefined,
      MEDIA_QUERY,
    )
    const [data, records] = await recordingScope(async () =>
      read(account.driveAccessor(), specFor(), undefined, binaryRow(made, revision)),
    )
    expect(DEC.decode(data)).toBe(CONTENT)
    expect(records[0]?.fingerprint).toBeNull()
    // And the revision goes with it: it came from the same capture, so the
    // disagreement is proof it describes the old content too. Keeping it
    // would be worse than keeping nothing, because a revision pin REPLACES
    // the drift check rather than supplementing it.
    expect(records[0]?.revision).toBeNull()
  })

  it('stamps no token on a size-capped read from zero', async () => {
    // `head -c N`: offset 0 alone does not make a read whole.
    const [made, revision] = await uploaded()
    const [, records] = await recordingScope(async () =>
      read(account.driveAccessor(), specFor(), { offset: 0, size: 4 }, binaryRow(made, revision)),
    )
    expect(records[0]?.fingerprint).toBeNull()
    expect(records[0]?.revision).toBe(revision)
  })

  it('stamps a capture with no md5 unverified', async () => {
    // Drive withholds md5Checksum for some binary files. There is nothing to
    // verify, and dropping the token would leave the read at null against
    // stat's head revision -- the mismatch this change removes. The fake
    // keeps an md5 for every file, so its own answer is sent without it.
    const [made, revision] = await uploaded()
    const captured: Record<string, unknown> = { ...(await account.item(made)) }
    delete captured.md5Checksum
    await account.run.answerNext('GET', FILE, 200, captured as never)
    const [, records] = await recordingScope(async () =>
      read(account.driveAccessor(), specFor(), undefined, binaryRow(made, revision)),
    )
    expect(records[0]?.fingerprint).toBe(revision)
  })

  it('does not block the event loop while hashing', async () => {
    // Order is only observable when nothing but the hash does I/O: over a
    // network every step yields, so the timer would fire first whatever the
    // hash did. The client is handed in, answering from memory.
    const BIG = new Uint8Array(4 * 1024 * 1024).fill(7)
    const inMemory = {
      captureFileMetadata: () => Promise.resolve([md5Hex(BIG), 'r1']),
      downloadFile: () => Promise.resolve(BIG),
    } as unknown as DriveApi
    // `await timer` resolves only after the callback that would set a flag,
    // so a flag assertion cannot fail once reached and passes against a fully
    // synchronous hash too. The timeout is queued before the read starts, so
    // a synchronous hash finishes in microtasks and pushes 'read' first while
    // a yielding one lets the macrotask in.
    const order: string[] = []
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push('timer')
        resolve()
      }, 0),
    )
    const reading = recordingScope(async () =>
      readFileVersioned(inMemory, 'f1', '/report.pdf', row('f1', 'report.pdf')),
    ).then((v) => {
      order.push('read')
      return v
    })
    const [, [, records]] = await Promise.all([timer, reading])
    expect(order[0]).toBe('timer')
    expect(records[0]?.fingerprint).toBe(md5Hex(BIG))
  })
})

const NATIVE: [string, string, string][] = [
  ['gdrive/gdoc', 'doc.gdoc.json', 'application/vnd.google-apps.document'],
  ['gdrive/gsheet', 'book.gsheet.json', 'application/vnd.google-apps.spreadsheet'],
  ['gdrive/gslide', 'deck.gslide.json', 'application/vnd.google-apps.presentation'],
]

async function nativeRow(
  resourceType: string,
  vfsName: string,
  mime: string,
  headRevision?: string,
): Promise<FileStat> {
  // Drive gives a native file neither md5Checksum nor headRevisionId, so the
  // default carries neither and the stamp is the only token -- the case the
  // chain's third step exists for. The revision test seeds one deliberately,
  // because its assertion would hold whatever the code did otherwise.
  return row(
    await account.create('x', mime),
    vfsName,
    resourceType,
    STAMP,
    headRevision === undefined ? {} : { head_revision_id: headRevision },
  )
}

describe('the native gdrive read record', () => {
  for (const [resourceType, vfsName, mime] of NATIVE) {
    it(`records no revision for ${vfsName}`, async () => {
      // A revision pin REPLACES the drift check and the native branch can
      // never honour one, so recording it would kill the check it displaced.
      const entry = await nativeRow(resourceType, vfsName, mime, 'doc123-r1')
      const [, records] = await recordingScope(async () =>
        read(account.driveAccessor(), specFor(vfsName, '/gd'), undefined, entry),
      )
      expect(records[0]?.revision).toBeNull()
    })

    it(`stamps no token on a windowed read of ${vfsName}`, async () => {
      // The native branch runs the same whole-file guard the binary branch
      // does: the chain describes the whole render, so a window stamped with
      // it would cache a partial body that reads FRESH for the life of the
      // entry.
      const entry = await nativeRow(resourceType, vfsName, mime)
      const [, records] = await recordingScope(async () =>
        read(account.driveAccessor(), specFor(vfsName, '/gd'), { offset: 2, size: 5 }, entry),
      )
      expect(records[0]?.bytes).toBe(5)
      expect(records[0]?.fingerprint).toBeNull()
    })
  }
})

const BODY = 'quarterly numbers\n'
const BODY_MD5 = md5Hex(ENC.encode(BODY))
const UNRECORDED_STAMP = '2026-01-02T00:00:00Z'
const UNRECORDED_SPEC = new PathSpec({ virtual: '/gd/a.txt', directory: '/gd/', vfsPath: 'a.txt' })

async function readUnrecorded(
  extra: Record<string, unknown>,
  options?: { offset?: number; size?: number },
): Promise<[string, ContextModule.RecordOptions][]> {
  // Built rather than listed: a listing drops an empty or missing md5, so a
  // listed row could not carry the odd shapes these rows need.
  const made = await account.upload('a.txt', BODY)
  await account.run.recordRequests()
  await read(
    account.driveAccessor(),
    UNRECORDED_SPEC,
    options,
    row(made, 'a.txt', 'gdrive/file', UNRECORDED_STAMP, extra),
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
    expect((await account.log()).map(([name]) => name)).toEqual(['media'])
  })

  it('stamps no entry token on a pinned read', async () => {
    // Pinned bytes are an old revision; the entry's md5 describes head.
    const made = await account.upload('a.txt', BODY)
    const pinned = (await account.item(made)).headRevisionId as string
    await account.update(made, 'newer bytes')
    await account.run.recordRequests()
    const data = await bindCaller(
      { ...currentCaller(), revisions: { map: new Map([['/gd/a.txt', pinned]]) } },
      () =>
        read(
          account.driveAccessor(),
          UNRECORDED_SPEC,
          undefined,
          row(made, 'a.txt', 'gdrive/file', UNRECORDED_STAMP, { md5_checksum: BODY_MD5 }),
        ),
    )
    expect(DEC.decode(data)).toBe(BODY)
    expect(UNRECORDED.records).toEqual([['/gd/a.txt', { fingerprint: null, revision: pinned }]])
    expect(await account.log()).toEqual([['revision', pinned]])
  })

  it('a recorded read prefers the capture over the entry', async () => {
    // The capture is the fresher of the two; the entry can be a TTL old.
    const made = await account.upload('a.txt', BODY)
    const revision = (await account.item(made)).headRevisionId as string
    const [, records] = await recordingScope(() =>
      read(
        account.driveAccessor(),
        UNRECORDED_SPEC,
        undefined,
        row(made, 'a.txt', 'gdrive/file', UNRECORDED_STAMP, { md5_checksum: '0'.repeat(32) }),
      ),
    )
    expect(records.map((r) => [r.fingerprint, r.revision])).toEqual([[BODY_MD5, revision]])
  })
})

describe('the native gdrive read record path', () => {
  for (const [resourceType, vfsName, mime] of NATIVE) {
    for (const mount of ['/gd', '']) {
      it(`records ${mount}/${vfsName} for a mount at '${mount || '/'}'`, async () => {
        // The cache fill matches on the virtual path; the mount path names
        // nothing under a mount at /gd.
        const entry = await nativeRow(resourceType, vfsName, mime)
        const [, records] = await recordingScope(() =>
          read(account.driveAccessor(), specFor(vfsName, mount), undefined, entry),
        )
        expect(records.map((r) => [r.path, r.fingerprint])).toEqual([
          [`${mount}/${vfsName}`, STAMP],
        ])
      })
    }
  }
})
