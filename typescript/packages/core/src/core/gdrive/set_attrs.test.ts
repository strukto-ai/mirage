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

import { describe, expect, it, vi } from 'vitest'
import type * as DriveModule from '../google/drive.ts'
import type * as ResolveModule from './resolve.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  return { ...actual, patchFile: vi.fn() }
})
vi.mock('./resolve.ts', async () => {
  const actual = await vi.importActual<typeof ResolveModule>('./resolve.ts')
  return { ...actual, resolveKey: vi.fn() }
})

import { PathSpec } from '../../types.ts'
import * as drive from '../google/drive.ts'
import { makeGDriveAccessor } from './_test_util.ts'
import * as resolve from './resolve.ts'
import { setAttrs } from './set_attrs.ts'

const MTIME = '2020-01-01T00:00:00+00:00'

describe('gdrive setAttrs', () => {
  it.each<[string, unknown[], Record<string, number | string>]>([
    ['/a.txt', [{ body: { modifiedTime: '2020-01-01T00:00:00Z' } }], { uid: 7 }],
    ['/', [], { uid: 7, mtime: MTIME }],
  ])('stores an mtime on %s as the modified time', async (path, sent, residual) => {
    vi.mocked(drive.patchFile).mockClear()
    vi.mocked(resolve.resolveKey).mockResolvedValue({
      id: 'f1',
      name: 'a.txt',
      mimeType: 'x',
      driveId: null,
    })
    vi.mocked(drive.patchFile).mockResolvedValue({ id: 'f1', name: 'a.txt' })
    expect(
      await setAttrs(makeGDriveAccessor(), PathSpec.fromStrPath(path), { uid: 7, mtime: MTIME }),
    ).toEqual(residual)
    expect(vi.mocked(drive.patchFile).mock.calls.map((call) => call[2])).toEqual(sent)
  })
})
