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

import { createHash } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DirListing, FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { ManualClock } from '../../utils/clock.ts'
import { GoogleDriveVFS } from '../../vfs/gdrive/gdrive.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { GoogleApiError } from '../google/client.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import {
  DRIVES,
  FILE,
  FILES,
  GoogleAccount,
  UNTIL_CLEARED,
  type DriveListing,
} from '../../../tests/core/google/account.ts'
import { entryAt } from '../../../tests/workspace/fixtures/handed.ts'
import { liveRow, readdir } from './readdir.ts'

const DOC_MIME = 'application/vnd.google-apps.document'
const ROOT = new PathSpec({ vfsPath: '', virtual: '/', directory: '/' })
const TIMEOUT = 0.2

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

beforeEach(() => {
  account = new GoogleAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function rows(listed: readonly FileStat[] | DirListing): Map<string, FileStat> {
  const found = listed instanceof DirListing ? listed.entries : listed
  return new Map(found.map((row) => [row.name, row]))
}

/**
 * `listing` with `fields` set on the row named `name`, a field set to null
 * taken off it.
 */
function withFields(
  listing: DriveListing,
  name: string,
  fields: Record<string, string | null>,
): DriveListing {
  return {
    ...listing,
    files: listing.files.map((row) => {
      if (row.name !== name) return row
      const changed = Object.fromEntries(
        Object.entries({ ...row, ...fields }).filter(([key]) => fields[key] !== null),
      )
      return changed as typeof row
    }),
  }
}

function md5(data: string): string {
  return createHash('md5').update(data).digest('hex')
}

// Mirrors python's test_a_stat_after_the_listings_drop_lists_the_ids_again.
describe('a stat after the listings drop', () => {
  it.each(['updated', 'deleted', 'renamed-folder'])('lists the ids again: %s', async (change) => {
    const oldFolder = await account.folder('docs')
    await account.upload('report.pdf', 'old', oldFolder)
    const vfs = new GoogleDriveVFS(account.config())
    const ws = new Workspace({ '/drive/': vfs }, { mode: MountMode.READ })
    try {
      await ws.dispatch('readdir', '/drive/docs')
      await ws.mount('/drive/').indexStore.invalidate()
      await account.delete(oldFolder)
      const newFolder = await account.folder(change === 'renamed-folder' ? 'renamed' : 'docs')
      const newFile =
        change === 'deleted' ? null : await account.upload('report.pdf', 'x'.repeat(42), newFolder)
      await account.run.recordRequests()
      if (change === 'updated') {
        const result = (await ws.dispatch('stat', '/drive/docs/report.pdf')) as FileStat
        expect(result.extra.file_id).toBe(newFile)
        expect(result.size).toBe(42)
      } else {
        await expect(ws.dispatch('stat', '/drive/docs/report.pdf')).rejects.toMatchObject({
          code: 'ENOENT',
        })
      }
      const listed = (await account.log()).filter(([name]) => name === 'list').map(([, d]) => d)
      expect(listed[0]).toBe('root')
      expect(listed).not.toContain(oldFolder)
    } finally {
      await ws.close()
    }
  })
})

describe('gdrive readdir', () => {
  it('lists the root', async () => {
    const made = await account.upload('readme.txt', 'hi')
    const listed = rows(await readdir(account.driveAccessor(), ROOT))
    expect(listed.get('readme.txt')?.extra.file_id).toBe(made)
  })

  it('lists a folder by the id its row names, in its shared drive', async () => {
    // The row names the folder "docs" but carries the id of "other": the
    // listing follows the id and the drive, never the name.
    const drive = await account.sharedDrive('Team')
    await account.upload('notes.txt', 'n', await account.folder('docs', drive))
    const other = await account.folder('other', drive)
    await account.upload('x.txt', 'x', other)
    const folder = new FileStat({
      name: 'docs',
      type: FileType.DIRECTORY,
      extra: { file_id: other, drive_id: drive },
    })
    await account.run.recordRequests()
    const listed = rows(
      await readdir(
        account.driveAccessor(),
        new PathSpec({ vfsPath: 'docs', virtual: '/docs', directory: '/docs' }),
        folder,
      ),
    )
    expect([...listed.keys()]).toEqual(['x.txt'])
    expect((await account.listings()).map((l) => [l.folders, l.drive])).toEqual([[[other], drive]])
  })

  it('answers ENOENT for nothing', async () => {
    await expect(
      readdir(
        account.driveAccessor(),
        new PathSpec({ vfsPath: 'docs', virtual: '/docs', directory: '/docs' }),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('answers ENOTDIR under a file', async () => {
    // Listing a file's own id answers with an empty child set rather than an
    // error, so the row has to refuse at the file itself or `/a.txt/x` comes
    // back ENOENT where opendir(2) says ENOTDIR.
    const made = await account.upload('a.txt', 'a')
    const row = new FileStat({ name: 'a.txt', type: FileType.FILE, extra: { file_id: made } })
    await account.run.recordRequests()
    await expect(
      readdir(
        account.driveAccessor(),
        new PathSpec({ vfsPath: 'a.txt', virtual: '/a.txt', directory: '/a.txt' }),
        row,
      ),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(await account.log()).toEqual([])
  })
})

describe('readdir shared drives', () => {
  it('surfaces shared drives as top-level directories', async () => {
    await account.upload('readme.txt', 'hi')
    const drive = await account.sharedDrive('Team Drive')
    const listed = rows(await readdir(account.driveAccessor(), ROOT))
    expect(listed.has('readme.txt')).toBe(true)
    expect(listed.get('Team Drive')?.type).toBe(FileType.DIRECTORY)
    expect(listed.get('Team Drive')?.extra.drive_id).toBe(drive)
  })

  it('uniquifies duplicate shared drive names', async () => {
    const first = await account.sharedDrive('Team')
    const second = await account.sharedDrive('Team')
    const third = await account.sharedDrive('Team')
    const listed = rows(await readdir(account.driveAccessor(), ROOT))
    expect([...listed.keys()]).toEqual(['Team', 'Team [Shared Drive 2]', 'Team [Shared Drive]'])
    expect(listed.get('Team')?.extra.file_id).toBe(first)
    expect(listed.get('Team [Shared Drive]')?.extra.file_id).toBe(second)
    expect(listed.get('Team [Shared Drive 2]')?.extra.file_id).toBe(third)
  })

  it.each(['forbidden', 'dropped', 'timeout'])(
    'answers a root short of its shared drives as partial: %s',
    async (failure) => {
      // A short root listing must not be kept as the directory: it would hold
      // the mount My-Drive-only until it expires, long after the cause (a
      // missing scope) is fixed. The rows are real, so they come back as a
      // partial listing, and the next readdir retries enumeration.
      const made = await account.upload('readme.txt', 'hi')
      await account.sharedDrive('Team')
      if (failure === 'forbidden') {
        await account.refuse('GET', DRIVES, 403, 'Insufficient scope')
      } else {
        await account.run.answerNext(
          'GET',
          DRIVES,
          failure === 'timeout' ? 200 : null,
          undefined,
          UNTIL_CLEARED,
          undefined,
          undefined,
          failure === 'timeout' ? TIMEOUT * 5000 : 0,
        )
      }
      const refused = account.driveAccessor(new ManualClock(), { timeout: TIMEOUT })
      const short = await readdir(refused, ROOT)
      expect(short).toBeInstanceOf(DirListing)
      expect((short as DirListing).partial).toBe(true)
      expect(rows(short).get('readme.txt')?.extra.file_id).toBe(made)
      expect(rows(short).has('Team')).toBe(false)
      await account.run.clearAnswers()
      const full = await readdir(account.driveAccessor(), ROOT)
      expect(full).not.toBeInstanceOf(DirListing)
      expect(rows(full).has('Team')).toBe(true)
    },
  )

  it('raises any other fault in listing the shared drives', async () => {
    // Only Drive refusing or the network failing makes the root partial; any
    // other fault is raised, not hidden behind a My-Drive-only listing. A row
    // that is no drive at all fails as it is read, after the listing.
    await account.upload('readme.txt', 'hi')
    await account.run.answerNext('GET', DRIVES, 200, { drives: [null] })
    await expect(readdir(account.driveAccessor(), ROOT)).rejects.toThrow(TypeError)
  })

  it('leaves a shared drive root without a token', async () => {
    await account.sharedDrive('Team Drive')
    const row = rows(await readdir(account.driveAccessor(), ROOT)).get('Team Drive')
    expect(row?.extra.md5_checksum).toBeUndefined()
    expect(row?.fingerprint).toBeNull()
  })
})

describe('readdir rows', () => {
  it('render google-apps files with their extensions', async () => {
    await account.create('My Document', DOC_MIME)
    await account.create('My Sheet', 'application/vnd.google-apps.spreadsheet')
    await account.create('My Slides', 'application/vnd.google-apps.presentation')
    const listed = rows(await readdir(account.driveAccessor(), ROOT))
    expect([...listed.keys()].sort()).toEqual([
      'My Document.gdoc.json',
      'My Sheet.gsheet.json',
      'My Slides.gslide.json',
    ])
  })

  it('keep Drive size for binaries and move google-apps source size to extra', async () => {
    await account.upload('report.pdf', 'p'.repeat(2048))
    await account.create('My Document', DOC_MIME)
    // Drive counts a native file's quota in quotaBytesUsed; the fake keeps no
    // quota, so its own listing is answered with that one field added.
    await account.run.answerNext(
      'GET',
      FILES,
      200,
      withFields(await account.listing(), 'My Document', { quotaBytesUsed: '9999' }),
    )
    const listed = rows(await readdir(account.driveAccessor(), ROOT))
    // Binary files download raw: Drive's size is the rendered byte length.
    expect(listed.get('report.pdf')?.size).toBe(2048)
    // Google-apps files render to JSON: Drive's source size must not become
    // the row's size, it lives in extra only.
    const doc = listed.get('My Document.gdoc.json')
    expect(doc?.size).toBeNull()
    expect(doc?.extra.source_size).toBe(9999)
  })

  it.each([
    ['', '0', 0],
    ['x'.repeat(42), '42', 42],
    ['x'.repeat(42), null, null],
  ])('keep a binary size and never use the quota (%#)', async (data, reported, expected) => {
    await account.upload('file.txt', data)
    // Drive's quotaBytesUsed beside the size, and no size at all for the last
    // case: neither is a state the fake reaches, so its own listing is
    // answered with those fields changed.
    await account.run.answerNext(
      'GET',
      FILES,
      200,
      withFields(await account.listing(), 'file.txt', { quotaBytesUsed: '99', size: reported }),
    )
    const listed = rows(await readdir(account.driveAccessor(), PathSpec.fromStrPath('/drive', '')))
    expect(listed.get('file.txt')?.size).toBe(expected)
  })

  it('carry both content tokens for a binary file', async () => {
    const data = 'p'.repeat(2048)
    const made = await account.upload('report.pdf', data)
    const revision = (await account.item(made)).headRevisionId
    const row = rows(await readdir(account.driveAccessor(), ROOT)).get('report.pdf')
    expect(row?.extra.md5_checksum).toBe(md5(data))
    expect(row?.extra.head_revision_id).toBe(revision)
    expect(row?.fingerprint).toBe(md5(data))
  })

  it('omit what a native file does not have, and keep the drive beside the tokens', async () => {
    const drive = await account.sharedDrive('Team')
    const data = 'p'.repeat(2048)
    await account.upload('report.pdf', data, drive)
    await account.create('My Document', DOC_MIME, drive)
    const accessor = account.driveAccessor()
    const path = PathSpec.fromStrPath('/Team')
    const folder = await entryAt(readdir, accessor, path)
    // The native file's quotaBytesUsed, which the fake keeps none of.
    await account.run.answerNext(
      'GET',
      FILES,
      200,
      withFields(await account.listing(drive, drive), 'My Document', { quotaBytesUsed: '9999' }),
    )
    const listed = rows(await readdir(accessor, path, folder))
    const binary = listed.get('report.pdf')
    expect(binary?.extra.drive_id).toBe(drive)
    expect(binary?.extra.md5_checksum).toBe(md5(data))
    const native = listed.get('My Document.gdoc.json')
    expect(native?.extra.drive_id).toBe(drive)
    expect(native?.extra.source_size).toBe(9999)
    expect('md5_checksum' in (native?.extra ?? {})).toBe(false)
    expect('head_revision_id' in (native?.extra ?? {})).toBe(false)
  })

  it('list a scoped mount from its folder', async () => {
    const scope = await account.folder('scope')
    await account.upload('in.txt', 'x', scope)
    await account.upload('out.txt', 'y')
    const listed = rows(await readdir(account.driveAccessor(undefined, { folderId: scope }), ROOT))
    expect([...listed.keys()]).toEqual(['in.txt'])
  })
})

// Mirrors python's test_a_listed_file_deleted_since_is_looked_up_again.
describe('a listed file deleted since', () => {
  it.each([true, false])('is looked up again (replaced: %s)', async (replaced) => {
    // Drive answers 404 for the id a listing named once another client
    // deletes the file; the folder is listed again, and what it names at the
    // path now answers, null for nothing.
    const folder = await account.folder('docs')
    const listedId = await account.upload('a.txt', 'old', folder)
    const accessor = account.driveAccessor()
    const path = PathSpec.fromStrPath('/docs/a.txt')
    const listed = await entryAt(readdir, accessor, path)
    await account.delete(listedId)
    const made = replaced ? await account.upload('a.txt', 'new', folder) : null
    const row = await liveRow(accessor, path, listed)
    if (made === null) expect(row).toBeNull()
    else expect(row?.extra.file_id).toBe(made)
  })

  it('raises a refused lookup of a listed file', async () => {
    // Only Drive's 404 sends the folder to be listed again; a refusal
    // reaches the caller as it is.
    const folder = await account.folder('docs')
    await account.upload('a.txt', 'a', folder)
    const accessor = account.driveAccessor()
    const path = PathSpec.fromStrPath('/docs/a.txt')
    const listed = await entryAt(readdir, accessor, path)
    await account.refuse('GET', FILE, 403, 'Forbidden')
    const raised = liveRow(accessor, path, listed)
    await expect(raised).rejects.toBeInstanceOf(GoogleApiError)
    await expect(raised).rejects.toMatchObject({ status: 403, message: 'Forbidden' })
  })
})
