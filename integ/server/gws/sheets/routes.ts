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

import { route } from '../wire/route.ts'
import type { RouteOpts } from '../wire/route.ts'
import type { KitRoute, Reply } from '../../kit/typescript/index.ts'
import { createDriveItem, touchNative } from '../drive/item.ts'
import type { C } from '../store/client.ts'
import type { GwsState } from '../store/state.ts'
import { asGrid, asObj, asObjArr, asStrArr } from '../wire/json.ts'
import { SHEET_MIME } from '../wire/mime.ts'
import { NOT_FOUND, idVerbOf, ok, unknownRoute, verbOf } from '../wire/reply.ts'
import type { Ctx } from '../../kit/typescript/index.ts'
import { colIndexToLetter, parseA1, rangeLabel, rangeLabelFor } from './a1.ts'
import { copySheetTo, sheetsBatchUpdate } from './batch.ts'
import { clearRange, fmtSpreadsheet, rangeValues, tabExtent, writeValues } from './grid.ts'
import { batchClearValues, batchGetValues, batchUpdateValues, unparseable } from './values.ts'

type GwsCtx = Ctx<GwsState>

// The old fake spelled a spreadsheet id `[^/:]+` and the values range `(.+)`:
// the range is the rest of the path, and it holds colons of its own.
const ID: RouteOpts = { classes: { id: 'id' } }
const ID_WRITE: RouteOpts = { classes: { id: 'id' }, write: true }
const RANGE: RouteOpts = { classes: { range: 'rest' } }
const RANGE_WRITE: RouteOpts = { classes: { range: 'rest' }, write: true }

// The values *batch* methods hang off `values:` with no range segment, so
// they are one route on the segment after the spreadsheet id, told apart by
// the verb the segment ends with; the `values/<range>` routes below need the
// slash and so can never reach them.
function valuesBatchGet(ctx: GwsCtx): Reply {
  const id = verbOf(ctx.params.op ?? '', 'batchGet')
  if (id !== 'values') return unknownRoute('GET', ctx.url.pathname)
  return batchGetValues(ctx.db, ctx.params.id ?? '', ctx.query.getAll('ranges'))
}

function valuesBatchWrite(ctx: GwsCtx): Reply {
  const op = ctx.params.op ?? ''
  const body = asObj(ctx.json())
  if (verbOf(op, 'batchUpdate') === 'values') {
    return batchUpdateValues(ctx.db, ctx.params.id ?? '', asObjArr(body.data))
  }
  if (verbOf(op, 'batchClear') === 'values') {
    return batchClearValues(ctx.db, ctx.params.id ?? '', asStrArr(body.ranges) ?? [])
  }
  return unknownRoute('POST', ctx.url.pathname)
}

function copyTo(ctx: GwsCtx): Reply {
  const sheetId = verbOf(ctx.params.sheet ?? '', 'copyTo')
  if (sheetId === null || !/^\d+$/.test(sheetId)) return unknownRoute('POST', ctx.url.pathname)
  const id = ctx.params.id ?? ''
  const destination = asObj(ctx.json()).destinationSpreadsheetId
  return copySheetTo(ctx.db, id, Number.parseInt(sheetId, 10), String(destination ?? id))
}

// A1 ranges legitimately contain ':' (Sheet1!A1:C1), so the :append and
// :clear suffixes are stripped explicitly instead of pattern-matched.
function splitValuesRange(raw: string): { range: string; append: boolean; clear: boolean } {
  const appended = verbOf(raw, 'append')
  if (appended !== null) return { range: appended, append: true, clear: false }
  const cleared = verbOf(raw, 'clear')
  if (cleared !== null) return { range: cleared, append: false, clear: true }
  return { range: raw, append: false, clear: false }
}

function readValues(ctx: GwsCtx): Reply {
  const sheet = ctx.db.sheets.get(ctx.params.id ?? '')
  if (sheet === undefined) return NOT_FOUND
  const rangeStr = splitValuesRange(ctx.params.range ?? '').range
  const range = parseA1(sheet, rangeStr)
  if (range === null) return unparseable(rangeStr)
  return ok({
    range: rangeLabelFor(range, rangeStr),
    majorDimension: 'ROWS',
    values: rangeValues(range),
  })
}

