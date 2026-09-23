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

import type { SheetTab } from '../store/types.ts'
import { asNum, asObj } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import type { A1Range } from './a1.ts'
import { formatNumber } from './number.ts'

// The grid a new spreadsheet gets, and the pixel sizes the live API
// reports for its untouched rows and columns.
export const GRID_ROWS = 1000
export const GRID_COLUMNS = 26
export const ROW_PIXELS = 21
export const COLUMN_PIXELS = 100

export function newTab(
  sheetId: number,
  title: string,
  rows = GRID_ROWS,
  cols = GRID_COLUMNS,
): SheetTab {
  return {
    sheetId,
    title,
    cells: new Map(),
    props: new Map(),
    rows,
    cols,
    rowMeta: {},
    columnMeta: {},
    bandedRanges: [],
    basicFilter: null,
    conditionalFormats: [],
  }
}

// A tab carried whole to a new id and title: values, formats, row and
// column properties, banding, the filter and conditional formats. Banded
// range ids are unique across a spreadsheet, so the copy's are minted anew
// above `bandFloor`.
export function copyTab(
  tab: SheetTab,
  sheetId: number,
  title: string,
  bandFloor: number,
): SheetTab {
  const copy = structuredClone(tab)
  copy.sheetId = sheetId
  copy.title = title
  copy.bandedRanges.forEach((banded, i) => {
    banded.bandedRangeId = bandFloor + i + 1
  })
  return copy
}

export function tabExtent(tab: SheetTab): { rows: number; cols: number } {
  let rows = 0
  let cols = 0
  for (const key of tab.cells.keys()) {
    const [r, c] = key.split(',').map(Number) as [number, number]
    rows = Math.max(rows, r + 1)
    cols = Math.max(cols, c + 1)
  }
  return { rows, cols }
}

export function rangeValues(range: A1Range): string[][] {
  const extent = tabExtent(range.tab)
  const endRow = Math.min(range.endRow ?? extent.rows - 1, extent.rows - 1)
  const endCol = range.endCol ?? extent.cols - 1
  const out: string[][] = []
  for (let r = range.startRow; r <= endRow; r += 1) {
    const row: string[] = []
    for (let c = range.startCol; c <= endCol; c += 1) row.push(shownAt(range.tab, r, c))
    while (row.length > 0 && row[row.length - 1] === '') row.pop()
    out.push(row)
  }
  while (out.length > 0 && (out[out.length - 1] as string[]).length === 0) out.pop()
  return out
}

export function tabToCsv(tab: SheetTab): string {
  const rows = rangeValues(wholeTab(tab))
  return rows.map((r) => r.join(',')).join('\n') + (rows.length > 0 ? '\n' : '')
}

export function writeValues(range: A1Range, values: string[][], startRow: number): number {
  let cells = 0
  for (let i = 0; i < values.length; i += 1) {
    const row = values[i] as string[]
    for (let j = 0; j < row.length; j += 1) {
      range.tab.cells.set(`${String(startRow + i)},${String(range.startCol + j)}`, String(row[j]))
      cells += 1
    }
  }
  return cells
}

// values.clear and values.batchClear drop the cells inside the rect but
// leave the grid alone, which is what separates them from deleteDimension.
export function clearRange(range: A1Range): void {
  const extent = tabExtent(range.tab)
  const endRow = Math.min(range.endRow ?? extent.rows - 1, extent.rows - 1)
  const endCol = Math.min(range.endCol ?? extent.cols - 1, extent.cols - 1)
  for (let r = range.startRow; r <= endRow; r += 1) {
    for (let c = range.startCol; c <= endCol; c += 1) {
      range.tab.cells.delete(`${String(r)},${String(c)}`)
    }
  }
}

// Plain decimal only: a sign, digits either side of a point, an optional
// exponent. `0x10`, `1_000`, `Infinity` and a whitespace-only cell are all
// strings in live Sheets, which `Number()` would have made numeric.
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const BOOLEAN = /^(true|false)$/i
const EXPONENT = /[eE]/
const EXPONENT_DIGITS = 2

