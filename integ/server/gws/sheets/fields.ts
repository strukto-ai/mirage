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
import { asObj, isObj } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'

// The field trees of the Sheets messages this fake stores, each in proto field
// order. One tree answers three questions: which paths a FieldMask may name,
// the order the live API renders keys in (it follows the field numbers, not
// the order a caller wrote them), and where a Color sits, since every Color
// is quantized and mirrored into its `...Style` twin. A null child is a
// scalar; `list` and `map` children are repeated fields, which a mask cannot
// reach into but whose elements still render in order.
export type Field = Fields | null | { list: Fields } | { map: Fields }
export type Fields = readonly (readonly [string, Field])[]

export function isMessage(child: Field | undefined): child is Fields {
  return Array.isArray(child)
}

export const COLOR: Fields = [
  ['red', null],
  ['green', null],
  ['blue', null],
  ['alpha', null],
]

export const COLOR_STYLE: Fields = [
  ['rgbColor', COLOR],
  ['themeColor', null],
]

const BORDER: Fields = [
  ['style', null],
  ['width', null],
  ['color', COLOR],
  ['colorStyle', COLOR_STYLE],
]

export const BORDERS: Fields = [
  ['top', BORDER],
  ['bottom', BORDER],
  ['left', BORDER],
  ['right', BORDER],
]

const TEXT_FORMAT: Fields = [
  ['foregroundColor', COLOR],
  ['fontFamily', null],
  ['fontSize', null],
  ['bold', null],
  ['italic', null],
  ['strikethrough', null],
  ['underline', null],
  ['foregroundColorStyle', COLOR_STYLE],
  ['link', [['uri', null]]],
]

export const CELL_FORMAT: Fields = [
  [
    'numberFormat',
    [
      ['type', null],
      ['pattern', null],
    ],
  ],
  ['backgroundColor', COLOR],
  ['borders', BORDERS],
  [
    'padding',
    [
      ['top', null],
      ['right', null],
      ['bottom', null],
      ['left', null],
    ],
  ],
  ['horizontalAlignment', null],
  ['verticalAlignment', null],
  ['wrapStrategy', null],
  ['textDirection', null],
  ['textFormat', TEXT_FORMAT],
  ['hyperlinkDisplayType', null],
  [
    'textRotation',
    [
      ['angle', null],
      ['vertical', null],
    ],
  ],
  ['backgroundColorStyle', COLOR_STYLE],
]

const EXTENDED_VALUE: Fields = [
  ['numberValue', null],
  ['stringValue', null],
  ['boolValue', null],
  ['formulaValue', null],
  ['errorValue', null],
]

export const CELL_DATA: Fields = [
  ['userEnteredValue', EXTENDED_VALUE],
  ['effectiveValue', EXTENDED_VALUE],
  ['formattedValue', null],
  ['userEnteredFormat', CELL_FORMAT],
  ['effectiveFormat', CELL_FORMAT],
  ['hyperlink', null],
  ['note', null],
  ['textFormatRuns', null],
  ['dataValidation', null],
  ['pivotTable', null],
  ['dataSourceTable', null],
  ['dataSourceFormula', null],
  ['chipRuns', null],
]

export const DIMENSION_PROPERTIES: Fields = [
  ['hiddenByFilter', null],
  ['hiddenByUser', null],
  ['pixelSize', null],
  ['developerMetadata', null],
  ['dataSourceColumnReference', null],
]

export const GRID_RANGE: Fields = [
  ['sheetId', null],
  ['startRowIndex', null],
  ['endRowIndex', null],
  ['startColumnIndex', null],
  ['endColumnIndex', null],
]

const BANDING_PROPERTIES: Fields = [
  ['headerColor', COLOR],
  ['firstBandColor', COLOR],
  ['secondBandColor', COLOR],
  ['footerColor', COLOR],
  ['headerColorStyle', COLOR_STYLE],
  ['firstBandColorStyle', COLOR_STYLE],
  ['secondBandColorStyle', COLOR_STYLE],
  ['footerColorStyle', COLOR_STYLE],
]

export const BANDED_RANGE: Fields = [
  ['bandedRangeId', null],
  ['range', GRID_RANGE],
  ['rowProperties', BANDING_PROPERTIES],
  ['columnProperties', BANDING_PROPERTIES],
]

const BOOLEAN_CONDITION: Fields = [
  ['type', null],
  [
    'values',
    {
      list: [
        ['relativeDate', null],
        ['userEnteredValue', null],
      ],
    },
  ],
]

const FILTER_CRITERIA: Fields = [
  ['hiddenValues', null],
  ['condition', BOOLEAN_CONDITION],
  ['visibleBackgroundColor', COLOR],
  ['visibleForegroundColor', COLOR],
  ['visibleBackgroundColorStyle', COLOR_STYLE],
  ['visibleForegroundColorStyle', COLOR_STYLE],
]

