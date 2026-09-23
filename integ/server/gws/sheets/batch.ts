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
import type { SheetTab, Spreadsheet } from '../store/types.ts'
import { asNum, asObj, asObjArr, asStr } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { NOT_FOUND, googleError, isReply, ok } from '../wire/reply.ts'
import { addBanding, bandFloor } from './banding.ts'
import { addConditionalFormatRule, deleteConditionalFormatRule } from './conditional.ts'
import {
  autoResizeDimensions,
  deleteDimension,
  growGrid,
  insertDimension,
  moveDimension,
  resolveDimensionRange,
  updateCells,
  updateDimensionProperties,
} from './dimension.ts'
import type { DimensionRange } from './dimension.ts'
import { clearBasicFilter, setBasicFilter, sortRange } from './filter.ts'
import { repeatCell, updateBorders } from './format.ts'
import { GRID_COLUMNS, GRID_ROWS, copyTab, newTab, tabProperties } from './grid.ts'
import { gridOf, invalid } from './request.ts'
import type { At } from './request.ts'

type Handler = (sheet: Spreadsheet, body: JsonObj, at: At) => JsonObj | Reply

function addSheet(sheet: Spreadsheet, body: JsonObj): JsonObj {
  const props = asObj(body.properties)
  const gridProps = asObj(props.gridProperties)
  const tab = newTab(
    sheet.nextSheetId,
    asStr(props.title) ?? `Sheet${String(sheet.tabs.length + 1)}`,
    asNum(gridProps.rowCount) ?? GRID_ROWS,
    asNum(gridProps.columnCount) ?? GRID_COLUMNS,
  )
  sheet.nextSheetId += 1
  sheet.tabs.push(tab)
  // The live API replies with the whole SheetProperties, not just the id
  // and title.
  return { addSheet: { properties: tabProperties(tab, sheet.tabs.length - 1) } }
}

// The sheet requests name a missing tab as a sheet, where every request on
// a tab's cells names it as a grid.
function sheetOf(sheet: Spreadsheet, sheetId: number, at: At): SheetTab | Reply {
  const tab = sheet.tabs.find((t) => t.sheetId === sheetId)
  return tab ?? invalid(at, `No sheet with id: ${String(sheetId)}`)
}

function deleteSheet(sheet: Spreadsheet, body: JsonObj, at: At): JsonObj | Reply {
  const tab = sheetOf(sheet, asNum(body.sheetId) ?? 0, at)
  if (isReply(tab)) return tab
  sheet.tabs = sheet.tabs.filter((t) => t !== tab)
  return {}
}

function updateSheetProperties(sheet: Spreadsheet, body: JsonObj): JsonObj {
  const props = asObj(body.properties)
  const tab = sheet.tabs.find((t) => t.sheetId === asNum(props.sheetId))
  const title = asStr(props.title)
  if (tab !== undefined && title !== undefined) tab.title = title
  return {}
}

// The copy carries everything the tab holds and lands at index 0 when the
// request names no index, which is where the live API puts it.
function duplicateSheet(sheet: Spreadsheet, body: JsonObj, at: At): JsonObj | Reply {
  const src = sheetOf(sheet, asNum(body.sourceSheetId) ?? 0, at)
  if (isReply(src)) return src
  const newSheetId = asNum(body.newSheetId)
  const copy = copyTab(
    src,
    newSheetId ?? sheet.nextSheetId,
    asStr(body.newSheetName) ?? `Copy of ${src.title}`,
    bandFloor(sheet),
  )
  if (newSheetId === undefined) sheet.nextSheetId += 1
  sheet.tabs.splice(asNum(body.insertSheetIndex) ?? 0, 0, copy)
  return { duplicateSheet: { properties: tabProperties(copy, sheet.tabs.indexOf(copy)) } }
}

function dimensionRequest(apply: (range: DimensionRange) => void): Handler {
  return (sheet, body, at) => {
    const range = resolveDimensionRange(sheet, asObj(body.range), at)
    if (isReply(range)) return range
    apply(range)
    return {}
  }
}

function appendDimension(sheet: Spreadsheet, body: JsonObj, at: At): JsonObj | Reply {
  const tab = gridOf(sheet, asNum(body.sheetId) ?? 0, at)
  if (isReply(tab)) return tab
  growGrid(tab, asStr(body.dimension) === 'COLUMNS' ? 'COLUMNS' : 'ROWS', asNum(body.length) ?? 0)
  return {}
}

function moveDimensionRequest(sheet: Spreadsheet, body: JsonObj, at: At): JsonObj | Reply {
  const range = resolveDimensionRange(sheet, asObj(body.source), at)
  if (isReply(range)) return range
  moveDimension(range, asNum(body.destinationIndex) ?? 0)
  return {}
}

