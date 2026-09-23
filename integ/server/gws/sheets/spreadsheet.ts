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

import type { JsonValue } from '../../kit/typescript/index.ts'
import type { SheetTab, Spreadsheet } from '../store/types.ts'
import { asObj, asObjArr, isObj } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import type { A1Range } from './a1.ts'
import { renderBanded } from './banding.ts'
import { renderRule } from './conditional.ts'
import { CELL_DATA, DIMENSION_PROPERTIES, ordered } from './fields.ts'
import { filterHidden, renderFilter } from './filter.ts'
import { DEFAULT_FORMAT, SPREADSHEET_THEME, effectiveFormat } from './format.ts'
import { COLUMN_PIXELS, ROW_PIXELS, cellData, tabGrid, tabProperties, wholeTab } from './grid.ts'
import type { Grid } from './grid.ts'
import { boundsOf, covers, overlaps } from './request.ts'
import type { Bounds } from './request.ts'

// One cell as `includeGridData` reports it: the value, what else a caller
// wrote to it, and the format it ends up with.
function cellAt(tab: SheetTab, grid: Grid, row: number, col: number): JsonObj {
  const key = `${String(row)},${String(col)}`
  const text = tab.cells.get(key)
  const props = tab.props.get(key)
  const numberFormat = asObj(props?.userEnteredFormat).numberFormat
  const out: JsonObj = {
    ...(text === undefined ? {} : cellData(text, isObj(numberFormat) ? numberFormat : undefined)),
    ...props,
  }
  const effective = effectiveFormat(tab, grid, row, col)
  if (effective !== undefined) out.effectiveFormat = effective
  return ordered(out, CELL_DATA)
}

function dimensionAt(meta: JsonObj | undefined, pixels: number, byFilter: boolean): JsonObj {
  const out: JsonObj = { ...meta, pixelSize: meta?.pixelSize ?? pixels }
  if (byFilter) out.hiddenByFilter = true
  return ordered(out, DIMENSION_PROPERTIES)
}

// One GridData for one range, in the shape `includeGridData=true` returns:
// row entries up to the last row inside the range with a cell to report,
// cell entries up to the last such column of that row, `{}` for a row with
// nothing in it, and metadata for every row and column the range covers,
// clipped to the grid. A cell is reported when it holds a value or a format
// of its own, or when a band or a conditional rule reaches it, empty or not.
// `startRow`/`startColumn` are absent at zero because the live API omits
// them there, and present for a range that starts further in; `rowData` is
// absent when no row has anything to report.
export function gridData(range: A1Range): JsonObj {
  const tab = range.tab
  const grid = tabGrid(tab)
  const asked = askedBounds(range, grid)
  const b = {
    ...asked,
    bottom: Math.min(asked.bottom, grid.rows),
    right: Math.min(asked.right, grid.cols),
  }
  const cells = new Map<string, JsonObj>()
  const consider = (row: number, col: number): void => {
    const key = `${String(row)},${String(col)}`
    if (cells.has(key) || !covers(b, row, col)) return
    const cell = cellAt(tab, grid, row, col)
    if (Object.keys(cell).length > 0) cells.set(key, cell)
  }
  for (const key of [...tab.cells.keys(), ...tab.props.keys()]) {
    const [row = 0, col = 0] = key.split(',').map(Number)
    consider(row, col)
  }
  const reaches = [
    ...tab.bandedRanges.map((banded) => asObj(banded.range)),
    ...tab.conditionalFormats.flatMap((rule) => asObjArr(rule.ranges)),
  ]
  for (const reach of reaches) {
    const r = boundsOf(reach, grid)
    for (let row = Math.max(r.top, b.top); row < Math.min(r.bottom, b.bottom); row += 1) {
      for (let col = Math.max(r.left, b.left); col < Math.min(r.right, b.right); col += 1) {
        consider(row, col)
      }
    }
  }
  const lastCol = new Map<number, number>()
  let lastRow = -1
  for (const key of cells.keys()) {
    const [row = 0, col = 0] = key.split(',').map(Number)
    lastCol.set(row, Math.max(lastCol.get(row) ?? -1, col))
    lastRow = Math.max(lastRow, row)
  }
  const rowData: JsonValue[] = []
  for (let row = b.top; row <= lastRow; row += 1) {
    const end = lastCol.get(row)
    if (end === undefined) {
      rowData.push({})
      continue
    }
    const values: JsonValue[] = []
    for (let col = b.left; col <= end; col += 1) {
      values.push(cells.get(`${String(row)},${String(col)}`) ?? {})
    }
    rowData.push({ values })
  }
  const hidden = filterHidden(tab)
  const span = (start: number, stop: number): number => Math.max(stop - start, 0)
  return {
    ...(b.top > 0 ? { startRow: b.top } : {}),
    ...(b.left > 0 ? { startColumn: b.left } : {}),
    ...(rowData.length > 0 ? { rowData } : {}),
    rowMetadata: Array.from({ length: span(b.top, b.bottom) }, (_, i) => {
      const row = b.top + i
      return dimensionAt(tab.rowMeta[String(row)], ROW_PIXELS, hidden.has(row))
    }),
    columnMetadata: Array.from({ length: span(b.left, b.right) }, (_, i) =>
      dimensionAt(tab.columnMeta[String(b.left + i)], COLUMN_PIXELS, false),
    ),
  }
}

