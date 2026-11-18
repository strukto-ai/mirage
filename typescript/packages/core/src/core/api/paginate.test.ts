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
import { PaginationStalledError } from './errors.ts'
import { HAS_MORE_PAGES, cursorItems, hasMoreCursor, offsetCursor } from './paginate.ts'

class Pager {
  readonly cursors: (string | null)[] = []
  constructor(private readonly pages: Record<string, unknown>[]) {}

  fetch = (cursor: string | null): Promise<Record<string, unknown>> => {
    this.cursors.push(cursor)
    const page = this.pages.shift()
    if (page === undefined) throw new Error('fetched past the last page')
    return Promise.resolve(page)
  }
}

describe('cursorItems', () => {
  it.each([0, -1])('does not fetch for a limit of %i', async (limit) => {
    const pager = new Pager([])
    expect(await cursorItems(pager.fetch, limit)).toEqual([])
    expect(pager.cursors).toEqual([])
  })

  it('collects across pages and threads the cursor', async () => {
    const pager = new Pager([
      { results: [{ n: 1 }, { n: 2 }], has_more: true, next_cursor: 'c1' },
      { results: [{ n: 3 }], has_more: false },
    ])
    const items = await cursorItems(pager.fetch)
    expect(items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(pager.cursors).toEqual([null, 'c1'])
  })

  it('maxResults slices the last page', async () => {
    const pager = new Pager([
      { results: [{ n: 1 }, { n: 2 }], has_more: true, next_cursor: 'c1' },
      { results: [{ n: 3 }, { n: 4 }], has_more: true, next_cursor: 'c2' },
    ])
    const items = await cursorItems(pager.fetch, 3)
    expect(items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(pager.cursors).toHaveLength(2)
  })

  it('has_more without a usable cursor stops', async () => {
    expect(await cursorItems(new Pager([{ results: [{ n: 1 }], has_more: true }]).fetch)).toEqual([
      { n: 1 },
    ])
    expect(
      await cursorItems(
        new Pager([{ results: [{ n: 1 }], has_more: true, next_cursor: '' }]).fetch,
      ),
    ).toEqual([{ n: 1 }])
  })

  it('a non-list results field contributes nothing', async () => {
    expect(
      await cursorItems(new Pager([{ results: { weird: 1 }, has_more: false }]).fetch),
    ).toEqual([])
  })

  it('an offset shape reads its own items and cursor', async () => {
    const shape = { itemsKey: 'records', nextCursor: offsetCursor }
    const pager = new Pager([{ records: [{ n: 1 }], offset: 'itr1/rec1' }, { records: [{ n: 2 }] }])
    expect(await cursorItems(pager.fetch, undefined, shape)).toEqual([{ n: 1 }, { n: 2 }])
    expect(pager.cursors).toEqual([null, 'itr1/rec1'])
  })

  it('a null offset ends the walk', async () => {
    // Airtable's comment listing sends "offset": null on its last page.
    const shape = { itemsKey: 'comments', nextCursor: offsetCursor }
    const pager = new Pager([{ comments: [{ n: 1 }], offset: null }])
    expect(await cursorItems(pager.fetch, undefined, shape)).toEqual([{ n: 1 }])
  })

  it('a repeated cursor fails instead of looping', async () => {
    const pager = new Pager([
      { results: [{ n: 1 }], has_more: true, next_cursor: 'c1' },
      { results: [{ n: 2 }], has_more: true, next_cursor: 'c1' },
    ])
    await expect(cursorItems(pager.fetch)).rejects.toThrow(PaginationStalledError)
  })

  it("the default shape is notion's", () => {
    expect(HAS_MORE_PAGES.itemsKey).toBe('results')
    expect(hasMoreCursor({ has_more: true, next_cursor: 'c' })).toBe('c')
    expect(hasMoreCursor({ has_more: false, next_cursor: 'c' })).toBeNull()
    expect(offsetCursor({ offset: '' })).toBeNull()
  })
})
