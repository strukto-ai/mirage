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
import type * as DriveModule from './drive.ts'

vi.mock('./drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('./drive.ts')
  return { ...actual, listAllFiles: vi.fn() }
})

import { GoogleApiAccessor } from '../../accessor/google_api.ts'
import { PathSpec, type DirListing, type FileStat } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { MIME } from '../gsheets/constants.ts'
import { detectScope } from '../gsheets/scope.ts'
import type { TokenManager } from './client.ts'
import * as drive from './drive.ts'
import { makeAppReaddir } from './readdir.ts'

const ACCESSOR = new GoogleApiAccessor({ tokenManager: {} as TokenManager })

const FILES = [
  {
    id: 'a1',
    name: 'Mine',
    modifiedTime: '2026-04-01T00:00:00.000Z',
    owners: [{ me: true }],
    size: '12',
  },
  { id: 'b2', name: 'Theirs', owners: [{ me: false }] },
]

const READDIR = makeAppReaddir(
  MIME,
  detectScope,
  (title, fileId, modified) => `${title}.${fileId}.${modified.slice(0, 4)}`,
)

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, '/m') })
}

describe('makeAppReaddir', () => {
  it("lists a corpus's own files through the app's namer", async () => {
    vi.mocked(drive.listAllFiles).mockResolvedValue({
      files: FILES,
      complete: true,
    } as Awaited<ReturnType<typeof drive.listAllFiles>>)
    const out = (await READDIR(ACCESSOR, spec('/m/owned'))) as DirListing
    expect(out.partial).toBe(false)
    expect(out.entries.map((row) => row.name)).toEqual(['Mine.a1.2026'])
    expect(vi.mocked(drive.listAllFiles).mock.calls[0]?.[1]?.mimeType).toBe(MIME)
    expect(out.entries[0]?.size).toBeNull()
    expect(out.entries[0]?.extra).toEqual({ doc_id: 'a1', doc_name: 'Mine', source_size: 12 })
  })

  it('lists the corpora at the root without a request', async () => {
    vi.mocked(drive.listAllFiles).mockClear()
    const out = (await READDIR(ACCESSOR, spec('/m'))) as FileStat[]
    expect(out.map((row) => row.name)).toEqual(['owned', 'shared'])
    expect(drive.listAllFiles).not.toHaveBeenCalled()
  })
})