export const BASIC_FILTER: Fields = [
  ['range', GRID_RANGE],
  [
    'sortSpecs',
    {
      list: [
        ['dimensionIndex', null],
        ['sortOrder', null],
        ['foregroundColor', COLOR],
        ['backgroundColor', COLOR],
        ['foregroundColorStyle', COLOR_STYLE],
        ['backgroundColorStyle', COLOR_STYLE],
        ['dataSourceColumnReference', null],
      ],
    },
  ],
  ['criteria', { map: FILTER_CRITERIA }],
  [
    'filterSpecs',
    {
      list: [
        ['columnIndex', null],
        ['filterCriteria', FILTER_CRITERIA],
        ['dataSourceColumnReference', null],
      ],
    },
  ],
  ['tableId', null],
]

export const CONDITIONAL_RULE: Fields = [
  ['ranges', { list: GRID_RANGE }],
  [
    'booleanRule',
    [
      ['condition', BOOLEAN_CONDITION],
      ['format', CELL_FORMAT],
    ],
  ],
  ['gradientRule', null],
]

// Width follows the style on the live API, whatever width the caller sent.
const BORDER_WIDTH: Record<string, number> = {
  DOTTED: 1,
  DASHED: 1,
  SOLID: 1,
  SOLID_MEDIUM: 2,
  SOLID_THICK: 3,
  DOUBLE: 3,
}

// A channel the way Sheets stores it: the proto `float` it arrives as, times
// 255 in float arithmetic and truncated to a byte, reported as the float32
// that byte divided by 255 is, printed as its shortest round-tripping
// decimal. So 0.9 comes back 0.8980392 and 0.5 comes back 0.49803922, while
// 0.4, or any value read back from Sheets, stays as it is.
function channel(value: number): number {
  const byte = Math.floor(Math.fround(Math.fround(Math.min(Math.max(value, 0), 1)) * 255))
  const f = Math.fround(byte / 255)
  for (let digits = 1; digits <= 9; digits += 1) {
    const shortest = Number(f.toPrecision(digits))
    if (Math.fround(shortest) === f) return shortest
  }
  return f
}

// A zero channel is absent, as proto3 renders it, so black is `{}`.
function color(value: JsonObj): JsonObj {
  const out: JsonObj = {}
  for (const [key] of COLOR) {
    const v = value[key]
    if (typeof v !== 'number') continue
    const c = key === 'alpha' ? v : channel(v)
    if (c !== 0) out[key] = c
  }
  return out
}

// A message's value in the order and shape the live API reports it: keys in
// field order and unknown ones dropped, an emptied message gone, every Color
// quantized, each `X` paired with its `XStyle` twin (the style wins when
// both came in), a border's width taken from its style, and a border side
// set to NONE gone.
export function canonical(value: JsonObj, fields: Fields): JsonObj {
  const out: JsonObj = {}
  for (const [key, child] of fields) {
    const v = value[key]
    if (v === undefined) continue
    if (fields === BORDERS && isObj(v) && v.style === 'NONE') continue
    const next = canonicalField(v, child)
    if (isMessage(child) && child !== COLOR && isObj(next) && Object.keys(next).length === 0) {
      continue
    }
    out[key] = next
  }
  for (const [key, child] of fields) {
    const style = `${key}Style`
    if (child !== COLOR || !fields.some(([name]) => name === style)) continue
    const twin = out[style]
    if (isObj(twin)) {
      if (isObj(twin.rgbColor)) out[key] = { ...twin.rgbColor }
    } else if (isObj(out[key])) out[style] = { rgbColor: { ...out[key] } }
  }
  if (fields === BORDER && typeof out.style === 'string') {
    const width = BORDER_WIDTH[out.style]
    if (width !== undefined) out.width = width
    out.color ??= {}
    out.colorStyle ??= { rgbColor: { ...asObj(out.color) } }
  }
  return ordered(out, fields)
}

function canonicalField(value: JsonValue, child: Field): JsonValue {
  if (child === COLOR) return isObj(value) ? color(value) : value
  return viaField(value, child, canonical)
}

// Keys in field order, recursively, without touching any value.
export function ordered(value: JsonObj, fields: Fields): JsonObj {
  const out: JsonObj = {}
  for (const [key, child] of fields) {
    const v = value[key]
    if (v !== undefined) out[key] = viaField(v, child, ordered)
  }
  return out
}

// `fn` applied to every message a field holds: the one message, each
// element of a repeated one, each value of a map. A message is a Fields
// array, which is why that test comes first: an array has a `map` of its
// own.
function viaField(
  value: JsonValue,
  child: Field,
  fn: (v: JsonObj, fields: Fields) => JsonObj,
): JsonValue {
  if (child === null) return value
  if (isMessage(child)) return isObj(value) ? fn(value, child) : value
  if ('list' in child) {
    return Array.isArray(value) ? value.map((v) => (isObj(v) ? fn(v, child.list) : v)) : value
  }
  if (!isObj(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, isObj(v) ? fn(v, child.map) : v]),
  )
}

// The layering an effective format is built from: `over` wins field by
// field, and a Color is one field, so a band's `{blue: 1}` over white is
// blue rather than white with a blue channel.
export function merged(base: JsonObj, over: JsonObj, fields: Fields): JsonObj {
  const out: JsonObj = { ...base }
  for (const [key, child] of fields) {
    const v = over[key]
    if (v === undefined) continue
    const b = out[key]
    out[key] = isMessage(child) && child !== COLOR && isObj(b) && isObj(v) ? merged(b, v, child) : v
  }
  return out
}
