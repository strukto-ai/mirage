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
import { describe, expect, it, vi } from 'vitest'
import type * as DriveModule from '../google/drive.ts'
import type * as ClientModule from '../google/client.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  return { ...actual, listAllFiles: vi.fn(), getFile: vi.fn() }
})

vi.mock('../google/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../google/client.ts')
  return { ...actual, googleGet: vi.fn() }
})

import { GSheetsAccessor } from '../../accessor/gsheets.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/client.ts'
import * as drive from '../google/drive.ts'
import * as client from '../google/client.ts'
import { read, readSpreadsheet } from './read.ts'
import { stat } from './stat.ts'

const STUB_TOKEN_MANAGER = {
  config: { clientId: 'cid', refreshToken: 'rt' },
} as TokenManager

function makeAccessor(): GSheetsAccessor {
  return new GSheetsAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

describe('gsheets read auto-bootstrap', () => {
  it('fetches metadata by ID when entry is evicted from index', async () => {
    vi.mocked(drive.getFile).mockResolvedValue({
      mimeType: 'application/vnd.google-apps.spreadsheet',
      id: 'sheet1',
      name: 'Budget',
      modifiedTime: '2026-04-01T00:00:00.000Z',
      owners: [{ me: true }],
    })
    vi.mocked(client.googleGet).mockResolvedValue({ spreadsheetId: 'sheet1' })

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      virtual: '/gsheets/owned/2026-04-01_Budget__sheet1.gsheet.json',
      directory: '/gsheets/owned/2026-04-01_Budget__sheet1.gsheet.json',
      vfsPath: mountKey('/gsheets/owned/2026-04-01_Budget__sheet1.gsheet.json', '/gsheets'),
    })
    const out = await read(accessor, path, index)
    expect(new TextDecoder().decode(out)).toContain('sheet1')
  })

  it('throws ENOENT when file missing by ID', async () => {
    vi.mocked(drive.getFile).mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    )
    vi.mocked(client.googleGet).mockRejectedValue(new Error('should not call googleGet'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      virtual: '/gsheets/owned/Missing__xyz.gsheet.json',
      directory: '/gsheets/owned/Missing__xyz.gsheet.json',
      vfsPath: mountKey('/gsheets/owned/Missing__xyz.gsheet.json', '/gsheets'),
    })
    await expect(read(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('asks for grid data, which spreadsheets.get omits by default, and values only', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ spreadsheetId: 's1' })
    await readSpreadsheet(STUB_TOKEN_MANAGER, 's1')
    expect(vi.mocked(client.googleGet).mock.lastCall?.[1]).toMatch(/\/spreadsheets\/s1$/)
    expect(vi.mocked(client.googleGet).mock.lastCall?.[2]).toEqual({
      includeGridData: 'true',
      fields:
        'spreadsheetId,spreadsheetUrl,properties,namedRanges,' +
        'sheets(properties,data(startRow,startColumn,' +
        'rowData(values(formattedValue,userEnteredValue,effectiveValue))))',
    })
  })
})

describe('gsheets read token', () => {
  // read: fresh compares this record with stat's fingerprint, so both take
  // the entry's modified stamp, and an entry without one stamps nothing.
  const cases: [string, string | null][] = [
    ['2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'],
    ['', null],
  ]
  for (const [stamp, token] of cases) {
    it(`records the token stat reports (stamp ${JSON.stringify(stamp)})`, async () => {
      const name = '2026-04-01_My_Sheet__s1.gsheet.json'
      const target = `/gsheets/owned/${name}`
      const index = new RAMIndexCacheStore()
      await index.setDir('/gsheets/owned', [
        [
          name,
          new IndexEntry({
            id: 's1',
            name: 'My Sheet',
            resourceType: 'gsheets/file',
            remoteTime: stamp,
            vfsName: name,
          }),
        ],
      ])
      vi.mocked(client.googleGet).mockResolvedValue({ spreadsheetId: 's1' })
      const path = new PathSpec({
        virtual: target,
        directory: target,
        vfsPath: mountKey(target, '/gsheets'),
      })
      const accessor = makeAccessor()
      const [data, records] = await runWithRecording(() => read(accessor, path, index))
      const info = await stat(accessor, path, index)
      expect(records.map((r) => [r.op, r.path, r.source, r.bytes, r.fingerprint])).toEqual([
        ['read', target, 'gsheets', data.byteLength, token],
      ])
      expect(info.fingerprint).toBe(token)
    })
  }
})
