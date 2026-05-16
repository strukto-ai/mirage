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

import type { DiscordAccessor } from '../../accessor/discord.ts'

export interface AfterIdPagesOpts {
  endpoint: string
  baseParams?: Record<string, string | number>
  lastIdFn: (item: Record<string, unknown>) => string
  pageSize?: number
  startAfter?: string
}

export async function* afterIdPages<T extends Record<string, unknown>>(
  accessor: DiscordAccessor,
  opts: AfterIdPagesOpts,
): AsyncIterableIterator<T[]> {
  const { endpoint, baseParams = {}, lastIdFn, pageSize = 100, startAfter = '0' } = opts
  let last = startAfter
  for (;;) {
    const params: Record<string, string | number> = { ...baseParams, after: last, limit: pageSize }
    const data = (await accessor.transport.call('GET', endpoint, params)) as T[] | null
    if (!Array.isArray(data) || data.length === 0) return
    yield data
    if (data.length < pageSize) return
    const tail = data[data.length - 1]
    if (tail === undefined) return
    last = lastIdFn(tail)
  }
}

function getNested(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

export interface OffsetPagesOpts {
  endpoint: string
  baseParams?: Record<string, string | number>
  itemsPath: readonly string[]
  totalKey?: string
  pageSize?: number
  startOffset?: number
  maxPages?: number
}

export async function* offsetPages<T>(
  accessor: DiscordAccessor,
  opts: OffsetPagesOpts,
): AsyncIterableIterator<T[]> {
  const {
    endpoint,
    baseParams = {},
    itemsPath,
    totalKey = 'total_results',
    pageSize = 25,
    startOffset = 0,
    maxPages,
  } = opts
  let offset = startOffset
  let total: number | null = null
  let fetched = 0
  for (;;) {
    const params: Record<string, string | number> = { ...baseParams, offset }
    const data = (await accessor.transport.call('GET', endpoint, params)) as Record<
      string,
      unknown
    > | null
    if (data === null || typeof data !== 'object') return
    const items = (getNested(data, itemsPath) as T[] | null) ?? []
    if (items.length === 0) return
    yield items
    fetched += 1
    if (total === null) {
      const t = data[totalKey]
      total = typeof t === 'number' ? t : 0
    }
    offset += pageSize
    if (offset >= total) return
    if (maxPages !== undefined && fetched >= maxPages) return
  }
}
