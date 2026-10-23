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

import { sheetsBase, type TokenManager, googleGet } from '../google/client.ts'
import { compactJsonBytes } from '../render/json.ts'

const GRID_DATA_PARAM = 'true'
// The fields vfs/gsheets/prompt.ts documents. Without a mask every cell also
// carries userEnteredFormat and effectiveFormat and every grid its row and
// column metadata, which outweigh the values many times over.
const SPREADSHEET_FIELDS =
  'spreadsheetId,spreadsheetUrl,properties,namedRanges,' +
  'sheets(properties,data(startRow,startColumn,' +
  'rowData(values(formattedValue,userEnteredValue,effectiveValue))))'

/**
 * Every Sheets read a Google backend makes, as one object. A core op reaches
 * Sheets only through `accessor.sheets`. Mirrors Python's `SheetsApi`.
 */
export interface SheetsApi {
  readSpreadsheet(spreadsheetId: string): Promise<Uint8Array>
  readValues(spreadsheetId: string, range: string): Promise<Uint8Array>
}

/** The live `SheetsApi`: one token manager, one wire call per method. */
export class SheetsClient implements SheetsApi {
  readonly tokenManager: TokenManager

  constructor(tokenManager: TokenManager) {
    this.tokenManager = tokenManager
  }

  /**
   * Fetch spreadsheet JSON, cell values included and formats left out.
   *
   * `spreadsheets.get` returns no grid data unless asked, so without
   * `includeGridData` the rendered `.gsheet.json` is tab metadata and nothing
   * an agent can read a cell from. The `fields` mask then keeps the structure
   * the VFS prompt documents; formatting stays reachable through
   * `gws sheets spreadsheets get`.
   */
  async readSpreadsheet(spreadsheetId: string): Promise<Uint8Array> {
    const url = `${sheetsBase(this.tokenManager)}/spreadsheets/${spreadsheetId}`
    const data = await googleGet(this.tokenManager, url, {
      includeGridData: GRID_DATA_PARAM,
      fields: SPREADSHEET_FIELDS,
    })
    return compactJsonBytes(data)
  }

  /** Read cell values via the Values API. */
  async readValues(spreadsheetId: string, range: string): Promise<Uint8Array> {
    const base = sheetsBase(this.tokenManager)
    const data = await googleGet(
      this.tokenManager,
      `${base}/spreadsheets/${spreadsheetId}/values/${range}`,
    )
    return compactJsonBytes(data)
  }
}