function updateSpreadsheetProperties(sheet: Spreadsheet, body: JsonObj): JsonObj {
  const title = asStr(asObj(body.properties).title)
  if (title !== undefined) sheet.title = title
  return {}
}

const HANDLERS: Record<string, Handler> = {
  addSheet,
  deleteSheet,
  updateSheetProperties,
  duplicateSheet,
  insertDimension: dimensionRequest(insertDimension),
  deleteDimension: dimensionRequest(deleteDimension),
  appendDimension,
  moveDimension: moveDimensionRequest,
  autoResizeDimensions,
  updateCells,
  updateSpreadsheetProperties,
  repeatCell,
  updateBorders,
  updateDimensionProperties,
  addBanding,
  setBasicFilter,
  clearBasicFilter,
  sortRange,
  addConditionalFormatRule,
  deleteConditionalFormatRule,
}

// The rest of the Request union the live API documents. The fake refuses
// these in words of its own rather than accept them and change nothing;
// a name outside the union gets the live API's own refusal.
const UNMODELED = new Set([
  'updateNamedRange',
  'addNamedRange',
  'deleteNamedRange',
  'autoFill',
  'cutPaste',
  'copyPaste',
  'mergeCells',
  'unmergeCells',
  'addFilterView',
  'appendCells',
  'deleteEmbeddedObject',
  'deleteFilterView',
  'duplicateFilterView',
  'findReplace',
  'insertRange',
  'updateEmbeddedObjectPosition',
  'pasteData',
  'textToColumns',
  'updateFilterView',
  'deleteRange',
  'updateConditionalFormatRule',
  'setDataValidation',
  'addProtectedRange',
  'updateProtectedRange',
  'deleteProtectedRange',
  'addChart',
  'updateChartSpec',
  'updateBanding',
  'deleteBanding',
  'createDeveloperMetadata',
  'updateDeveloperMetadata',
  'deleteDeveloperMetadata',
  'randomizeRange',
  'addDimensionGroup',
  'deleteDimensionGroup',
  'updateDimensionGroup',
  'trimWhitespace',
  'deleteDuplicates',
  'updateEmbeddedObjectBorder',
  'addSlicer',
  'updateSlicerSpec',
  'addDataSource',
  'updateDataSource',
  'deleteDataSource',
  'refreshDataSource',
  'cancelDataSourceRefresh',
  'addTable',
  'updateTable',
  'deleteTable',
])

export function sheetsBatchUpdate(st: GwsState, id: string, requests: JsonObj[]): Reply {
  const current = st.sheets.get(id)
  if (current === undefined) return NOT_FOUND
  // Later requests may depend on earlier ones, but no change is published
  // until the entire batch succeeds, including the linked Drive metadata.
  const sheet = structuredClone(current)
  const replies: JsonValue[] = []
  for (const [index, request] of requests.entries()) {
    const kind = Object.keys(request)[0]
    if (kind === undefined) {
      return googleError(
        400,
        `Invalid requests[${String(index)}]: No request set.`,
        'INVALID_ARGUMENT',
      )
    }
    const handler = Object.hasOwn(HANDLERS, kind) ? HANDLERS[kind] : undefined
    if (handler === undefined) return unsupported(kind, index)
    const reply = handler(sheet, asObj(request[kind]), { index, kind })
    if (isReply(reply)) return reply
    replies.push(reply)
  }
  st.sheets.set(id, sheet)
  const file = st.files.get(id)
  if (file !== undefined && sheet.title !== current.title) file.name = sheet.title
  touchNative(st, id)
  return ok({ spreadsheetId: id, replies })
}

function unsupported(kind: string, index: number): Reply {
  if (UNMODELED.has(kind)) {
    return googleError(400, `Unsupported request: ${kind}`, 'INVALID_ARGUMENT')
  }
  const field = `requests[${String(index)}]`
  const message = `Invalid JSON payload received. Unknown name "${kind}" at '${field}': Cannot find field.`
  const violation = { field, description: message }
  const details = [
    { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [violation] },
  ]
  return {
    status: 400,
    body: { error: { code: 400, message, status: 'INVALID_ARGUMENT', details } },
  }
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
  const copy = copyTab(tab, destination.nextSheetId, `Copy of ${tab.title}`, bandFloor(destination))
  destination.nextSheetId += 1
  destination.tabs.push(copy)
  touchNative(st, destinationId)
  return ok(tabProperties(copy, destination.tabs.length - 1))
}

export function batchRequests(body: JsonObj): JsonObj[] {
  return asObjArr(body.requests)
}
