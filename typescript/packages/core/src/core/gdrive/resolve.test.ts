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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DirListing, FileStat, FileType, PathSpec } from '../../types.ts'
import { GoogleApiError } from '../google/client.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { GoogleAccount } from '../../../tests/core/google/account.ts'
import { readdir } from './readdir.ts'
import { driveTargetName, eaccesOnDenied, parentFolder, rootContext } from './resolve.ts'

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

async function rows(
  listed: Promise<readonly FileStat[] | DirListing>,
): Promise<readonly FileStat[]> {
  const found = await listed
  return found instanceof DirListing ? found.entries : found
}

describe('gdrive resolve', () => {
  it('names a native file without its rendered suffix', () => {
    expect(driveTargetName('new.gdoc.json', DOC_MIME)).toBe('new')
    expect(driveTargetName('new.gdoc.json', 'text/plain')).toBe('new.gdoc.json')
    expect(driveTargetName('new.txt', DOC_MIME)).toBe('new.txt')
  })
})

describe('gdrive resolve with a folder scope', () => {
  it('lists the configured folder', async () => {
    const scope = await account.folder('scope')
    const inner = await account.upload('f.txt', 'in', scope)
    await account.upload('f.txt', 'out')
    const scoped = account.driveAccessor(undefined, { folderId: scope })
    expect(await rootContext(scoped)).toEqual([scope, null])
    const listed = await rows(readdir(scoped, PathSpec.fromStrPath('/')))
    expect(listed.map((row) => row.extra.file_id)).toEqual([inner])
  })
})

describe('gdrive resolve with a shared-drive scope', () => {
  it('threads the root driveId and memoizes the lookup', async () => {
    const drive = await account.sharedDrive('Team')
    const scope = await account.folder('team', drive)
    const inner = await account.upload('f.txt', 'in', scope)
    const scoped = account.driveAccessor(undefined, { folderId: scope })
    await account.run.recordRequests()
    expect(await rootContext(scoped)).toEqual([scope, drive])
    expect(await rootContext(scoped)).toEqual([scope, drive])
    expect(await account.log()).toEqual([['get', scope]])
    const listed = await rows(readdir(scoped, PathSpec.fromStrPath('/')))
    expect(listed.map((row) => [row.extra.file_id, row.extra.drive_id])).toEqual([[inner, drive]])
  })
})

describe('eaccesOnDenied', () => {
  it('maps a 403 to EACCES on the operand, passes other errors through', async () => {
    const spec = PathSpec.fromStrPath('/gd/a.txt')
    const denied = eaccesOnDenied(async (_a: unknown, _p: PathSpec) => {
      await Promise.resolve()
      throw new GoogleApiError('denied', 403)
    })
    const serverError = eaccesOnDenied(async (_a: unknown, _p: PathSpec) => {
      await Promise.resolve()
      throw new GoogleApiError('boom', 500)
    })
    await expect(denied(null, spec)).rejects.toMatchObject({
      code: 'EACCES',
      message: expect.stringContaining('/gd/a.txt') as string,
    })
    await expect(serverError(null, spec)).rejects.toBeInstanceOf(GoogleApiError)
  })
})

describe('parentFolder', () => {
  it('lands a create at the root in the root folder', async () => {
    const path = PathSpec.fromStrPath('/drive/new.txt', 'new.txt')
    expect(await parentFolder(account.driveAccessor(), path, null)).toEqual(['root', null])
  })

  it('lands a create in the folder its parent names', async () => {
    const drive = await account.sharedDrive('Team')
    const made = await account.folder('a', drive)
    const folder = new FileStat({
      name: 'a',
      type: FileType.DIRECTORY,
      extra: { file_id: made, drive_id: drive },
    })
    const path = PathSpec.fromStrPath('/drive/a/new.txt', 'a/new.txt')
    expect(await parentFolder(account.driveAccessor(), path, folder)).toEqual([made, drive])
  })

  it.each(['missing', 'file'])('names the operand for a %s parent', async (kind) => {
    const parent =
      kind === 'missing'
        ? null
        : new FileStat({
            name: 'a',
            type: FileType.FILE,
            extra: { file_id: await account.upload('a', 'a') },
          })
    const path = PathSpec.fromStrPath('/drive/a/child', 'a/child')
    await expect(parentFolder(account.driveAccessor(), path, parent)).rejects.toMatchObject({
      code: kind === 'missing' ? 'ENOENT' : 'ENOTDIR',
      virtualPath: path.virtual,
    })
  })
})
