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
import {
  extractIdNoDashes,
  extractTitle,
  normalizePage,
  pageSegmentName,
  toJsonBytes,
} from './normalize.ts'

describe('extractTitle', () => {
  it('joins title.title plain_text fragments', () => {
    const page = {
      properties: {
        title: {
          title: [{ plain_text: 'Hello' }, { plain_text: ' World' }],
        },
      },
    }
    expect(extractTitle(page)).toBe('Hello World')
  })

  it('falls back to properties.Name.title for database rows', () => {
    const page = {
      properties: {
        Name: {
          title: [{ plain_text: 'Row A' }],
        },
      },
    }
    expect(extractTitle(page)).toBe('Row A')
  })

  it('returns "untitled" when properties is empty', () => {
    expect(extractTitle({ properties: {} })).toBe('untitled')
  })

  it('returns "untitled" when properties is missing', () => {
    expect(extractTitle({})).toBe('untitled')
  })
})

describe('extractIdNoDashes', () => {
  it('strips dashes from a UUID-formatted id', () => {
    expect(extractIdNoDashes({ id: '2c4e9c3a-1234-5678-90ab-cdef01234567' })).toBe(
      '2c4e9c3a1234567890abcdef01234567',
    )
  })

  it('lowercases an already 32-hex id', () => {
    expect(extractIdNoDashes({ id: 'ABC123DEF4567890123456789012345A' })).toBe(
      'abc123def4567890123456789012345a',
    )
  })

  it('throws when the id is not a 32-hex value', () => {
    expect(() => extractIdNoDashes({ id: 'not-a-uuid' })).toThrow('notion page missing id')
  })

  it('throws when the page has no id at all', () => {
    expect(() => extractIdNoDashes({})).toThrow('notion page missing id')
  })
})

describe('pageSegmentName', () => {
  it('returns sanitized title__id with the raw dashed id', () => {
    const page = {
      id: '2c4e9c3a-1234-5678-90ab-cdef01234567',
      properties: { title: { type: 'title', title: [{ plain_text: 'Hi There' }] } },
    }
    expect(pageSegmentName(page)).toBe('Hi_There__2c4e9c3a-1234-5678-90ab-cdef01234567')
  })

  it('falls back to "untitled" when the page has no title property', () => {
    const page = { id: '2c4e9c3a-1234-5678-90ab-cdef01234567', properties: {} }
    expect(pageSegmentName(page)).toBe('untitled__2c4e9c3a-1234-5678-90ab-cdef01234567')
  })
})

describe('normalizePage', () => {
  it('builds the Python-shaped record from a representative page', () => {
    const page = {
      id: '2c4e9c3a-1234-5678-90ab-cdef01234567',
      url: 'https://notion.so/Hello-2c4e9c3a1234567890abcdef01234567',
      created_time: '2025-01-01T00:00:00.000Z',
      last_edited_time: '2025-02-01T00:00:00.000Z',
      archived: false,
      parent: { type: 'workspace', workspace: true },
      created_by: { object: 'user', id: 'user-1' },
      last_edited_by: { object: 'user', id: 'user-2' },
      properties: {
        Name: { id: 'title', type: 'title', title: [{ plain_text: 'Hello' }] },
      },
    }
    const blocks = [
      {
        object: 'block',
        id: 'b1',
        type: 'paragraph',
        paragraph: { rich_text: [{ plain_text: 'Hi' }] },
      },
      {
        object: 'block',
        id: 'b2',
        type: 'heading_1',
        heading_1: { rich_text: [{ plain_text: 'Title' }] },
      },
    ]
    expect(normalizePage(page, blocks)).toEqual({
      page_id: '2c4e9c3a-1234-5678-90ab-cdef01234567',
      title: 'Hello',
      url: 'https://notion.so/Hello-2c4e9c3a1234567890abcdef01234567',
      created_time: '2025-01-01T00:00:00.000Z',
      last_edited_time: '2025-02-01T00:00:00.000Z',
      parent_type: 'workspace',
      parent_id: '',
      archived: false,
      created_by: 'user-1',
      last_edited_by: 'user-2',
      properties: {
        Name: { id: 'title', type: 'title', title: [{ plain_text: 'Hello' }] },
      },
      markdown: 'Hi\n\n# Title\n',
      blocks,
    })
  })

  it('fills fields with empty defaults when missing', () => {
    const page = {
      id: '2c4e9c3a-1234-5678-90ab-cdef01234567',
    }
    expect(normalizePage(page, [])).toEqual({
      page_id: '2c4e9c3a-1234-5678-90ab-cdef01234567',
      title: '',
      url: '',
      created_time: '',
      last_edited_time: '',
      parent_type: '',
      parent_id: '',
      archived: false,
      created_by: '',
      last_edited_by: '',
      properties: {},
      markdown: '',
      blocks: [],
    })
  })

  // A database row's cells are its `properties`, and they are the reason the
  // row exists. Without them `cat` on a row answered with metadata and an
  // empty markdown, and the row's actual data was reachable only through
  // `ntn datasources query`.
  it('carries the cells of a database row', () => {
    const page = {
      id: 'row-1',
      parent: { type: 'data_source_id', data_source_id: 'ds-1' },
      properties: {
        Name: { id: 'title', type: 'title', title: [{ plain_text: 'Write spec' }] },
        Priority: { id: 'pri', type: 'number', number: 2 },
      },
    }
    const out = normalizePage(page, [])
    expect(out.parent_id).toBe('ds-1')
    // Kept as Notion's own property objects, not flattened, so the ids and
    // types the schema is written in survive the render.
    expect(out.properties).toEqual(page.properties)
  })

  it('drops child_page and child_database blocks from the body', () => {
    const page = { id: '2c4e9c3a-1234-5678-90ab-cdef01234567' }
    const keep = { object: 'block', id: 'b1', type: 'paragraph', paragraph: { rich_text: [] } }
    const blocks = [
      keep,
      { object: 'block', id: 'b2', type: 'child_page' },
      { object: 'block', id: 'b3', type: 'child_database' },
    ]
    expect(normalizePage(page, blocks).blocks).toEqual([keep])
  })
})

describe('toJsonBytes', () => {
  it('encodes JSON with two-space indent', () => {
    const bytes = toJsonBytes({ a: 1 })
    const decoded = new TextDecoder().decode(bytes)
    expect(decoded).toBe('{\n  "a": 1\n}')
  })
})
