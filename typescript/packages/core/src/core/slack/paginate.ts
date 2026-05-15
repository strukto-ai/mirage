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

import type { SlackTransport } from './_client.ts'

export async function* cursorPages<T = Record<string, unknown>>(
  transport: SlackTransport,
  endpoint: string,
  baseParams: Record<string, string>,
  itemsKey: string,
): AsyncIterableIterator<T[]> {
  let cursor: string | undefined
  for (;;) {
    const params: Record<string, string> = { ...baseParams }
    if (cursor !== undefined && cursor !== '') params.cursor = cursor
    const data = await transport.call(endpoint, params)
    const items = (data[itemsKey] as T[] | undefined) ?? []
    yield items
    const meta = data.response_metadata as { next_cursor?: string } | undefined
    cursor = meta?.next_cursor
    if (cursor === undefined || cursor === '') return
  }
}

function getNested(d: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = d
  for (const k of path) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

export async function* offsetPages<T = Record<string, unknown>>(
  transport: SlackTransport,
  endpoint: string,
  baseParams: Record<string, string>,
  pagesPath: readonly string[],
  itemsPath: readonly string[],
  options: { startPage?: number; maxPages?: number } = {},
): AsyncIterableIterator<T[]> {
  const startPage = options.startPage ?? 1
  const maxPages = options.maxPages
  let page = startPage
  let totalPages: number | undefined
  let fetched = 0
  for (;;) {
    const params: Record<string, string> = { ...baseParams, page: String(page) }
    const data = await transport.call(endpoint, params)
    const items = (getNested(data, itemsPath) as T[] | undefined) ?? []
    yield items
    fetched++
    if (totalPages === undefined) {
      const tp = getNested(data, pagesPath)
      totalPages = typeof tp === 'number' && Number.isFinite(tp) ? tp : 1
    }
    if (page >= totalPages) return
    if (maxPages !== undefined && fetched >= maxPages) return
    page++
  }
}
