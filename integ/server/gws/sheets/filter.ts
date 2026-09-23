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
import { asNum, asObj, asObjArr, asStrArr, isObj } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { googleError, isReply } from '../wire/reply.ts'
import { holds } from './conditional.ts'
import { BASIC_FILTER, CELL_DATA, CELL_FORMAT, canonical, ordered } from './fields.ts'
import { cellData, shownAt, tabGrid } from './grid.ts'
import { boundsOf, gridOf, invalid, rangeOn, rectOf, storedRange } from './request.ts'
import type { At, Rect } from './request.ts'

// The rows a basic filter hides: the data rows of its range (its first row
// is the header) where a column's criteria hide what the cell shows or a
// condition fails. Worked out from the data whenever asked, not stored.
export function filterHidden(tab: SheetTab): Set<number> {
  const hidden = new Set<number>()
  if (tab.basicFilter === null) return hidden
  const b = boundsOf(asObj(tab.basicFilter.range), tabGrid(tab))
  const specs = asObjArr(tab.basicFilter.filterSpecs)
  for (let row = b.top + 1; row < b.bottom; row += 1) {
    const at = (spec: JsonObj): boolean =>
      hides(asObj(spec.filterCriteria), tab, row, asNum(spec.columnIndex) ?? 0)
    if (specs.some(at)) hidden.add(row)
  }
  return hidden
}

// A hidden value hides a cell showing it in any case, as it does on the
// live API.
function hides(criteria: JsonObj, tab: SheetTab, row: number, col: number): boolean {
  const shown = shownAt(tab, row, col).toLowerCase()
  if ((asStrArr(criteria.hiddenValues) ?? []).some((v) => v.toLowerCase() === shown)) return true
  return isObj(criteria.condition) && !holds(criteria.condition, tab, row, col)
}

function userHidden(tab: SheetTab): number[] {
  return Object.entries(tab.rowMeta)
    .filter(([, meta]) => meta.hiddenByUser === true)
    .map(([row]) => Number(row))
}

export function renderFilter(filter: JsonObj, sheetId: number): JsonObj {
  return { ...filter, range: rangeOn(filter.range, sheetId) }
}

// The live API reports a filter's per-column criteria twice, as the
// `filterSpecs` list and as the older `criteria` map keyed by column, from
// whichever of the two the caller sent. Its sortSpecs sort the data rows
// once, as the filter is set, with only rows a user hid kept in place.
export function setBasicFilter(sheet: Spreadsheet, body: JsonObj, at: At): JsonObj | Reply {
  const filter = canonical(asObj(body.filter), BASIC_FILTER)
  const rect = rectOf(sheet, asObj(filter.range), at)
  if (isReply(rect)) return rect
  const sortSpecs = asObjArr(filter.sortSpecs)
  const refused = unordered(sortSpecs, at)
  if (refused !== null) return refused
  const specs = asObjArr(filter.filterSpecs)
  const criteria = asObj(filter.criteria)
  if (specs.length > 0) {
    filter.criteria = Object.fromEntries(
      specs.map((s) => [String(asNum(s.columnIndex) ?? 0), asObj(s.filterCriteria)]),
    )
  } else if (Object.keys(criteria).length > 0) {
    filter.filterSpecs = Object.entries(criteria).map(([col, c]) => ({
      columnIndex: Number(col),
      filterCriteria: c,
    }))
  }
  filter.range = storedRange(asObj(filter.range))
  rect.tab.basicFilter = ordered(filter, BASIC_FILTER)
  sortRows({ ...rect, top: rect.top + 1 }, sortSpecs, new Set(userHidden(rect.tab)))
  return {}
}

export function clearBasicFilter(sheet: Spreadsheet, body: JsonObj, at: At): JsonObj | Reply {
  const tab = gridOf(sheet, asNum(body.sheetId) ?? 0, at)
  if (isReply(tab)) return tab
  tab.basicFilter = null
  return {}
}

