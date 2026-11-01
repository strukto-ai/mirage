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

import { describe, expect, it } from 'vitest'

import { eqClause, holdingClause, predicate } from './query.ts'

describe('lancedb where clause', () => {
  it('quotes a long literal across the host transfer window', () => {
    const value = "😀'".repeat(30_000)
    expect(eqClause('id', value)).toBe("`id` = '" + value.replaceAll("'", "''") + "'")
  })
  it.each([
    ['42', '`n` = 42'],
    ['-5', '`n` = -5'],
    ['--5', "`n` = '--5'"],
    ['٣', "`n` = '٣'"],
    ['4\n', "`n` = '4\n'"],
  ])('only compares a complete ASCII integer unquoted: %j', (value, clause) => {
    expect(eqClause('n', value)).toBe(clause)
    expect(predicate('id', { n: value }, '')).toBe(clause)
  })

  it('keeps filter order and quotes identifiers and literals', () => {
    expect(eqClause('a`b', "x'y")).toBe("`a``b` = 'x''y'")
    expect(predicate('', { z: '1', a: 'x' }, '')).toBe("`z` = 1 AND `a` = 'x'")
    expect(holdingClause(['a`b'], ['Hello'], true, { id: '2' })).toBe(
      "`id` = 2 AND (lower(`a``b`) LIKE '%hello%')",
    )
  })

  it('narrows on a name prefix, cast so a numeric id column takes one', () => {
    expect(predicate('id', {}, 'doc-1')).toBe("CAST(`id` AS STRING) LIKE 'doc-1%' ESCAPE '\\'")
  })

  it('escapes LIKE metacharacters in the prefix', () => {
    // An unescaped `_` is LIKE's single-character wildcard, so docX1 would
    // ride along and could crowd a real match out of the row cap.
    expect(predicate('id', {}, 'doc_')).toBe("CAST(`id` AS STRING) LIKE 'doc\\_%' ESCAPE '\\'")
    expect(predicate('id', {}, 'a%')).toBe("CAST(`id` AS STRING) LIKE 'a\\%%' ESCAPE '\\'")
  })

  it('ands the group filters with the prefix', () => {
    expect(predicate('id', { label: 'cat' }, 'doc-1')).toBe(
      "`label` = 'cat' AND CAST(`id` AS STRING) LIKE 'doc-1%' ESCAPE '\\'",
    )
  })

  it('quotes a column name a bare word could not spell', () => {
    // A space or a reserved word only parses quoted, and lance reads a
    // double-quoted word as a string literal, so the quotes are backticks.
    expect(predicate('document id', { select: 'cat' }, 'doc-1')).toBe(
      "`select` = 'cat' AND CAST(`document id` AS STRING) LIKE 'doc-1%' ESCAPE '\\'",
    )
  })

  it('is the filters alone with no prefix, and empty with neither', () => {
    expect(predicate('id', { label: 'cat' }, '')).toBe("`label` = 'cat'")
    expect(predicate('id', {}, '')).toBe('')
    expect(predicate('', {}, 'doc-1')).toBe('')
  })
})
