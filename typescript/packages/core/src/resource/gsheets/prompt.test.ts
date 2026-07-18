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
import { GSHEETS_PROMPT, GSHEETS_WRITE_PROMPT } from './prompt.ts'

describe('GSHEETS_PROMPT', () => {
  it('renders prefix and includes buckets, structure, jq paths, read command', () => {
    const rendered = GSHEETS_PROMPT.replace(/\{prefix\}/g, '/gsheets')
    expect(rendered).toContain('owned/')
    expect(rendered).toContain('shared/')
    expect(rendered).toContain('shared with you by others')
    expect(rendered).toContain('still in owned/')
    expect(rendered).toContain('gsheet.json structure')
    expect(rendered).toContain('.sheets[].properties.title')
    expect(rendered).toContain('gws sheets +read')
  })
})

describe('GSHEETS_WRITE_PROMPT', () => {
  it('matches actual command flag signatures', () => {
    expect(GSHEETS_WRITE_PROMPT).toContain('gws sheets +write')
    expect(GSHEETS_WRITE_PROMPT).toContain('--params')
    expect(GSHEETS_WRITE_PROMPT).toContain('--json')
    expect(GSHEETS_WRITE_PROMPT).toContain('spreadsheetId')
    expect(GSHEETS_WRITE_PROMPT).toContain('gws sheets +append')
    expect(GSHEETS_WRITE_PROMPT).toContain('--spreadsheet')
    expect(GSHEETS_WRITE_PROMPT).toContain('--range')
    expect(GSHEETS_WRITE_PROMPT).toContain('--values')
    expect(GSHEETS_WRITE_PROMPT).toContain('--json-values')
    expect(GSHEETS_WRITE_PROMPT).toContain('gws sheets spreadsheets create')
    expect(GSHEETS_WRITE_PROMPT).toContain('{"properties": {"title":')
    expect(GSHEETS_WRITE_PROMPT).toContain('gws sheets spreadsheets batchUpdate')
  })

  it('documents rm', () => {
    expect(GSHEETS_WRITE_PROMPT).toContain('rm ')
    expect(GSHEETS_WRITE_PROMPT).toContain('.gsheet.json')
  })
})