// The rows and columns an A1 range asks for, as GridRange bounds.
function askedBounds(range: A1Range, grid: Grid): Bounds {
  return {
    top: range.startRow,
    bottom: range.endRow === null ? grid.rows : range.endRow + 1,
    left: range.startCol,
    right: range.endCol === null ? grid.cols : range.endCol + 1,
  }
}

// `ranges` narrows the reply the way the live API does: only the tabs a
// range names come back, each carries one GridData per range asked of it,
// in request order, and only the conditional rules, filter and banding that
// meet a range asked of it. With no ranges every tab comes back whole.
export function fmtSpreadsheet(
  sheet: Spreadsheet,
  id: string,
  includeGridData = false,
  ranges: readonly A1Range[] = [],
): JsonObj {
  const tabs =
    ranges.length === 0 ? sheet.tabs : sheet.tabs.filter((t) => ranges.some((r) => r.tab === t))
  const dataOf = (tab: SheetTab): JsonObj[] =>
    ranges.length === 0
      ? [gridData(wholeTab(tab))]
      : ranges.filter((r) => r.tab === tab).map(gridData)
  const sheetOf = (tab: SheetTab): JsonObj => {
    const grid = tabGrid(tab)
    const asked = ranges.filter((r) => r.tab === tab).map((r) => askedBounds(r, grid))
    const meets = (range: JsonValue | undefined): boolean =>
      ranges.length === 0 || asked.some((b) => overlaps(boundsOf(asObj(range), grid), b))
    const rules = tab.conditionalFormats.filter((rule) => asObjArr(rule.ranges).some(meets))
    const filter = tab.basicFilter !== null && meets(tab.basicFilter.range) ? tab.basicFilter : null
    const banded = tab.bandedRanges.filter((b) => meets(b.range))
    return {
      properties: tabProperties(tab, sheet.tabs.indexOf(tab)),
      // Real Sheets omits `data` entirely without includeGridData, which
      // is the whole reason mirage asks for it.
      ...(includeGridData ? { data: dataOf(tab) } : {}),
      ...(rules.length > 0
        ? { conditionalFormats: rules.map((r) => renderRule(r, tab.sheetId)) }
        : {}),
      ...(filter === null ? {} : { basicFilter: renderFilter(filter, tab.sheetId) }),
      ...(banded.length > 0
        ? { bandedRanges: banded.map((b) => renderBanded(b, tab.sheetId)) }
        : {}),
    }
  }
  return {
    spreadsheetId: id,
    properties: {
      title: sheet.title,
      locale: 'en_US',
      autoRecalc: 'ON_CHANGE',
      timeZone: 'Etc/GMT',
      defaultFormat: DEFAULT_FORMAT,
      spreadsheetTheme: SPREADSHEET_THEME,
    },
    sheets: tabs.map(sheetOf),
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
  }
}
