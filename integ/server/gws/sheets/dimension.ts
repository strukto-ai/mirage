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
import { googleError, isReply } from '../wire/reply.ts'
import { CELL_DATA, DIMENSION_PROPERTIES, canonical, ordered } from './fields.ts'
import { writeCell } from './format.ts'
import { ROW_PIXELS, COLUMN_PIXELS, tabGrid } from './grid.ts'
import { applyMask } from './mask.ts'
import { boundsOf, gridOf, invalid, maskOf } from './request.ts'
import type { At } from './request.ts'

export type Dimension = 'ROWS' | 'COLUMNS'

export interface DimensionRange {
  tab: SheetTab
  dimension: Dimension
  startIndex: number
  endIndex: number
}

// A DimensionRange with no endIndex is unbounded to the end of the grid,
// and no startIndex means index 0, matching the real API's optional fields.
export function resolveDimensionRange(
  sheet: Spreadsheet,
  raw: JsonObj,
  at: At,
): DimensionRange | Reply {
  const tab = gridOf(sheet, asNum(raw.sheetId) ?? 0, at)
  if (isReply(tab)) return tab
  const dimension: Dimension = asStr(raw.dimension) === 'COLUMNS' ? 'COLUMNS' : 'ROWS'
  const limit = dimension === 'ROWS' ? tab.rows : tab.cols
  const startIndex = Math.max(0, asNum(raw.startIndex) ?? 0)
  const endIndex = Math.max(startIndex, asNum(raw.endIndex) ?? limit)
  return { tab, dimension, startIndex, endIndex }
}

// Re-key everything a tab holds by row or column along one dimension: cell
// values, the rest of each cell, and the row or column properties.
// `mapIndex` returns the index a row/column moves to, or null to drop it;
// every dimension request is expressed as one such mapping so insert,
// delete and move cannot drift apart. Banded ranges, the basic filter and
// conditional rules keep the ranges they were given: live Sheets moves them
// with the rows, which is not modeled here.
export function remapCells(
  tab: SheetTab,
  dimension: Dimension,
  mapIndex: (index: number) => number | null,
): void {
  const moved = <T>(cells: Map<string, T>): Map<string, T> => {
    const next = new Map<string, T>()
    for (const [key, value] of cells) {
      const [row = 0, col = 0] = key.split(',').map(Number)
      const to = mapIndex(dimension === 'ROWS' ? row : col)
      if (to === null) continue
      next.set(
        dimension === 'ROWS' ? `${String(to)},${String(col)}` : `${String(row)},${String(to)}`,
        value,
      )
    }
    return next
  }
  tab.cells = moved(tab.cells)
  tab.props = moved(tab.props)
  const meta: Record<string, JsonObj> = {}
  for (const [key, value] of Object.entries(dimension === 'ROWS' ? tab.rowMeta : tab.columnMeta)) {
    const to = mapIndex(Number(key))
    if (to !== null) meta[String(to)] = value
  }
  if (dimension === 'ROWS') tab.rowMeta = meta
  else tab.columnMeta = meta
}

// updateCells writes a rectangle by grid index rather than by A1 range,
// through its field mask the way repeatCell does. With a `range`, a cell the
// rows leave out has the masked fields cleared, which is how a caller
// shortens a sheet it previously wrote longer; with only a `start`, the
// rows' own cells are all it touches.
export function updateCells(sheet: Spreadsheet, body: JsonObj, at: At): JsonObj | Reply {
  const hasRange = body.range !== undefined
  const range = asObj(body.range)
  const start = asObj(body.start)
  const tab = gridOf(sheet, asNum((hasRange ? range : start).sheetId) ?? 0, at)
  if (isReply(tab)) return tab
  const paths = maskOf(body.fields, CELL_DATA, at)
  if (isReply(paths)) return paths
  const rows = asArr(body.rows).map((row) => asArr(asObj(row).values).map(asObj))
  const cellOf = (i: number, j: number): JsonObj => canonical(rows[i]?.[j] ?? {}, CELL_DATA)
  if (hasRange) {
    const b = boundsOf(range, tabGrid(tab))
    for (let row = b.top; row < b.bottom; row += 1) {
      for (let col = b.left; col < b.right; col += 1) {
        writeCell(tab, `${String(row)},${String(col)}`, cellOf(row - b.top, col - b.left), paths)
      }
    }
    return {}
  }
  const top = asNum(start.rowIndex) ?? 0
  const left = asNum(start.columnIndex) ?? 0
  rows.forEach((values, i) => {
    values.forEach((_, j) => {
      writeCell(tab, `${String(top + i)},${String(left + j)}`, cellOf(i, j), paths)
    })
  })
  return {}
}

// A mask over the DimensionProperties of every row or column in the range.
// What the API derives (hiddenByFilter, developer metadata, a data source
// column) is accepted and left alone, and hiddenByUser false is the
// default, so it is not kept. Probed live on 2026-09-21: an endIndex past
// the grid is clipped to it, and a startIndex at or past it is refused
// whatever the end.
export function updateDimensionProperties(
  sheet: Spreadsheet,
  body: JsonObj,
  at: At,
): JsonObj | Reply {
  const range = resolveDimensionRange(sheet, asObj(body.range), at)
  if (isReply(range)) return range
  const grid = tabGrid(range.tab)
  const [limit, noun] = range.dimension === 'ROWS' ? [grid.rows, 'row'] : [grid.cols, 'column']
  if (range.startIndex >= limit) {
    return invalid(
      at,
      `Cannot update a ${noun} that doesn't exist. Tried to update ${noun} index ` +
        `${String(range.startIndex)} but there are only ${String(limit)} ${noun}s.`,
    )
  }
  const paths = maskOf(body.fields, DIMENSION_PROPERTIES, at)
  if (isReply(paths)) return paths
  const source = canonical(asObj(body.properties), DIMENSION_PROPERTIES)
  const meta = range.dimension === 'ROWS' ? range.tab.rowMeta : range.tab.columnMeta
  const end = Math.min(range.endIndex, limit)
  for (let i = range.startIndex; i < end; i += 1) {
    const next = applyMask(meta[String(i)] ?? {}, source, paths, DIMENSION_PROPERTIES)
    delete next.hiddenByFilter
    delete next.developerMetadata
    delete next.dataSourceColumnReference
    if (next.hiddenByUser !== true) delete next.hiddenByUser
    if (Object.keys(next).length === 0) delete meta[String(i)]
    else meta[String(i)] = ordered(next, DIMENSION_PROPERTIES)
  }
  return {}
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

export function autoResizeDimensions(
  sheet: Spreadsheet,
  request: JsonObj,
  at: At,
): JsonObj | Reply {
  const raw = asObj(request.dimensions)
  const tab = gridOf(sheet, asNum(raw.sheetId) ?? 0, at)
  if (isReply(tab)) return tab
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
  const meta = dimension === 'ROWS' ? tab.rowMeta : tab.columnMeta
  for (let i = start; i < end; i += 1) {
    const pixelSize = measured.get(i) ?? (dimension === 'ROWS' ? ROW_PIXELS : COLUMN_PIXELS)
    meta[String(i)] = ordered({ ...meta[String(i)], pixelSize }, DIMENSION_PROPERTIES)
  }
  return {}
}
