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
import type { SheetTab, Spreadsheet } from '../store/types.ts'
import { asObj, isObj } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { isReply } from '../wire/reply.ts'
import { bandColor } from './banding.ts'
import { ruleFormat } from './conditional.ts'
import { CELL_DATA, CELL_FORMAT, canonical, merged, ordered } from './fields.ts'
import { cellData, cellText } from './grid.ts'
import type { Grid } from './grid.ts'
import { applyMask, isWhole } from './mask.ts'
import type { MaskPath } from './mask.ts'
import { maskOf, rectOf } from './request.ts'
import type { At } from './request.ts'

const WHITE = { red: 1, green: 1, blue: 1 }

// The spreadsheet's defaultFormat, as the live API reported it on
// 2026-09-21 for a new spreadsheet.
export const DEFAULT_FORMAT: JsonObj = {
  backgroundColor: WHITE,
  padding: { top: 2, right: 3, bottom: 2, left: 3 },
  verticalAlignment: 'BOTTOM',
  wrapStrategy: 'OVERFLOW_CELL',
  textFormat: {
    foregroundColor: {},
    fontFamily: 'arial,sans,sans-serif',
    fontSize: 10,
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    foregroundColorStyle: { rgbColor: {} },
  },
  backgroundColorStyle: { rgbColor: WHITE },
}

function themeColor(colorType: string, rgbColor: JsonObj): JsonObj {
  return { colorType, color: { rgbColor } }
}

export const SPREADSHEET_THEME: JsonObj = {
  primaryFontFamily: 'Arial',
  themeColors: [
    themeColor('TEXT', {}),
    themeColor('BACKGROUND', WHITE),
    themeColor('ACCENT1', { red: 0.25882354, green: 0.52156866, blue: 0.95686275 }),
    themeColor('ACCENT2', { red: 0.91764706, green: 0.2627451, blue: 0.20784314 }),
    themeColor('ACCENT3', { red: 0.9843137, green: 0.7372549, blue: 0.015686275 }),
    themeColor('ACCENT4', { red: 0.20392157, green: 0.65882355, blue: 0.3254902 }),
    themeColor('ACCENT5', { red: 1, green: 0.42745098, blue: 0.003921569 }),
    themeColor('ACCENT6', { red: 0.27450982, green: 0.7411765, blue: 0.7764706 }),
    themeColor('LINK', { red: 0.06666667, green: 0.33333334, blue: 0.8 }),
  ],
}

// A cell reports its effective font by the theme's name, not the CSS list
// the defaultFormat carries.
const CELL_DEFAULT = merged(DEFAULT_FORMAT, { textFormat: { fontFamily: 'Arial' } }, CELL_FORMAT)

const ALIGNMENT: Record<string, string> = {
  stringValue: 'LEFT',
  numberValue: 'RIGHT',
  boolValue: 'CENTER',
}

// A cell's effectiveFormat, layered the way the live API layers it: the
// default, the alignment its value implies, its own format, then a band's
// color over its fill, then the first conditional rule that holds. A number
// under a TEXT format aligns as text. A cell holding a value also reports
// hyperlinkDisplayType; an empty cell reports a format only when it has one
// of its own or a band or rule reaches it.
export function effectiveFormat(
  tab: SheetTab,
  grid: Grid,
  row: number,
  col: number,
): JsonObj | undefined {
  const key = `${String(row)},${String(col)}`
  const own = tab.props.get(key)?.userEnteredFormat
  const kind = Object.keys(asObj(cellData(tab.cells.get(key) ?? '').effectiveValue))[0]
  const band = bandColor(tab, grid, row, col)
  const rule = ruleFormat(tab, grid, row, col)
  if (kind === undefined && own === undefined && band === undefined && rule === undefined) {
    return undefined
  }
  let format = CELL_DEFAULT
  if (kind !== undefined) {
    const asText = asObj(asObj(own).numberFormat).type === 'TEXT'
    const implied: JsonObj = { hyperlinkDisplayType: 'PLAIN_TEXT' }
    const alignment = asText ? 'LEFT' : ALIGNMENT[kind]
    if (alignment !== undefined) implied.horizontalAlignment = alignment
    format = merged(format, implied, CELL_FORMAT)
  }
  format = merged(format, asObj(own), CELL_FORMAT)
  if (band !== undefined) {
    const fill = { backgroundColor: band, backgroundColorStyle: { rgbColor: band } }
    format = merged(format, fill, CELL_FORMAT)
  }
  format = merged(format, rule ?? {}, CELL_FORMAT)
  return ordered(format, CELL_FORMAT)
}

// The CellData fields the live API derives or keeps for itself: a write to
// one of them is accepted and changes nothing.
const DERIVED = [
  'effectiveValue',
  'formattedValue',
  'effectiveFormat',
  'hyperlink',
  'dataSourceFormula',
]

// One masked write of `source` into the cell at `key`. The value moves only
// when the mask names it, so an untouched cell keeps the text it was typed
// as; every other field the mask names lands in the cell's props.
export function writeCell(
  tab: SheetTab,
  key: string,
  source: JsonObj,
  paths: readonly MaskPath[],
): void {
  const next = canonical(applyMask(tab.props.get(key) ?? {}, source, paths, CELL_DATA), CELL_DATA)
  if (isWhole(paths) || paths.some((p) => p[0] === 'userEnteredValue')) {
    const text = cellText(next)
    if (text === null) tab.cells.delete(key)
    else tab.cells.set(key, text)
  }
  delete next.userEnteredValue
  for (const field of DERIVED) delete next[field]
  if (Object.keys(next).length === 0) tab.props.delete(key)
  else tab.props.set(key, next)
}

export function repeatCell(sheet: Spreadsheet, body: JsonObj, at: At): JsonObj | Reply {
  const rect = rectOf(sheet, asObj(body.range), at)
  if (isReply(rect)) return rect
  const paths = maskOf(body.fields, CELL_DATA, at)
  if (isReply(paths)) return paths
  const cell = canonical(asObj(body.cell), CELL_DATA)
  for (let row = rect.top; row < rect.bottom; row += 1) {
    for (let col = rect.left; col < rect.right; col += 1) {
      writeCell(rect.tab, `${String(row)},${String(col)}`, cell, paths)
    }
  }
  return {}
}

// Each side of the range takes its own border and every line inside it
// takes the inner one, set on the cells either side of the line; a side the
// request leaves out keeps what it had, and style NONE removes it.
export function updateBorders(sheet: Spreadsheet, body: JsonObj, at: At): JsonObj | Reply {
  const rect = rectOf(sheet, asObj(body.range), at)
  if (isReply(rect)) return rect
  for (let row = rect.top; row < rect.bottom; row += 1) {
    for (let col = rect.left; col < rect.right; col += 1) {
      const sides: [string, JsonValue | undefined][] = [
        ['top', row === rect.top ? body.top : body.innerHorizontal],
        ['bottom', row === rect.bottom - 1 ? body.bottom : body.innerHorizontal],
        ['left', col === rect.left ? body.left : body.innerVertical],
        ['right', col === rect.right - 1 ? body.right : body.innerVertical],
      ]
      const key = `${String(row)},${String(col)}`
      const format = asObj(rect.tab.props.get(key)?.userEnteredFormat)
      const borders = { ...asObj(format.borders) }
      for (const [side, border] of sides) if (isObj(border)) borders[side] = border
      writeCell(rect.tab, key, { userEnteredFormat: { ...format, borders } }, [
        ['userEnteredFormat'],
      ])
    }
  }
  return {}
}
