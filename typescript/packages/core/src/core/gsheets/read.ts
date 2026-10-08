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

import type { GSheetsAccessor } from '../../accessor/gsheets.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { sheetsBase, type TokenManager, googleGet } from '../google/client.ts'
import { resolveAppEntry } from '../google/entry.ts'
import { MIME } from './constants.ts'
import { makeFilename } from '../../vfs/gsheets/sheet_entry.ts'
import { makeRead } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { compactJsonBytes } from '../render/json.ts'
import { detectScope } from './scope.ts'

const GRID_DATA_PARAM = 'true'
// The fields vfs/gsheets/prompt.ts documents. Without a mask every cell also
// carries userEnteredFormat and effectiveFormat and every grid its row and
// column metadata, which outweigh the values many times over.
const SPREADSHEET_FIELDS =
  'spreadsheetId,spreadsheetUrl,properties,namedRanges,' +
  'sheets(properties,data(startRow,startColumn,' +
  'rowData(values(formattedValue,userEnteredValue,effectiveValue))))'

/**
 * Fetch spreadsheet JSON, cell values included and formats left out.
 *
 * `spreadsheets.get` returns no grid data unless asked, so without
 * `includeGridData` the rendered `.gsheet.json` is tab metadata and nothing
 * an agent can read a cell from. The `fields` mask then keeps the structure
 * the VFS prompt documents; formatting stays reachable through
 * `gws sheets spreadsheets get`.
 */
export async function readSpreadsheet(
  tm: TokenManager,
  spreadsheetId: string,
): Promise<Uint8Array> {
  const url = `${sheetsBase(tm)}/spreadsheets/${spreadsheetId}`
  const data = await googleGet(tm, url, {
    includeGridData: GRID_DATA_PARAM,
    fields: SPREADSHEET_FIELDS,
  })
  return compactJsonBytes(data)
}

export async function readValues(
  tm: TokenManager,
  spreadsheetId: string,
  range: string,
): Promise<Uint8Array> {
  const url = `${sheetsBase(tm)}/spreadsheets/${spreadsheetId}/values/${range}`
  const data = await googleGet(tm, url)
  return compactJsonBytes(data)
}

async function readFile(
  accessor: GSheetsAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const entry = await resolveAppEntry(
    accessor.tokenManager,
    match,
    path,
    index,
    MIME,
    'gsheets/file',
    makeFilename,
  )
  const timer = startOp()
  const data = await readSpreadsheet(accessor.tokenManager, entry.id)
  record('read', path.virtual, 'gsheets', data.length, timer, {
    fingerprint: entry.remoteTime !== '' ? entry.remoteTime : null,
  })
  return data
}

export const read = makeRead<GSheetsAccessor>(detectScope, { file: readFile })
