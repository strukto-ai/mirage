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

import { describe, expect, it } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { makeGDriveAccessor, stubDrive } from '../../../tests/core/gdrive/_test_util.ts'
import { setAttrs } from './set_attrs.ts'

const MTIME = '2020-01-01T00:00:00+00:00'
const ROW = new FileStat({ name: 'a.txt', type: FileType.FILE, extra: { file_id: 'f1' } })

describe('gdrive setAttrs', () => {
  it.each<[string, unknown[], Record<string, number | string>]>([
    ['/a.txt', [{ body: { modifiedTime: '2020-01-01T00:00:00Z' } }], { uid: 7 }],
    ['/', [], { uid: 7, mtime: MTIME }],
  ])('stores an mtime on %s as the modified time', async (path, sent, residual) => {
    const drive = stubDrive()
    drive.patchFile.mockResolvedValue({ id: 'f1', name: 'a.txt' })
    expect(
      await setAttrs(
        makeGDriveAccessor(drive),
        PathSpec.fromStrPath(path),
        { uid: 7, mtime: MTIME },
        path === '/' ? null : ROW,
      ),
    ).toEqual(residual)
    expect(drive.patchFile.mock.calls.map((call) => call[0])).toEqual(
      sent.length === 0 ? [] : ['f1'],
    )
    expect(drive.patchFile.mock.calls.map((call) => call[1])).toEqual(sent)
  })
})
