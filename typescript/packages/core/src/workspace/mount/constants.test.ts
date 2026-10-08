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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WRITE_CONDITIONS } from './constants.ts'

const FIXTURES = new URL('../../../../../../integ/fixtures/write/', import.meta.url)

const CONDITIONS = JSON.parse(readFileSync(new URL('conditions.json', FIXTURES), 'utf-8')) as {
  vfs: Record<string, string[]>
}

function sortedRows(r: Record<string, readonly string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [...v].sort()]))
}

describe('the condition table', () => {
  it('is the shared fixture, both ways', () => {
    const rows = Object.entries(CONDITIONS.vfs).filter(([, ops]) => ops.length > 0)
    expect(rows.length).toBeGreaterThan(0)
    expect(sortedRows(WRITE_CONDITIONS)).toEqual(sortedRows(Object.fromEntries(rows)))
  })
})
