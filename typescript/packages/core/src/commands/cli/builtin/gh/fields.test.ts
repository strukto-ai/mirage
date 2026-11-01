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
import type { JsonObject } from '../../../../types.ts'
import {
  exportedNode,
  readRest,
  selection,
  SHARED_FIELDS,
  type Fetch,
  type Field,
} from './fields.ts'

const TABLE: ReadonlyMap<string, Field> = new Map(SHARED_FIELDS)

function comments(bodies: string[], next: string | null): JsonObject {
  return {
    comments: {
      nodes: bodies.map((body) => ({ body })),
      pageInfo: { hasNextPage: next !== null, endCursor: next },
    },
  }
}

describe('gh --json field tables', () => {
  it('asks for each field once, in the order named', () => {
    expect(selection(TABLE, ['title', 'number', 'title'], false)).toBe('title,number')
  })

  it('leaves out of a view what the view reads apart', () => {
    expect(selection(TABLE, ['title', 'projectItems'], true)).toBe('title')
    expect(selection(TABLE, ['title', 'projectItems'], false)).toMatch(
      /^title,projectItems\(first:100\)/,
    )
  })

  it('reads a paged connection to its end through the fetch it is given', async () => {
    const node = comments(['a'], 'c1')
    const asked: [string, string | undefined][] = []
    const fetch: Fetch = (select, cursor) => {
      asked.push([select, cursor])
      return Promise.resolve(comments(['b'], null))
    }
    await readRest(TABLE, node, ['comments'], fetch)
    const out = exportedNode(TABLE, node, ['comments']).comments as { body: string }[]
    expect(out.map((comment) => comment.body)).toEqual(['a', 'b'])
    expect(asked).toHaveLength(1)
    expect(asked[0]?.[0]).toContain('comments(first: 100, after: $endCursor)')
    expect(asked[0]?.[1]).toBe('c1')
  })

  it('refuses a cursor that does not advance', async () => {
    const fetch: Fetch = () => Promise.resolve(comments(['b'], 'c1'))
    await expect(readRest(TABLE, comments(['a'], 'c1'), ['comments'], fetch)).rejects.toThrow(
      'non-advancing cursor',
    )
  })

  it('reads project items apart, and none where the token has no projects scope', async () => {
    const items: Fetch = (select) => {
      expect(select).toMatch(/^projectItems\(first: 100\)/)
      return Promise.resolve({
        projectItems: {
          nodes: [{ project: { title: 'Roadmap' }, status: { optionId: 'o1', name: 'Todo' } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      })
    }
    const node = await readRest(TABLE, {}, ['projectItems'], items)
    expect(exportedNode(TABLE, node, ['projectItems'])).toEqual({
      projectItems: [{ status: { optionId: 'o1', name: 'Todo' }, title: 'Roadmap' }],
    })
    const unscoped: Fetch = () =>
      Promise.reject(
        new Error(
          "GraphQL: The 'id' field requires one of the following scopes: ['read:project'], but",
        ),
      )
    const none = await readRest(TABLE, {}, ['projectItems'], unscoped)
    expect(exportedNode(TABLE, none, ['projectItems'])).toEqual({ projectItems: [] })
  })
})