// A number typed with an exponent keeps a scientific format, which live
// Sheets renders with two decimals and a two-digit exponent: `1e3` is
// `"1.00E+03"`, `1e-3` is `"1.00E-03"`, `1e10` is `"1.00E+10"`.
export function scientific(value: number): string {
  const [mantissa = '', exponent = ''] = value.toExponential(2).split('e')
  const sign = exponent.startsWith('-') ? '-' : '+'
  const digits = exponent.replace(/^[+-]/, '').padStart(EXPONENT_DIGITS, '0')
  return `${mantissa}E${sign}${digits}`
}

// The grid a tab reports, which the live API grows to hold what was
// written: 1313 written rows report rowCount 1313, and rowMetadata has one
// entry per row of the grid rather than a fixed 1000.
export interface Grid {
  rows: number
  cols: number
}

export function tabGrid(tab: SheetTab): Grid {
  const used = tabExtent(tab)
  return { rows: Math.max(tab.rows, used.rows), cols: Math.max(tab.cols, used.cols) }
}

// Verified against the live API on 2026-08-05, writing through mirage's own
// path (values.update with valueInputOption=USER_ENTERED): `007` is the
// number 7 and reports `"7"`, `4.50` reports `"4.5"`, `TRUE` and `true` are
// both the boolean reporting `"TRUE"`, and everything else stays the string
// it was typed as. An untouched cell is `{}` -- no keys at all, since
// ExtendedValue with no field set means empty. A number the cell's
// numberFormat covers reports what the format renders (0.685 under `0.0%`
// is `"68.5%"`).
//
// Not modeled, and a string here where live Sheets makes it a number: a
// currency, percent, thousands-separated or date-shaped cell (`$5`, `50%`,
// `1,234`, `2026-01-02`), which needs Sheets' locale-aware number formats.
// A leading `+` is a formula in live Sheets (`+5` is formulaValue `"+5"`)
// whose rendered value happens to match the number taken here.
export function cellData(text: string, numberFormat?: JsonObj): JsonObj {
  if (text === '') return {}
  const trimmed = text.trim()
  if (BOOLEAN.test(trimmed)) {
    const value = { boolValue: trimmed.toLowerCase() === 'true' }
    return {
      userEnteredValue: value,
      effectiveValue: value,
      formattedValue: trimmed.toUpperCase(),
    }
  }
  if (DECIMAL.test(trimmed)) {
    const number = Number(trimmed)
    const value = { numberValue: number }
    const formatted = numberFormat === undefined ? null : formatNumber(number, numberFormat)
    return {
      userEnteredValue: value,
      effectiveValue: value,
      formattedValue: formatted ?? (EXPONENT.test(trimmed) ? scientific(number) : String(number)),
    }
  }
  const value = { stringValue: text }
  return { userEnteredValue: value, effectiveValue: value, formattedValue: text }
}

// The text values.get reports for a cell: what was typed, except where the
// cell's numberFormat renders the number it holds.
export function shownAt(tab: SheetTab, row: number, col: number): string {
  const key = `${String(row)},${String(col)}`
  const text = tab.cells.get(key) ?? ''
  const numberFormat = asObj(asObj(tab.props.get(key)?.userEnteredFormat).numberFormat)
  if (Object.keys(numberFormat).length === 0) return text
  const value = asNum(asObj(cellData(text).effectiveValue).numberValue)
  return value === undefined ? text : (formatNumber(value, numberFormat) ?? text)
}

// One CellData's value, back into the text a cell stores; null when it
// carries none.
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

export function wholeTab(tab: SheetTab): A1Range {
  return { tab, startRow: 0, startCol: 0, endRow: null, endCol: null }
}

export function tabProperties(tab: SheetTab, index: number): JsonObj {
  const grid = tabGrid(tab)
  return {
    sheetId: tab.sheetId,
    title: tab.title,
    index,
    sheetType: 'GRID',
    gridProperties: { rowCount: grid.rows, columnCount: grid.cols },
  }
}