function writeRange(ctx: GwsCtx): Reply {
  const id = ctx.params.id ?? ''
  const sheet = ctx.db.sheets.get(id)
  if (sheet === undefined) return NOT_FOUND
  const parts = splitValuesRange(ctx.params.range ?? '')
  const range = parseA1(sheet, parts.range)
  if (range === null) return unparseable(parts.range)
  if (parts.clear) {
    clearRange(range)
    touchNative(ctx.db, id)
    return ok({ spreadsheetId: id, clearedRange: rangeLabelFor(range, parts.range) })
  }
  if (!parts.append) return unknownRoute('POST', ctx.url.pathname)
  const values = asGrid(asObj(ctx.json()).values)
  const extent = tabExtent(range.tab)
  const startRow = Math.max(extent.rows, range.startRow)
  const cells = writeValues(range, values, startRow)
  touchNative(ctx.db, id)
  return ok({
    spreadsheetId: id,
    // The table the append found, which the live API reports only when there
    // was one; an empty tab has no tableRange at all.
    ...(extent.rows > 0
      ? {
          tableRange:
            `${range.tab.title}!A1:` + `${colIndexToLetter(extent.cols - 1)}${String(extent.rows)}`,
        }
      : {}),
    updates: {
      spreadsheetId: id,
      updatedRange: rangeLabel(range.tab, startRow, range.startCol, values),
      updatedRows: values.length,
      updatedColumns: values.length > 0 ? Math.max(...values.map((r) => r.length)) : 0,
      updatedCells: cells,
    },
  })
}

function putValues(ctx: GwsCtx): Reply {
  const id = ctx.params.id ?? ''
  const sheet = ctx.db.sheets.get(id)
  if (sheet === undefined) return NOT_FOUND
  const rangeStr = splitValuesRange(ctx.params.range ?? '').range
  const range = parseA1(sheet, rangeStr)
  if (range === null) return unparseable(rangeStr)
  const values = asGrid(asObj(ctx.json()).values)
  const cells = writeValues(range, values, range.startRow)
  touchNative(ctx.db, id)
  return ok({
    spreadsheetId: id,
    updatedRange: rangeLabel(range.tab, range.startRow, range.startCol, values),
    updatedRows: values.length,
    updatedColumns: values.length > 0 ? Math.max(...values.map((r) => r.length)) : 0,
    updatedCells: cells,
  })
}

export function sheetsRoutes(): KitRoute<C>[] {
  return [
    route(
      'POST',
      '/v4/spreadsheets',
      (ctx) => {
        const properties = asObj(asObj(ctx.json()).properties)
        const title = String(properties.title ?? 'Untitled spreadsheet')
        const item = createDriveItem(
          ctx.db,
          title,
          SHEET_MIME,
          [],
          Buffer.alloc(0),
          ctx.db.nextId('sheet'),
        )
        const sheet = ctx.db.sheets.get(item.id)
        if (sheet === undefined) return NOT_FOUND
        return ok(fmtSpreadsheet(sheet, item.id))
      },
      { write: true },
    ),
    route('GET', '/v4/spreadsheets/:id/values/:range', readValues, RANGE),
    route('POST', '/v4/spreadsheets/:id/values/:range', writeRange, RANGE_WRITE),
    route('PUT', '/v4/spreadsheets/:id/values/:range', putValues, RANGE_WRITE),
    route('GET', '/v4/spreadsheets/:id/:op', valuesBatchGet, ID),
    route('POST', '/v4/spreadsheets/:id/:op', valuesBatchWrite, ID_WRITE),
    route('POST', '/v4/spreadsheets/:id/sheets/:sheet', copyTo, ID_WRITE),
    route(
      'GET',
      '/v4/spreadsheets/:id',
      (ctx) => {
        const id = ctx.params.id ?? ''
        const sheet = ctx.db.sheets.get(id)
        if (sheet === undefined) return NOT_FOUND
        return ok(fmtSpreadsheet(sheet, id, ctx.query.get('includeGridData') === 'true'))
      },
      ID,
    ),
    route(
      'POST',
      '/v4/spreadsheets/:target',
      (ctx) => {
        const id = idVerbOf(ctx.params.target ?? '', 'batchUpdate')
        if (id === null) return unknownRoute('POST', ctx.url.pathname)
        return sheetsBatchUpdate(ctx.db, id, asObjArr(asObj(ctx.json()).requests))
      },
      { write: true },
    ),
  ]
}
