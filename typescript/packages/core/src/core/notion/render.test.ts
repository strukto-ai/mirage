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
import type { JsonObject } from '../../types.ts'
import { blocksToMarkdown } from './render.ts'

function paragraph(richText: JsonObject[]): JsonObject {
  return { type: 'paragraph', paragraph: { rich_text: richText } }
}

function renderOne(block: JsonObject): string {
  const out = blocksToMarkdown([block])
  return out.endsWith('\n') ? out.slice(0, -1) : out
}

describe('rich text to markdown', () => {
  it('renders plain text', () => {
    expect(renderOne(paragraph([{ plain_text: 'hello', annotations: {} }]))).toBe('hello')
  })

  it('renders bold', () => {
    expect(renderOne(paragraph([{ plain_text: 'bold', annotations: { bold: true } }]))).toBe(
      '**bold**',
    )
  })

  it('renders italic', () => {
    expect(renderOne(paragraph([{ plain_text: 'em', annotations: { italic: true } }]))).toBe('*em*')
  })

  it('renders inline code', () => {
    expect(renderOne(paragraph([{ plain_text: 'x', annotations: { code: true } }]))).toBe('`x`')
  })

  it('renders links', () => {
    expect(
      renderOne(paragraph([{ plain_text: 'click', annotations: {}, href: 'https://example.com' }])),
    ).toBe('[click](https://example.com)')
  })

  it('joins multiple fragments', () => {
    expect(
      renderOne(
        paragraph([
          { plain_text: 'a ', annotations: {} },
          { plain_text: 'b', annotations: { bold: true } },
        ]),
      ),
    ).toBe('a **b**')
  })
})

describe('block to markdown', () => {
  it('renders heading_1', () => {
    const block = { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Title' }] } }
    expect(renderOne(block)).toBe('# Title')
  })

  it('renders heading_2', () => {
    const block = { type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Sub' }] } }
    expect(renderOne(block)).toBe('## Sub')
  })

  it('renders bulleted_list_item', () => {
    const block = {
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: [{ plain_text: 'item' }] },
    }
    expect(renderOne(block)).toBe('- item')
  })

  it('renders checked to_do', () => {
    const block = { type: 'to_do', to_do: { rich_text: [{ plain_text: 'done' }], checked: true } }
    expect(renderOne(block)).toBe('- [x] done')
  })

  it('renders code blocks with language', () => {
    const block = {
      type: 'code',
      code: { rich_text: [{ plain_text: 'print(1)' }], language: 'python' },
    }
    expect(renderOne(block)).toBe('```python\nprint(1)\n```')
  })

  it('renders divider', () => {
    expect(renderOne({ type: 'divider', divider: {} })).toBe('---')
  })

  it('renders child_page as empty', () => {
    expect(blocksToMarkdown([{ type: 'child_page', child_page: { title: 'Sub' } }])).toBe('')
  })
})

describe('blocksToMarkdown', () => {
  it('joins multiple blocks with blank lines and trailing newline', () => {
    const blocks = [
      { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Title' }] } },
      { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'body' }] } },
    ]
    expect(blocksToMarkdown(blocks)).toBe('# Title\n\nbody\n')
  })

  it('returns empty string for no blocks', () => {
    expect(blocksToMarkdown([])).toBe('')
  })

  it('renders nested children with indentation', () => {
    const blocks = [
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ plain_text: 'parent' }] },
        children: [
          {
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: [{ plain_text: 'child' }] },
          },
        ],
      },
    ]
    expect(blocksToMarkdown(blocks)).toBe('- parent\n\n  - child\n')
  })
})
