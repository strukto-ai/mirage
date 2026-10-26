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

import type { PageFetch } from '../../types.ts'
import { PaginationStalledError } from './errors.ts'

/** Notion's continuation: `next_cursor`, while `has_more` holds. */
export function hasMoreCursor(data: Readonly<Record<string, unknown>>): string | null {
  const cursor = data.next_cursor
  if (data.has_more !== true || typeof cursor !== 'string' || cursor === '') return null
  return cursor
}

/**
 * Airtable's continuation: an `offset` on every page but the last. Records
 * drop the key on the last page and comments send it as null; both read as
 * the end.
 */
export function offsetCursor(data: Readonly<Record<string, unknown>>): string | null {
  const cursor = data.offset
  return typeof cursor === 'string' && cursor !== '' ? cursor : null
}

/** Where a cursor-paginated reply keeps its items and its cursor. */
export interface PageShape {
  readonly itemsKey: string
  readonly nextCursor: (data: Readonly<Record<string, unknown>>) => string | null
}

export const HAS_MORE_PAGES: PageShape = { itemsKey: 'results', nextCursor: hasMoreCursor }

/**
 * Collect every item from a cursor-paginated endpoint.
 *
 * The default reply protocol is the `results` / `has_more` / `next_cursor`
 * shape (Notion's); `shape` names another one (an Airtable list is `records`
 * plus an `offset` that vanishes on the last page). Where the resume cursor
 * goes on the request — a `start_cursor` body field, a query parameter — is
 * the caller's, so `fetchPage` owns that merge. Pagination stops when the
 * reply stops naming a cursor, and fails with `PaginationStalledError` when
 * it names one it already sent. `maxResults` stops early and slices the tail
 * of the last page.
 */
export async function cursorItems(
  fetchPage: PageFetch,
  maxResults?: number,
  shape: PageShape = HAS_MORE_PAGES,
): Promise<unknown[]> {
  const collected: unknown[] = []
  for await (const page of cursorPages(fetchPage, shape)) {
    for (const item of page) collected.push(item)
    if (maxResults !== undefined && collected.length >= maxResults) {
      return collected.slice(0, maxResults)
    }
  }
  return collected
}

/**
 * Each page's items from a cursor-paginated endpoint, the next page fetched
 * only when the caller pulls it. Fails with `PaginationStalledError` when the
 * reply names a cursor it already sent. Mirrors Python's `cursor_pages`.
 */
export async function* cursorPages(
  fetchPage: PageFetch,
  shape: PageShape = HAS_MORE_PAGES,
): AsyncGenerator<unknown[], void> {
  const seen = new Set<string>()
  let cursor: string | null = null
  for (;;) {
    const data = await fetchPage(cursor)
    const page = data[shape.itemsKey]
    yield Array.isArray(page) ? (page as unknown[]) : []
    cursor = shape.nextCursor(data)
    if (cursor === null) return
    if (seen.has(cursor)) throw new PaginationStalledError(cursor)
    seen.add(cursor)
  }
}
