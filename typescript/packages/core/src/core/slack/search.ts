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

import type { SlackAccessor } from '../../accessor/slack.ts'
import { NodeSlackTransport, type SlackTransport } from './_client.ts'
import { offsetPages } from './paginate.ts'

const ENC = new TextEncoder()

function searchTransport(accessor: SlackAccessor): SlackTransport {
  if (accessor.transport instanceof NodeSlackTransport) {
    const searchToken = accessor.transport.getSearchToken()
    if (searchToken !== undefined && searchToken !== '') {
      return new NodeSlackTransport(searchToken)
    }
  }
  return accessor.transport
}

export async function searchMessages(
  accessor: SlackAccessor,
  query: string,
  count = 20,
  page = 1,
): Promise<Uint8Array> {
  const params: Record<string, string> = {
    query,
    count: String(count),
    page: String(page),
    sort: 'timestamp',
  }
  const data = await searchTransport(accessor).call('search.messages', params)
  return ENC.encode(JSON.stringify(data))
}

export function searchMessagesStream(
  accessor: SlackAccessor,
  query: string,
  options: { count?: number; startPage?: number; maxPages?: number } = {},
): AsyncIterableIterator<Record<string, unknown>[]> {
  const count = options.count ?? 100
  const baseParams: Record<string, string> = {
    query,
    count: String(count),
    sort: 'timestamp',
  }
  const opts: { startPage?: number; maxPages?: number } = {}
  if (options.startPage !== undefined) opts.startPage = options.startPage
  if (options.maxPages !== undefined) opts.maxPages = options.maxPages
  return offsetPages(
    searchTransport(accessor),
    'search.messages',
    baseParams,
    ['messages', 'pagination', 'page_count'],
    ['messages', 'matches'],
    opts,
  )
}

export async function searchFiles(
  accessor: SlackAccessor,
  query: string,
  count = 20,
  page = 1,
): Promise<Uint8Array> {
  const params: Record<string, string> = {
    query,
    count: String(count),
    page: String(page),
    sort: 'timestamp',
  }
  const data = await searchTransport(accessor).call('search.files', params)
  return ENC.encode(JSON.stringify(data))
}

export function searchFilesStream(
  accessor: SlackAccessor,
  query: string,
  options: { count?: number; startPage?: number; maxPages?: number } = {},
): AsyncIterableIterator<Record<string, unknown>[]> {
  const count = options.count ?? 100
  const baseParams: Record<string, string> = {
    query,
    count: String(count),
    sort: 'timestamp',
  }
  const opts: { startPage?: number; maxPages?: number } = {}
  if (options.startPage !== undefined) opts.startPage = options.startPage
  if (options.maxPages !== undefined) opts.maxPages = options.maxPages
  return offsetPages(
    searchTransport(accessor),
    'search.files',
    baseParams,
    ['files', 'pagination', 'page_count'],
    ['files', 'matches'],
    opts,
  )
}