// A sort keeps every hidden row where it is, whether a user or the filter
// hid it. No sortSpecs at all is a no-op the live API accepts, and a sort
// key outside the range is one it fails on with a 500, changing nothing.
export function sortRange(sheet: Spreadsheet, body: JsonObj, at: At): JsonObj | Reply {
  const rect = rectOf(sheet, asObj(body.range), at)
  if (isReply(rect)) return rect
  const specs = asObjArr(body.sortSpecs)
  const refused = unordered(specs, at)
  if (refused !== null) return refused
  const outside = specs.some((s) => {
    const col = asNum(s.dimensionIndex) ?? 0
    return col < rect.left || col >= rect.right
  })
  if (outside) return googleError(500, 'Internal error encountered.', 'INTERNAL')
  sortRows(rect, specs, new Set([...userHidden(rect.tab), ...filterHidden(rect.tab)]))
  return {}
}

function unordered(specs: readonly JsonObj[], at: At): Reply | null {
  const ok = specs.every((s) => s.sortOrder === 'ASCENDING' || s.sortOrder === 'DESCENDING')
  return ok ? null : invalid(at, 'No sort order specified.')
}

// Reorders the rows of `rect`, stable, the rows in `fixed` staying put and
// the rest filling the places left. A row takes its values and formats
// inside the range along, but not its borders, which stay with the place,
// as they do on the live API.
function sortRows(rect: Rect, specs: readonly JsonObj[], fixed: ReadonlySet<number>): void {
  if (specs.length === 0) return
  const { tab, top, bottom, left, right } = rect
  const places: number[] = []
  for (let row = top; row < bottom; row += 1) if (!fixed.has(row)) places.push(row)
  const order = [...places].sort((a, b) => compareRows(tab, a, b, specs))
  const cells = new Map(tab.cells)
  const props = new Map(tab.props)
  places.forEach((to, i) => {
    const from = order[i] ?? to
    if (from === to) return
    for (let col = left; col < right; col += 1) {
      const src = `${String(from)},${String(col)}`
      const dst = `${String(to)},${String(col)}`
      const text = cells.get(src)
      if (text === undefined) tab.cells.delete(dst)
      else tab.cells.set(dst, text)
      const moved = keepBorders(props.get(src), props.get(dst))
      if (moved === undefined) tab.props.delete(dst)
      else tab.props.set(dst, moved)
    }
  })
}

function keepBorders(src: JsonObj | undefined, dst: JsonObj | undefined): JsonObj | undefined {
  const out = structuredClone(src ?? {})
  const format = { ...asObj(out.userEnteredFormat) }
  delete format.borders
  const borders = asObj(dst?.userEnteredFormat).borders
  if (borders !== undefined) format.borders = structuredClone(borders)
  if (Object.keys(format).length > 0) out.userEnteredFormat = ordered(format, CELL_FORMAT)
  else delete out.userEnteredFormat
  return Object.keys(out).length > 0 ? ordered(out, CELL_DATA) : undefined
}

// What a sort orders a cell by. Ascending order is numbers, then text
// without regard to case, then booleans; descending reverses that, and a
// blank cell (null here) sorts last either way.
interface SortKey {
  rank: number
  num: number
  str: string
}

function compareRows(tab: SheetTab, a: number, b: number, specs: readonly JsonObj[]): number {
  for (const spec of specs) {
    const col = asNum(spec.dimensionIndex) ?? 0
    const ka = sortKey(tab, a, col)
    const kb = sortKey(tab, b, col)
    if (ka === null || kb === null) {
      if (ka === kb) continue
      return ka === null ? 1 : -1
    }
    const order =
      ka.rank - kb.rank || ka.num - kb.num || (ka.str < kb.str ? -1 : ka.str > kb.str ? 1 : 0)
    if (order !== 0) return spec.sortOrder === 'DESCENDING' ? -order : order
  }
  return 0
}

function sortKey(tab: SheetTab, row: number, col: number): SortKey | null {
  const value = asObj(cellData(tab.cells.get(`${String(row)},${String(col)}`) ?? '').effectiveValue)
  if (typeof value.numberValue === 'number') return { rank: 0, num: value.numberValue, str: '' }
  if (typeof value.stringValue === 'string') {
    return { rank: 1, num: 0, str: value.stringValue.toLowerCase() }
  }
  if (typeof value.boolValue === 'boolean')
    return { rank: 2, num: Number(value.boolValue), str: '' }
  return null
}
