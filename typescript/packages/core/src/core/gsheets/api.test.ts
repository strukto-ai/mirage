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
import type * as ClientModule from '../google/client.ts'

vi.mock('../google/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  googleGet: vi.fn(),
}))

import { googleGet, type TokenManager } from '../google/client.ts'
import { SheetsClient } from './api.ts'

const TOKEN_MANAGER = { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager
const DEC = new TextDecoder()

describe('SheetsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // spreadsheets.get returns no cell values unless asked, so the rendered
  // .gsheet.json would be tab metadata without this; the mask keeps every
  // cell's formats out of it.
  it('reads a spreadsheet with its values and no formats', async () => {
    vi.mocked(googleGet).mockResolvedValue({ spreadsheetId: 's1' })
    const out = await new SheetsClient(TOKEN_MANAGER).readSpreadsheet('s1')
    expect(JSON.parse(DEC.decode(out))).toEqual({ spreadsheetId: 's1' })
    expect(googleGet).toHaveBeenCalledWith(
      TOKEN_MANAGER,
      'https://sheets.googleapis.com/v4/spreadsheets/s1',
      {
        includeGridData: 'true',
        fields:
          'spreadsheetId,spreadsheetUrl,properties,namedRanges,' +
          'sheets(properties,data(startRow,startColumn,' +
          'rowData(values(formattedValue,userEnteredValue,effectiveValue))))',
      },
    )
  })

  it('reads a range through the values API', async () => {
    vi.mocked(googleGet).mockResolvedValue({ values: [['a']] })
    const out = await new SheetsClient(TOKEN_MANAGER).readValues('s1', 'A1:B2')
    expect(JSON.parse(DEC.decode(out))).toEqual({ values: [['a']] })
    expect(googleGet).toHaveBeenCalledWith(
      TOKEN_MANAGER,
      'https://sheets.googleapis.com/v4/spreadsheets/s1/values/A1:B2',
    )
  })
})
