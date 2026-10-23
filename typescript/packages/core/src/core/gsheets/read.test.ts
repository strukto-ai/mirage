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

import { mountKey } from '../../utils/key_prefix.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GSheetsAccessor } from '../../accessor/gsheets.ts'
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec, type FileStat } from '../../types.ts'
import { GSheetsVFS } from '../../vfs/gsheets/gsheets.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { TokenManager } from '../google/client.ts'
import type { SheetsApi } from './api.ts'
import { read } from './read.ts'
import { stubDrive, type StubDrive } from '../../../tests/core/gdrive/_test_util.ts'
import { installApi } from '../../../tests/core/google/_test_util.ts'

const ENC = new TextEncoder()

let drive: StubDrive
let sheets: { readSpreadsheet: ReturnType<typeof vi.fn<SheetsApi['readSpreadsheet']>> }

beforeEach(() => {
  drive = stubDrive()
  sheets = { readSpreadsheet: vi.fn<SheetsApi['readSpreadsheet']>() }
  installApi({ drive, sheets })
})

const STUB_TOKEN_MANAGER = {
  config: { clientId: 'cid', refreshToken: 'rt' },
} as TokenManager

function makeAccessor(): GSheetsAccessor {
  return new GSheetsAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

describe('gsheets read auto-bootstrap', () => {
  it('resolves a read no listing named by its id', async () => {
    drive.getFile.mockResolvedValue({
      mimeType: 'application/vnd.google-apps.spreadsheet',
      id: 'sheet1',
      name: 'Budget',
      modifiedTime: '2026-04-01T00:00:00.000Z',
      owners: [{ me: true }],
    })
    sheets.readSpreadsheet.mockResolvedValue(
      ENC.encode(JSON.stringify({ spreadsheetId: 'sheet1' })),
    )

    const accessor = makeAccessor()
    const path = new PathSpec({
      virtual: '/gsheets/owned/2026-04-01_Budget__sheet1.gsheet.json',
      directory: '/gsheets/owned/2026-04-01_Budget__sheet1.gsheet.json',
      vfsPath: mountKey('/gsheets/owned/2026-04-01_Budget__sheet1.gsheet.json', '/gsheets'),
    })
    const out = await read(accessor, path)
    expect(new TextDecoder().decode(out)).toContain('sheet1')
  })

  it('throws ENOENT when file missing by ID', async () => {
    drive.getFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    sheets.readSpreadsheet.mockRejectedValue(new Error('should not call readSpreadsheet'))

    const accessor = makeAccessor()
    const path = new PathSpec({
      virtual: '/gsheets/owned/Missing__xyz.gsheet.json',
      directory: '/gsheets/owned/Missing__xyz.gsheet.json',
      vfsPath: mountKey('/gsheets/owned/Missing__xyz.gsheet.json', '/gsheets'),
    })
    await expect(read(accessor, path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('gsheets read token', () => {
  // read: fresh compares this record with stat's fingerprint, so both take
  // the file's modified stamp, and a file without one stamps nothing.
  const cases: [string, string | null][] = [
    ['2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'],
    ['', null],
  ]
  for (const [stamp, token] of cases) {
    it(`records the token stat reports (stamp ${JSON.stringify(stamp)})`, async () => {
      const item = {
        mimeType: 'application/vnd.google-apps.spreadsheet',
        id: 's1',
        name: 'My Sheet',
        modifiedTime: stamp,
        owners: [{ me: true }],
      }
      drive.listAllFiles.mockResolvedValue({ files: [item], complete: true })
      drive.getFile.mockResolvedValue(item)
      sheets.readSpreadsheet.mockResolvedValue(ENC.encode(JSON.stringify({ spreadsheetId: 's1' })))
      const accessor = makeAccessor()
      const vfs = Object.assign(
        new GSheetsVFS({ clientId: 'id', clientSecret: 's', refreshToken: 'rt' }),
        { accessor },
      )
      const ws = new Workspace({ '/gsheets/': vfs })
      const [target = ''] = (await ws.dispatch('readdir', '/gsheets/owned')) as string[]
      const path = new PathSpec({
        virtual: target,
        directory: target,
        vfsPath: mountKey(target, '/gsheets'),
      })
      const [data, records] = await runWithRecording(() => read(accessor, path))
      const info = (await ws.dispatch('stat', target)) as FileStat
      expect(records.map((r) => [r.op, r.path, r.source, r.bytes, r.fingerprint])).toEqual([
        ['read', target, 'gsheets', data.byteLength, token],
      ])
      expect(info.fingerprint).toBe(token)
    })
  }
})
