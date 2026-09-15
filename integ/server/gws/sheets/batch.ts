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

import type { JsonValue, Reply } from '../../kit/typescript/index.ts'
import { touchNative } from '../drive/item.ts'
import type { GwsState } from '../store/state.ts'
import type { SheetTab } from '../store/types.ts'
import { asNum, asObj, asObjArr, asStr } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { NOT_FOUND, googleError, ok } from '../wire/reply.ts'
import {
  autoResizeDimensions,
  deleteDimension,
  growGrid,
  insertDimension,
  moveDimension,
  resolveDimensionRange,
  updateCells,
} from './dimension.ts'
import { GRID_COLUMNS, GRID_ROWS, newTab, tabProperties } from './grid.ts'

const BAD_SHEET_ID = 'Invalid sheetId.'

export function sheetsBatchUpdate(st: GwsState, id: string, requests: JsonObj[]): Reply {
  const current = st.sheets.get(id)
  if (current === undefined) return NOT_FOUND
  // Later requests may depend on earlier ones, but no change is published
  // until the entire batch succeeds, including the linked Drive metadata.
  const sheet = structuredClone(current)
  let updatedTitle: string | undefined
  const replies: JsonValue[] = []
  for (const request of requests) {
    if ('addSheet' in request) {
      const props = asObj(asObj(request.addSheet).properties)
      const gridProps = asObj(props.gridProperties)
      const tab = newTab(
        sheet.nextSheetId,
        asStr(props.title) ?? `Sheet${String(sheet.tabs.length + 1)}`,
        asNum(gridProps.rowCount) ?? GRID_ROWS,
        asNum(gridProps.columnCount) ?? GRID_COLUMNS,
      )
      sheet.nextSheetId += 1
      sheet.tabs.push(tab)
      // The live API replies with the whole SheetProperties, not just the
      // id and title.
      replies.push({ addSheet: { properties: tabProperties(tab, sheet.tabs.length - 1) } })
    } else if ('deleteSheet' in request) {
      const sheetId = asNum(asObj(request.deleteSheet).sheetId)
      sheet.tabs = sheet.tabs.filter((t) => t.sheetId !== sheetId)
      replies.push({})
    } else if ('updateSheetProperties' in request) {
      const props = asObj(asObj(request.updateSheetProperties).properties)
      const tab = sheet.tabs.find((t) => t.sheetId === asNum(props.sheetId))
      const title = asStr(props.title)
      if (tab !== undefined && title !== undefined) tab.title = title
      replies.push({})
    } else if ('duplicateSheet' in request) {
      const r = asObj(request.duplicateSheet)
      const src = sheet.tabs.find((t) => t.sheetId === (asNum(r.sourceSheetId) ?? 0))
      if (src === undefined) {
        return googleError(400, 'Invalid sourceSheetId.', 'INVALID_ARGUMENT')
      }
      const newSheetId = asNum(r.newSheetId)
      const copy: SheetTab = {
        ...src,
        sheetId: newSheetId ?? sheet.nextSheetId,
        title: asStr(r.newSheetName) ?? `Copy of ${src.title}`,
        cells: new Map(src.cells),
        rowPixels: { ...src.rowPixels },
        columnPixels: { ...src.columnPixels },
      }
      if (newSheetId === undefined) sheet.nextSheetId += 1
      const at = asNum(r.insertSheetIndex) ?? sheet.tabs.length
      sheet.tabs.splice(at, 0, copy)
      replies.push({ duplicateSheet: { properties: tabProperties(copy, at) } })
    } else if ('insertDimension' in request) {
      const range = resolveDimensionRange(sheet, asObj(asObj(request.insertDimension).range))
      if (range === null) return googleError(400, BAD_SHEET_ID, 'INVALID_ARGUMENT')
      insertDimension(range)
      replies.push({})
    } else if ('deleteDimension' in request) {
      const range = resolveDimensionRange(sheet, asObj(asObj(request.deleteDimension).range))
      if (range === null) return googleError(400, BAD_SHEET_ID, 'INVALID_ARGUMENT')
      deleteDimension(range)
      replies.push({})
    } else if ('appendDimension' in request) {
      const r = asObj(request.appendDimension)
      const tab = sheet.tabs.find((t) => t.sheetId === (asNum(r.sheetId) ?? 0))
      if (tab === undefined) return googleError(400, BAD_SHEET_ID, 'INVALID_ARGUMENT')
      growGrid(tab, asStr(r.dimension) === 'COLUMNS' ? 'COLUMNS' : 'ROWS', asNum(r.length) ?? 0)
      replies.push({})
    } else if ('moveDimension' in request) {
      const r = asObj(request.moveDimension)
      const range = resolveDimensionRange(sheet, asObj(r.source))
      if (range === null) return googleError(400, BAD_SHEET_ID, 'INVALID_ARGUMENT')
      moveDimension(range, asNum(r.destinationIndex) ?? 0)
      replies.push({})
    } else if ('autoResizeDimensions' in request) {
      const failed = autoResizeDimensions(sheet, asObj(request.autoResizeDimensions))
      if (failed !== null) return failed
      replies.push({})
    } else if ('updateCells' in request) {
      const failed = updateCells(sheet, asObj(request.updateCells))
      if (failed !== null) return failed
      replies.push({})
    } else if ('updateSpreadsheetProperties' in request) {
      const title = asStr(asObj(asObj(request.updateSpreadsheetProperties).properties).title)
      if (title !== undefined) {
        sheet.title = title
        updatedTitle = title
      }
      replies.push({})
    } else {
      return googleError(
        400,
        `Unsupported request: ${Object.keys(request).join(',')}`,
        'INVALID_ARGUMENT',
      )
    }
  }
  st.sheets.set(id, sheet)
  const file = st.files.get(id)
  if (file !== undefined && updatedTitle !== undefined) file.name = updatedTitle
  touchNative(st, id)
  return ok({ spreadsheetId: id, replies })
}

// sheets.copyTo copies one tab into another spreadsheet (or back into the
// same one) and returns the new tab's SheetProperties, not a batch reply.
export function copySheetTo(
  st: GwsState,
  sourceId: string,
  sheetId: number,
  destinationId: string,
): Reply {
  const source = st.sheets.get(sourceId)
  const destination = st.sheets.get(destinationId)
  if (source === undefined || destination === undefined) return NOT_FOUND
  const tab = source.tabs.find((t) => t.sheetId === sheetId)
  if (tab === undefined) {
    return googleError(400, `Invalid sheetId: ${String(sheetId)}`, 'INVALID_ARGUMENT')
  }
  const copy: SheetTab = {
    ...tab,
    sheetId: destination.nextSheetId,
    title: `Copy of ${tab.title}`,
    cells: new Map(tab.cells),
    rowPixels: { ...tab.rowPixels },
    columnPixels: { ...tab.columnPixels },
  }
  destination.nextSheetId += 1
  destination.tabs.push(copy)
  touchNative(st, destinationId)
  return ok(tabProperties(copy, destination.tabs.length - 1))
}

export function batchRequests(body: JsonObj): JsonObj[] {
  return asObjArr(body.requests)
}
