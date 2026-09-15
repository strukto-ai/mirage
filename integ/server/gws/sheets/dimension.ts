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

import type { Reply } from '../../kit/typescript/index.ts'
import type { SheetTab, Spreadsheet } from '../store/types.ts'
import { asArr, asNum, asObj, asStr } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { googleError } from '../wire/reply.ts'
import { ROW_PIXELS, COLUMN_PIXELS, tabGrid } from './grid.ts'

export type Dimension = 'ROWS' | 'COLUMNS'

export interface DimensionRange {
  tab: SheetTab
  dimension: Dimension
  startIndex: number
  endIndex: number
}

// A DimensionRange with no endIndex is unbounded to the end of the grid,
// and no startIndex means index 0, matching the real API's optional fields.
export function resolveDimensionRange(sheet: Spreadsheet, raw: JsonObj): DimensionRange | null {
  const tab = sheet.tabs.find((t) => t.sheetId === (asNum(raw.sheetId) ?? 0))
  if (tab === undefined) return null
  const dimension: Dimension = asStr(raw.dimension) === 'COLUMNS' ? 'COLUMNS' : 'ROWS'
  const limit = dimension === 'ROWS' ? tab.rows : tab.cols
  const startIndex = Math.max(0, asNum(raw.startIndex) ?? 0)
  const endIndex = Math.max(startIndex, asNum(raw.endIndex) ?? limit)
  return { tab, dimension, startIndex, endIndex }
}

// Re-key the sparse cell map along one dimension. `mapIndex` returns the
// index a row/column moves to, or null to drop it; every dimension request
// is expressed as one such mapping so insert, delete and move cannot drift
// apart.
export function remapCells(
  tab: SheetTab,
  dimension: Dimension,
  mapIndex: (index: number) => number | null,
): void {
  const next = new Map<string, string>()
  for (const [key, value] of tab.cells) {
    const [row, col] = key.split(',').map(Number) as [number, number]
    const moved = mapIndex(dimension === 'ROWS' ? row : col)
    if (moved === null) continue
    next.set(
      dimension === 'ROWS' ? `${String(moved)},${String(col)}` : `${String(row)},${String(moved)}`,
      value,
    )
  }
  tab.cells = next
  const sizes = dimension === 'ROWS' ? tab.rowPixels : tab.columnPixels
  if (sizes !== undefined) {
    const movedSizes: Record<string, number> = {}
    for (const [key, value] of Object.entries(sizes)) {
      const moved = mapIndex(Number(key))
      if (moved !== null) movedSizes[moved] = value
    }
    if (dimension === 'ROWS') tab.rowPixels = movedSizes
    else tab.columnPixels = movedSizes
  }
}

// One cell of an UpdateCellsRequest, rendered the way values.update would
// have stored it. Only userEnteredValue is kept: the fake stores strings,
// so formatting has nowhere to go.
export function cellText(cell: JsonObj): string | null {
  const value = cell.userEnteredValue
  if (value === undefined) return null
  const v = asObj(value)
  if (typeof v.stringValue === 'string') return v.stringValue
  if (typeof v.numberValue === 'number') return String(v.numberValue)
  if (typeof v.boolValue === 'boolean') return v.boolValue ? 'TRUE' : 'FALSE'
  if (typeof v.formulaValue === 'string') return v.formulaValue
  return null
}

