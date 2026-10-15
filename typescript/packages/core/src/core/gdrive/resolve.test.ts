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

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  const { driveModuleMock } = await import('./_test_util.ts')
  return driveModuleMock(actual)
})

import type { FakeDrive } from './_test_util.ts'
import {
  DOC_MIME,
  makeGDriveAccessor,
  makeScopedGDriveAccessor,
  resetFakeDrive,
} from './_test_util.ts'
import { DirListing, FileStat, FileType, PathSpec } from '../../types.ts'
import { GoogleApiError } from '../google/client.ts'
import { readdir } from './readdir.ts'
import { driveTargetName, eaccesOnDenied, parentFolder, rootContext } from './resolve.ts'

const FOLDER_MIME_TEST = 'application/vnd.google-apps.folder'

const ENC = new TextEncoder()
let fake: FakeDrive
const accessor = makeGDriveAccessor()

beforeEach(() => {
  fake = resetFakeDrive()
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
    const scope = fake.folder('scope')
    const inner = fake.add('f.txt', scope, undefined, ENC.encode('in'))
    fake.add('f.txt', 'root', undefined, ENC.encode('out'))
    const scoped = makeScopedGDriveAccessor(scope)
    expect(await rootContext(scoped)).toEqual([scope, null])
    const listed = await rows(readdir(scoped, PathSpec.fromStrPath('/')))
    expect(listed.map((row) => row.extra.file_id)).toEqual([inner])
  })
})

describe('gdrive resolve with a shared-drive scope', () => {
  it('threads the root driveId and memoizes the lookup', async () => {
    const scope = fake.add('team', 'root', FOLDER_MIME_TEST, new Uint8Array(0), 'd1')
    const inner = fake.add('f.txt', scope, undefined, ENC.encode('in'), 'd1')
    const scoped = makeScopedGDriveAccessor(scope)
    expect(await rootContext(scoped)).toEqual([scope, 'd1'])
    expect(await rootContext(scoped)).toEqual([scope, 'd1'])
    const listed = await rows(readdir(scoped, PathSpec.fromStrPath('/')))
    expect(listed.map((row) => [row.extra.file_id, row.extra.drive_id])).toEqual([[inner, 'd1']])
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
    expect(await parentFolder(accessor, path, null)).toEqual(['root', null])
  })

  it('lands a create in the folder its parent names', async () => {
    const folder = new FileStat({
      name: 'a',
      type: FileType.DIRECTORY,
      extra: { file_id: 'f1', drive_id: 'd1' },
    })
    const path = PathSpec.fromStrPath('/drive/a/new.txt', 'a/new.txt')
    expect(await parentFolder(accessor, path, folder)).toEqual(['f1', 'd1'])
  })

  it.each(['missing', 'file'])('names the operand for a %s parent', async (kind) => {
    const parent =
      kind === 'missing'
        ? null
        : new FileStat({ name: 'a', type: FileType.FILE, extra: { file_id: 'f1' } })
    const path = PathSpec.fromStrPath('/drive/a/child', 'a/child')
    await expect(parentFolder(accessor, path, parent)).rejects.toMatchObject({
      code: kind === 'missing' ? 'ENOENT' : 'ENOTDIR',
      virtualPath: path.virtual,
    })
  })
})
