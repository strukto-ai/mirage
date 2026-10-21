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
import { extractText } from './messages.ts'

describe('extractText', () => {
  it('returns empty array for empty messages', () => {
    expect(extractText([])).toEqual([])
  })

  it('extracts plain string content from messages', () => {
    const msgs = [{ content: 'hello' }, { content: 'world' }]
    expect(extractText(msgs)).toEqual(['hello', 'world'])
  })

  it('skips empty/whitespace strings', () => {
    const msgs = [{ content: '  ' }, { content: 'x' }, { content: '' }]
    expect(extractText(msgs)).toEqual(['x'])
  })

  it('ignores messages without content field', () => {
    const msgs = [{ role: 'tool' }, { content: 'hi' }, { foo: 'bar' }]
    expect(extractText(msgs)).toEqual(['hi'])
  })

  it('extracts text from array-form content (Anthropic style)', () => {
    const msgs = [
      {
        content: [
          { type: 'text', text: 'first' },
          { type: 'tool_use', id: 'x' },
          { type: 'text', text: 'second' },
        ],
      },
    ]
    expect(extractText(msgs)).toEqual(['first', 'second'])
  })
})
