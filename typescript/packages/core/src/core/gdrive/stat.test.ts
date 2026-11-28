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
import { ContentType, FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { ManualClock } from '../../utils/clock.ts'
import { GoogleDriveVFS } from '../../vfs/gdrive/gdrive.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { GoogleApiError } from '../google/client.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { DRIVES, FILES, GoogleAccount, UNTIL_CLEARED } from '../../../tests/core/google/account.ts'
import { statFromItem } from './readdir.ts'
import { stat } from './stat.ts'

const STAMP = '2026-04-01T00:00:00.000Z'
const DOC_MIME = 'application/vnd.google-apps.document'

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

// A workspace binds its own clock to its mounts' clients, so retries in a
// test that refuses one wait on the clock it is handed.
function workspace(clock?: ManualClock): Workspace {
  const vfs = new GoogleDriveVFS(account.config())
  return new Workspace(
    { '/drive/': vfs },
    { mode: MountMode.READ, ...(clock === undefined ? {} : { clock }) },
  )
}

describe('gdrive stat', () => {
  it('answers a directory for the mount root', async () => {
    const result = await stat(
      account.driveAccessor(),
      new PathSpec({ vfsPath: '', virtual: '/', directory: '/' }),
    )
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(result.name).toBe('/')
  })

  it('answers the row its parent listed', async () => {
    const row = statFromItem({
      id: 'f1',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      size: '1024',
    })
    await account.run.recordRequests()
    const result = await stat(account.driveAccessor(), PathSpec.fromStrPath('/report.pdf'), row)
    expect(result).toBe(row)
    expect(result.size).toBe(1024)
    expect(result.extra.resource_type).toBe('gdrive/file')
    expect(await account.log()).toEqual([])
  })

  it('answers ENOENT for nothing', async () => {
    await expect(
      stat(account.driveAccessor(), PathSpec.fromStrPath('/nonexistent.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

// Mirrors python's test_a_cold_stat_lists_its_parent_once and
// test_a_failed_parent_listing_propagates.
describe('gdrive stat through a mount', () => {
  it('lists its parent once when cold', async () => {
    const id = await account.upload('fresh.pdf', 'p'.repeat(2048))
    await account.run.recordRequests()
    const ws = workspace()
    try {
      const result = (await ws.dispatch('stat', '/drive/fresh.pdf')) as FileStat
      expect(result.extra.file_id).toBe(id)
      // binary files download raw, so Drive's size is the rendered length
      expect(result.size).toBe(2048)
      const listed = (await account.log()).filter(([name]) => name === 'list').map(([, d]) => d)
      expect(listed).toEqual(['root'])
    } finally {
      await ws.close()
    }
  })

  it('propagates a failed parent listing', async () => {
    await account.refuse('GET', FILES, 503, 'Backend Error', {
      reason: 'backendError',
      times: UNTIL_CLEARED,
    })
    const ws = workspace(new ManualClock())
    try {
      await expect(ws.dispatch('stat', '/drive/missing.txt')).rejects.toThrow(GoogleApiError)
      await expect(ws.dispatch('stat', '/drive/missing.txt')).rejects.toThrow(/Backend Error/)
    } finally {
      await ws.close()
    }
  })

  // Mirrors python's test_a_partial_root_does_not_make_a_child_a_permanent_hit.
  it.each(['updated', 'deleted'])(
    'does not make a child of a partial root a permanent hit: %s',
    async (change) => {
      const old = await account.upload('readme.txt', 'old')
      await account.refuse('GET', DRIVES, 403, 'Insufficient scope')
      const ws = workspace()
      try {
        await ws.dispatch('readdir', '/drive')
        const index = ws.mount('/drive/').indexStore
        expect((await index.listDir('/drive')).entries ?? null).toBeNull()
        await index.invalidate()
        await account.delete(old)
        if (change === 'updated') {
          const made = await account.upload('readme.txt', 'x'.repeat(42))
          const result = (await ws.dispatch('stat', '/drive/readme.txt')) as FileStat
          expect(result.extra.file_id).toBe(made)
          expect(result.size).toBe(42)
        } else {
          await expect(ws.dispatch('stat', '/drive/readme.txt')).rejects.toMatchObject({
            code: 'ENOENT',
          })
        }
      } finally {
        await ws.close()
      }
    },
  )
})

describe('the token a listed row stamps', () => {
  function rowWith(tokens: Record<string, string>, mimeType = 'application/pdf'): FileStat {
    return statFromItem({ id: 'f1', name: 'report', mimeType, modifiedTime: STAMP, ...tokens })
  }

  it('prefers the md5', () => {
    expect(rowWith({ md5Checksum: 'abc', headRevisionId: 'r3' }).fingerprint).toBe('abc')
  })

  it('falls to the head revision when there is no md5', () => {
    expect(rowWith({ headRevisionId: 'r3' }).fingerprint).toBe('r3')
  })

  it('stamps nothing for a file with content and neither token', () => {
    expect(rowWith({}).fingerprint).toBeNull()
  })

  it('stamps a doc by its modified time', () => {
    expect(rowWith({}, DOC_MIME).fingerprint).toBe(STAMP)
  })
})

describe('a Drive item as a row', () => {
  it('renders every kind in full', async () => {
    // Each kind's name suffix, size, token and extras, from the items as
    // Drive answers them.
    const doc = await account.item(await account.create('Report', DOC_MIME))
    const folder = await account.item(await account.folder('d'))
    const blob = await account.item(await account.upload('a.bin', 'hello'))
    const md5 = createHash('md5').update('hello').digest('hex')
    expect(statFromItem(doc)).toEqual(
      new FileStat({
        name: 'Report.gdoc.json',
        size: null,
        type: FileType.FILE,
        content: ContentType.JSON,
        modified: doc.modifiedTime,
        fingerprint: doc.modifiedTime,
        extra: {
          file_id: doc.id,
          mime_type: DOC_MIME,
          parents: ['root'],
          resource_type: 'gdrive/gdoc',
        },
      }),
    )
    expect(statFromItem(folder)).toEqual(
      new FileStat({
        name: 'd',
        type: FileType.DIRECTORY,
        modified: folder.modifiedTime,
        extra: {
          file_id: folder.id,
          mime_type: 'application/vnd.google-apps.folder',
          parents: ['root'],
        },
      }),
    )
    expect(statFromItem(blob)).toEqual(
      new FileStat({
        name: 'a.bin',
        size: 5,
        type: FileType.FILE,
        content: ContentType.BINARY,
        modified: blob.modifiedTime,
        fingerprint: md5,
        extra: {
          file_id: blob.id,
          mime_type: 'application/octet-stream',
          parents: ['root'],
          md5_checksum: md5,
          head_revision_id: blob.headRevisionId as string,
          resource_type: 'gdrive/file',
        },
      }),
    )
  })
})
