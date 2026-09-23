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
import { asNum, asObj, asObjArr, asStr } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { isReply } from '../wire/reply.ts'
import { CONDITIONAL_RULE, canonical } from './fields.ts'
import { cellData, shownAt } from './grid.ts'
import type { Grid } from './grid.ts'
import { boundsOf, covers, gridOf, invalid, rangeOn, rectOf, storedRange } from './request.ts'
import type { At } from './request.ts'

// Whether a BooleanCondition holds for one cell, for the condition types
// that read the cell's own value: numbers compare as numbers, text compares
// without case against what the cell shows, and blanks are cells showing
// nothing. Dates, formulas, lists, URLs and emails need Sheets' evaluator
// and never hold here.
export function holds(condition: JsonObj, tab: SheetTab, row: number, col: number): boolean {
  const args = asObjArr(condition.values).map((v) => asStr(v.userEnteredValue) ?? '')
  const shown = shownAt(tab, row, col)
  const text = shown.toLowerCase()
  const arg = (args[0] ?? '').toLowerCase()
  const value = cellData(tab.cells.get(`${String(row)},${String(col)}`) ?? '')
  const number = asNum(asObj(value.effectiveValue).numberValue)
  const [low = NaN, high = NaN] = args.map(Number)
  switch (asStr(condition.type)) {
    case 'BLANK':
      return shown === ''
    case 'NOT_BLANK':
      return shown !== ''
    case 'TEXT_CONTAINS':
      return text.includes(arg)
    case 'TEXT_NOT_CONTAINS':
      return !text.includes(arg)
    case 'TEXT_STARTS_WITH':
      return text.startsWith(arg)
    case 'TEXT_ENDS_WITH':
      return text.endsWith(arg)
    case 'TEXT_EQ':
      return text === arg
    case 'NUMBER_GREATER':
      return number !== undefined && number > low
    case 'NUMBER_GREATER_THAN_EQ':
      return number !== undefined && number >= low
    case 'NUMBER_LESS':
      return number !== undefined && number < low
    case 'NUMBER_LESS_THAN_EQ':
      return number !== undefined && number <= low
    case 'NUMBER_EQ':
      return number !== undefined && number === low
    case 'NUMBER_NOT_EQ':
      return number !== undefined && number !== low
    case 'NUMBER_BETWEEN':
      return number !== undefined && number >= low && number <= high
    case 'NUMBER_NOT_BETWEEN':
      return number !== undefined && (number < low || number > high)
    default:
      return false
  }
}

// The format the first rule covering a cell applies, if its condition holds
// there. A later rule never adds to an earlier one's. Gradient rules are not
// modeled.
export function ruleFormat(
  tab: SheetTab,
  grid: Grid,
  row: number,
  col: number,
): JsonObj | undefined {
  for (const rule of tab.conditionalFormats) {
    if (!asObjArr(rule.ranges).some((r) => covers(boundsOf(r, grid), row, col))) continue
    const boolean = asObj(rule.booleanRule)
    if (holds(asObj(boolean.condition), tab, row, col)) return asObj(boolean.format)
  }
  return undefined
}

export function renderRule(rule: JsonObj, sheetId: number): JsonObj {
  return { ...rule, ranges: asObjArr(rule.ranges).map((r) => rangeOn(r, sheetId)) }
}

// All a conditional rule may format; the live API refuses a rule that
// reaches for anything else.
const RULE_FORMAT = new Set(['backgroundColor', 'backgroundColorStyle', 'textFormat'])
const RULE_TEXT = new Set([
  'bold',
  'italic',
  'strikethrough',
  'foregroundColor',
  'foregroundColorStyle',
])
const RULE_LIMIT =
  'ConditionalFormatRule.format only supports bold, italic, strikethrough, foreground color ' +
  'and background color.'

// The rule lands at `index` among its tab's rules, or last when the index
// runs past them, which the live API accepts.
export function addConditionalFormatRule(
  sheet: Spreadsheet,
  body: JsonObj,
  at: At,
): JsonObj | Reply {
  const rule = canonical(asObj(body.rule), CONDITIONAL_RULE)
  const ranges = asObjArr(rule.ranges)
  const rect = rectOf(sheet, ranges[0] ?? {}, at)
  if (isReply(rect)) return rect
  const format = asObj(asObj(rule.booleanRule).format)
  const allowed =
    Object.keys(format).every((k) => RULE_FORMAT.has(k)) &&
    Object.keys(asObj(format.textFormat)).every((k) => RULE_TEXT.has(k))
  if (!allowed) return invalid(at, RULE_LIMIT)
  rule.ranges = ranges.map(storedRange)
  const rules = rect.tab.conditionalFormats
  rules.splice(Math.min(Math.max(asNum(body.index) ?? 0, 0), rules.length), 0, rule)
  return {}
}

export function deleteConditionalFormatRule(
  sheet: Spreadsheet,
  body: JsonObj,
  at: At,
): JsonObj | Reply {
  const sheetId = asNum(body.sheetId) ?? 0
  const tab = gridOf(sheet, sheetId, at)
  if (isReply(tab)) return tab
  const index = asNum(body.index) ?? 0
  const rule = index >= 0 ? tab.conditionalFormats[index] : undefined
  if (rule === undefined) {
    return invalid(
      at,
      `No conditional format on sheet: ${String(sheetId)} at index: ${String(index)}`,
    )
  }
  tab.conditionalFormats.splice(index, 1)
  return { deleteConditionalFormatRule: { rule: renderRule(rule, sheetId) } }
}
