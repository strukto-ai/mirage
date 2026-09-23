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
import { asNum, asObj } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { googleError, isReply } from '../wire/reply.ts'
import { GRID_RANGE, ordered } from './fields.ts'
import type { Fields } from './fields.ts'
import { tabGrid } from './grid.ts'
import type { Grid } from './grid.ts'
import { badField, parseMask } from './mask.ts'
import type { MaskPath } from './mask.ts'

// Where a batchUpdate request sits, which every refusal names: the live API
// prefixes each one with `Invalid requests[i].<kind>: `.
export interface At {
  index: number
  kind: string
}

export function invalid(at: At, message: string): Reply {
  return googleError(
    400,
    `Invalid requests[${String(at.index)}].${at.kind}: ${message}`,
    'INVALID_ARGUMENT',
  )
}

export function gridOf(sheet: Spreadsheet, sheetId: number, at: At): SheetTab | Reply {
  const tab = sheet.tabs.find((t) => t.sheetId === sheetId)
  return tab ?? invalid(at, `No grid with id: ${String(sheetId)}`)
}

// A GridRange's rows and columns, half open, with an absent end reaching the
// edge of the grid.
export interface Bounds {
  top: number
  bottom: number
  left: number
  right: number
}

export interface Rect extends Bounds {
  tab: SheetTab
}

export function boundsOf(range: JsonObj, grid: Grid): Bounds {
  const clip = (v: number | undefined, fallback: number, limit: number): number =>
    Math.min(Math.max(v ?? fallback, 0), limit)
  return {
    top: clip(asNum(range.startRowIndex), 0, grid.rows),
    bottom: clip(asNum(range.endRowIndex), grid.rows, grid.rows),
    left: clip(asNum(range.startColumnIndex), 0, grid.cols),
    right: clip(asNum(range.endColumnIndex), grid.cols, grid.cols),
  }
}

export function rectOf(sheet: Spreadsheet, range: JsonObj, at: At): Rect | Reply {
  const tab = gridOf(sheet, asNum(range.sheetId) ?? 0, at)
  if (isReply(tab)) return tab
  return { tab, ...boundsOf(range, tabGrid(tab)) }
}

export function covers(b: Bounds, row: number, col: number): boolean {
  return row >= b.top && row < b.bottom && col >= b.left && col < b.right
}

export function overlaps(a: Bounds, b: Bounds): boolean {
  return a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right
}

// A GridRange the way a tab stores it, without the sheetId its tab already
// is, and the way the live API reports it, which names the sheet only when
// it is not the first one's 0.
export function storedRange(range: JsonObj): JsonObj {
  const out = ordered(range, GRID_RANGE)
  delete out.sheetId
  return out
}

export function rangeOn(range: JsonValue | undefined, sheetId: number): JsonObj {
  return sheetId === 0 ? asObj(range) : { sheetId, ...asObj(range) }
}

// A request's `fields`, read and checked against the message it masks.
export function maskOf(raw: JsonValue | undefined, fields: Fields, at: At): MaskPath[] | Reply {
  const paths = typeof raw === 'string' ? parseMask(raw) : []
  if (paths.length === 0) {
    return invalid(
      at,
      "At least one field must be listed in 'fields'. (Use '*' to indicate all fields.)",
    )
  }
  const bad = badField(paths, fields)
  return bad === null ? paths : invalid(at, `Invalid field: ${bad}`)
}
