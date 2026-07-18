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
import { GDOCS_PROMPT, GDOCS_WRITE_PROMPT } from './prompt.ts'

describe('GDOCS_PROMPT', () => {
  it('renders prefix and includes buckets, structure, jq paths', () => {
    const rendered = GDOCS_PROMPT.replace(/\{prefix\}/g, '/gdocs')
    expect(rendered).toContain('owned/')
    expect(rendered).toContain('shared/')
    expect(rendered).toContain('shared with you by others')
    expect(rendered).toContain('still in owned/')
    expect(rendered).toContain('gdoc.json structure')
    expect(rendered).toContain('.body.content[].paragraph.elements[].textRun.content')
  })
})

describe('GDOCS_WRITE_PROMPT', () => {
  it('matches actual command flag signatures', () => {
    expect(GDOCS_WRITE_PROMPT).toContain('gws docs +write')
    expect(GDOCS_WRITE_PROMPT).toContain('--document')
    expect(GDOCS_WRITE_PROMPT).toContain('--text')
    expect(GDOCS_WRITE_PROMPT).toContain('gws docs documents create')
    expect(GDOCS_WRITE_PROMPT).toContain('--json')
    expect(GDOCS_WRITE_PROMPT).toContain('{"title":')
    expect(GDOCS_WRITE_PROMPT).toContain('gws docs documents batchUpdate')
    expect(GDOCS_WRITE_PROMPT).toContain('documentId')
  })

  it('documents rm and the newline gotcha', () => {
    expect(GDOCS_WRITE_PROMPT).toContain('rm ')
    expect(GDOCS_WRITE_PROMPT).toContain('.gdoc.json')
    expect(GDOCS_WRITE_PROMPT).toContain("$'")
  })
})
