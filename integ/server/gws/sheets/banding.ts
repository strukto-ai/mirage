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
import { asNum, asObj, isObj } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { isReply } from '../wire/reply.ts'
import { BANDED_RANGE, canonical, ordered } from './fields.ts'
import { tabGrid } from './grid.ts'
import type { Grid } from './grid.ts'
import { boundsOf, covers, invalid, overlaps, rangeOn, rectOf, storedRange } from './request.ts'
import type { At } from './request.ts'

const OVERLAP =
  'You cannot add alternating background colors to a range that already has ' +
  'alternating background colors.'

// Banded range ids are unique across the whole spreadsheet. Live Sheets
// mints random ones; counting up from the largest keeps the fake's
// deterministic.
export function bandFloor(sheet: Spreadsheet): number {
  let top = 0
  for (const tab of sheet.tabs) {
    for (const banded of tab.bandedRanges) top = Math.max(top, asNum(banded.bandedRangeId) ?? 0)
  }
  return top
}

export function renderBanded(banded: JsonObj, sheetId: number): JsonObj {
  return { ...banded, range: rangeOn(banded.range, sheetId) }
}

// Both band colors are required before anything else is judged, the
// overlap included; a range may carry one banding only.
export function addBanding(sheet: Spreadsheet, body: JsonObj, at: At): JsonObj | Reply {
  const banded = canonical(asObj(body.bandedRange), BANDED_RANGE)
  const rect = rectOf(sheet, asObj(banded.range), at)
  if (isReply(rect)) return rect
  if (!isObj(banded.rowProperties) && !isObj(banded.columnProperties)) {
    return invalid(at, 'At least one of rowProperties or columnProperties must be specified.')
  }
  for (const key of ['rowProperties', 'columnProperties']) {
    const props = banded[key]
    if (!isObj(props)) continue
    for (const band of ['firstBandColor', 'secondBandColor']) {
      if (props[band] === undefined) return invalid(at, `${band} must be specified.`)
    }
  }
  const grid = tabGrid(rect.tab)
  if (rect.tab.bandedRanges.some((b) => overlaps(boundsOf(asObj(b.range), grid), rect))) {
    return invalid(at, OVERLAP)
  }
  const stored = ordered(
    { ...banded, bandedRangeId: bandFloor(sheet) + 1, range: storedRange(asObj(banded.range)) },
    BANDED_RANGE,
  )
  rect.tab.bandedRanges.push(stored)
  return { addBanding: { bandedRange: renderBanded(stored, rect.tab.sheetId) } }
}

// The color banding paints a cell: the header color on the range's first
// row (or column) when there is one, the footer color on its last, and the
// two band colors alternating between, counted from the range's edge
// whether or not a row is hidden. A range banded both ways paints the
// strongest of its two bands, as live Sheets did on 2026-09-21: a row's
// first band over a column's first band over a row's second band over a
// column's second. Header and footer, not probed against column bands, are
// taken to outrank both.
export function bandColor(
  tab: SheetTab,
  grid: Grid,
  row: number,
  col: number,
): JsonObj | undefined {
  for (const banded of tab.bandedRanges) {
    const b = boundsOf(asObj(banded.range), grid)
    if (!covers(b, row, col)) continue
    const bands = [
      band(asObj(banded.rowProperties), row - b.top, b.bottom - b.top),
      band(asObj(banded.columnProperties), col - b.left, b.right - b.left),
    ].filter((x) => x !== undefined)
    bands.sort((x, y) => x.rank - y.rank)
    return bands[0]?.color
  }
  return undefined
}

interface Band {
  rank: number
  color: JsonObj
}

function band(props: JsonObj, index: number, length: number): Band | undefined {
  const header = isObj(props.headerColor)
  if (header && index === 0) return ranked(0, props.headerColor)
  if (isObj(props.footerColor) && index === length - 1) return ranked(0, props.footerColor)
  const step = header ? index - 1 : index
  return step % 2 === 0 ? ranked(1, props.firstBandColor) : ranked(2, props.secondBandColor)
}

function ranked(rank: number, color: JsonValue | undefined): Band | undefined {
  return isObj(color) ? { rank, color } : undefined
}