// The field mask scopes an updateCells request on both sides: the real API
// writes and clears only the fields it names, so a request masking a format
// (`userEnteredFormat.numberFormat`) must leave cell contents alone rather
// than blanking the range. A mask entry may be dotted or use the parenthesised
// sub-selector form, so only its head segment decides. An absent mask is read
// as "*", the way every other request here ignores `fields`, even though the
// real API rejects it.
export function fieldsTouchValue(fields: string | undefined): boolean {
  if (fields === undefined || fields.trim() === '') return true
  return fields.split(',').some((entry) => {
    const head = entry.trim().split(/[.(]/)[0]
    return head === '*' || head === 'userEnteredValue'
  })
}

// updateCells writes a rectangle by grid index rather than by A1 range, and
// clears whatever the supplied rows do not cover -- which is how a caller
// shortens a sheet it previously wrote longer.
export function updateCells(sheet: Spreadsheet, request: JsonObj): Reply | null {
  const hasRange = request.range !== undefined
  const range = asObj(request.range)
  const start = asObj(request.start)
  const grid = hasRange ? range : start
  const tab = sheet.tabs.find((t) => t.sheetId === (asNum(grid.sheetId) ?? 0))
  if (tab === undefined) return googleError(400, 'Invalid sheetId.', 'INVALID_ARGUMENT')
  if (!fieldsTouchValue(asStr(request.fields))) return null
  const rows = asArr(request.rows)
  const startRow = asNum(range.startRowIndex) ?? asNum(start.rowIndex) ?? 0
  const startCol = asNum(range.startColumnIndex) ?? asNum(start.columnIndex) ?? 0
  if (hasRange) {
    const endRow = Math.min(asNum(range.endRowIndex) ?? tab.rows, tab.rows)
    const endCol = Math.min(asNum(range.endColumnIndex) ?? tab.cols, tab.cols)
    for (let r = startRow; r < endRow; r += 1) {
      for (let c = startCol; c < endCol; c += 1) tab.cells.delete(`${String(r)},${String(c)}`)
    }
  }
  for (let i = 0; i < rows.length; i += 1) {
    const values = asArr(asObj(rows[i]).values)
    for (let j = 0; j < values.length; j += 1) {
      const text = cellText(asObj(values[j]))
      const key = `${String(startRow + i)},${String(startCol + j)}`
      if (text === null) tab.cells.delete(key)
      else tab.cells.set(key, text)
    }
  }
  return null
}

export function growGrid(tab: SheetTab, dimension: Dimension, by: number): void {
  if (dimension === 'ROWS') tab.rows = Math.max(1, tab.rows + by)
  else tab.cols = Math.max(1, tab.cols + by)
}

export function insertDimension(range: DimensionRange): void {
  const count = range.endIndex - range.startIndex
  remapCells(range.tab, range.dimension, (i) => (i >= range.startIndex ? i + count : i))
  growGrid(range.tab, range.dimension, count)
}

export function deleteDimension(range: DimensionRange): void {
  const count = range.endIndex - range.startIndex
  remapCells(range.tab, range.dimension, (i) => {
    if (i >= range.startIndex && i < range.endIndex) return null
    return i >= range.endIndex ? i - count : i
  })
  growGrid(range.tab, range.dimension, -count)
}

// destinationIndex is in the coordinate space *before* the source band is
// lifted out, which is the one detail of moveDimension worth getting right:
// a destination past the band lands `count` lower once the band is gone.
export function moveDimension(range: DimensionRange, destinationIndex: number): void {
  const count = range.endIndex - range.startIndex
  if (count === 0) return
  if (destinationIndex >= range.startIndex && destinationIndex <= range.endIndex) return
  const target =
    destinationIndex > range.endIndex ? destinationIndex - count : Math.max(0, destinationIndex)
  remapCells(range.tab, range.dimension, (i) => {
    if (i >= range.startIndex && i < range.endIndex) return target + (i - range.startIndex)
    const lifted = i >= range.endIndex ? i - count : i
    return lifted >= target ? lifted + count : lifted
  })
}

// The fake has no font renderer. Use deterministic text metrics; acceptance,
// range scoping and persisted metadata follow Sheets, exact font widths do not.
const TEXT_PIXEL_WIDTH = 7
const CELL_PADDING = 6

export function autoResizeDimensions(sheet: Spreadsheet, request: JsonObj): Reply | null {
  const raw = asObj(request.dimensions)
  const tab = sheet.tabs.find((t) => t.sheetId === (asNum(raw.sheetId) ?? 0))
  if (tab === undefined) return googleError(400, 'Invalid sheetId.', 'INVALID_ARGUMENT')
  const dimension = asStr(raw.dimension)
  if (dimension !== 'ROWS' && dimension !== 'COLUMNS') {
    return googleError(400, 'Invalid dimension.', 'INVALID_ARGUMENT')
  }
  const grid = tabGrid(tab)
  const limit = dimension === 'ROWS' ? grid.rows : grid.cols
  const start = asNum(raw.startIndex) ?? 0
  const end = asNum(raw.endIndex) ?? limit
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > limit
  ) {
    return googleError(400, 'Invalid dimension range.', 'INVALID_ARGUMENT')
  }
  const measured = new Map<number, number>()
  for (const [key, value] of tab.cells) {
    const [row = 0, col = 0] = key.split(',').map(Number)
    const index = dimension === 'ROWS' ? row : col
    if (index < start || index >= end || value === '') continue
    const lines = value.split('\n')
    const pixels =
      dimension === 'ROWS'
        ? lines.length * ROW_PIXELS
        : Math.max(...lines.map((line) => [...line].length)) * TEXT_PIXEL_WIDTH + CELL_PADDING
    measured.set(index, Math.max(measured.get(index) ?? 0, pixels))
  }
  const sizes = dimension === 'ROWS' ? (tab.rowPixels ??= {}) : (tab.columnPixels ??= {})
  for (let i = start; i < end; i += 1) {
    sizes[i] = measured.get(i) ?? (dimension === 'ROWS' ? ROW_PIXELS : COLUMN_PIXELS)
  }
  return null
}
