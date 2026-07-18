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
import { GSLIDES_PROMPT, GSLIDES_WRITE_PROMPT } from './prompt.ts'

describe('GSLIDES_PROMPT', () => {
  it('renders prefix and includes buckets, structure, jq paths', () => {
    const rendered = GSLIDES_PROMPT.replace(/\{prefix\}/g, '/gslides')
    expect(rendered).toContain('owned/')
    expect(rendered).toContain('shared/')
    expect(rendered).toContain('shared with you by others')
    expect(rendered).toContain('still in owned/')
    expect(rendered).toContain('gslide.json structure')
    expect(rendered).toContain('.slides[].pageElements[].shape.text.textElements[].textRun.content')
  })
})

describe('GSLIDES_WRITE_PROMPT', () => {
  it('matches actual command flag signatures', () => {
    expect(GSLIDES_WRITE_PROMPT).toContain('gws slides presentations create')
    expect(GSLIDES_WRITE_PROMPT).toContain('--json')
    expect(GSLIDES_WRITE_PROMPT).toContain('{"title":')
    expect(GSLIDES_WRITE_PROMPT).toContain('gws slides presentations batchUpdate')
    expect(GSLIDES_WRITE_PROMPT).toContain('presentationId')
  })

  it('documents rm', () => {
    expect(GSLIDES_WRITE_PROMPT).toContain('rm ')
    expect(GSLIDES_WRITE_PROMPT).toContain('.gslide.json')
  })
})
