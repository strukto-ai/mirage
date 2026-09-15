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

import { dropboxRpc } from './client.ts'
import type { DropboxTokenManager } from './client.ts'

type DropboxEntryTag = 'file' | 'folder' | 'deleted'

export interface DropboxEntry {
  '.tag': DropboxEntryTag
  id?: string
  name: string
  path_lower?: string
  path_display?: string
  size?: number
  client_modified?: string
  server_modified?: string
  rev?: string
  content_hash?: string
}

interface ListFolderResponse {
  entries: DropboxEntry[]
  cursor: string
  has_more: boolean
}

interface SearchMatchV2 {
  match_type?: { '.tag': string }
  metadata?: { metadata: DropboxEntry }
  highlight_spans?: { highlight_str: string; is_highlighted: boolean }[]
}

interface SearchResponseV2 {
  matches?: SearchMatchV2[]
  has_more?: boolean
  cursor?: string
}

/**
 * List a folder's entries, following every continuation cursor.
 *
 * `/` and `''` both mean the account root.
 */
export async function listFolder(
  tm: DropboxTokenManager,
  path: string,
  opts: {
    recursive?: boolean
    /** Entries per request. */
    pageSize?: number
    /**
     * Stop once this many entries are in hand and do not request another
     * page. An emptiness probe wants one entry, and `pageSize` alone
     * cannot express that: it caps the page, not the walk, so a small
     * page turned a listing of a large folder into many requests instead
     * of fewer.
     */
    limit?: number | null
  } = {},
): Promise<DropboxEntry[]> {
  const apiPath = path === '/' || path === '' ? '' : path
  const recursive = opts.recursive === true
  const pageSize = opts.pageSize ?? 2000
  const limit = opts.limit ?? null
  const out: DropboxEntry[] = []
  let resp = (await dropboxRpc(tm, '/files/list_folder', {
    path: apiPath,
    recursive,
    limit: limit === null ? pageSize : Math.min(pageSize, limit),
  })) as ListFolderResponse
  out.push(...resp.entries)
  while (resp.has_more) {
    if (limit !== null && out.length >= limit) break
    resp = (await dropboxRpc(tm, '/files/list_folder/continue', {
      cursor: resp.cursor,
    })) as ListFolderResponse
    out.push(...resp.entries)
  }
  return out
}

export interface ListFolderState {
  entries: DropboxEntry[]
  cursor: string
}

/**
 * List a folder and keep the cursor the last page handed back.
 */
export async function listFolderState(
  tm: DropboxTokenManager,
  path: string,
  opts: { recursive?: boolean; pageSize?: number } = {},
): Promise<ListFolderState> {
  const apiPath = path === '/' || path === '' ? '' : path
  const recursive = opts.recursive === true
  const pageSize = opts.pageSize ?? 2000
  const out: DropboxEntry[] = []
  let resp = (await dropboxRpc(tm, '/files/list_folder', {
    path: apiPath,
    recursive,
    limit: pageSize,
  })) as ListFolderResponse
  out.push(...resp.entries)
  while (resp.has_more) {
    resp = (await dropboxRpc(tm, '/files/list_folder/continue', {
      cursor: resp.cursor,
    })) as ListFolderResponse
    out.push(...resp.entries)
  }
  return { entries: out, cursor: resp.cursor }
}

/**
 * Replay changes since `cursor`, following every continuation page.
 */
export async function continueFolder(
  tm: DropboxTokenManager,
  cursor: string,
): Promise<ListFolderState> {
  const out: DropboxEntry[] = []
  let resp = (await dropboxRpc(tm, '/files/list_folder/continue', {
    cursor,
  })) as ListFolderResponse
  out.push(...resp.entries)
  while (resp.has_more) {
    resp = (await dropboxRpc(tm, '/files/list_folder/continue', {
      cursor: resp.cursor,
    })) as ListFolderResponse
    out.push(...resp.entries)
  }
  return { entries: out, cursor: resp.cursor }
}

export async function getMetadata(tm: DropboxTokenManager, path: string): Promise<DropboxEntry> {
  return (await dropboxRpc(tm, '/files/get_metadata', { path })) as DropboxEntry
}

export async function createFolder(tm: DropboxTokenManager, path: string): Promise<void> {
  await dropboxRpc(tm, '/files/create_folder_v2', { path, autorename: false })
}

export async function deletePath(tm: DropboxTokenManager, path: string): Promise<void> {
  await dropboxRpc(tm, '/files/delete_v2', { path })
}

export async function movePath(tm: DropboxTokenManager, from: string, to: string): Promise<void> {
  await dropboxRpc(tm, '/files/move_v2', { from_path: from, to_path: to, autorename: false })
}

export async function copyPath(tm: DropboxTokenManager, from: string, to: string): Promise<void> {
  await dropboxRpc(tm, '/files/copy_v2', { from_path: from, to_path: to, autorename: false })
}

export const SEARCH_PAGE = 1000
// search_v2 + search/continue_v2 serve at most 10,000 matches total; a
// result set that hits the ceiling may be incomplete and must not be used
// to narrow a scan.
export const MAX_SEARCH_MATCHES = 10_000

export interface SearchFilesResult {
  paths: [string, string][]
  truncated: boolean
}

/**
 * Collect `[path_lower, path_display]` file matches for a search query.
 *
 * Pages through `/files/search_v2` and `/files/search/continue_v2`,
 * deduplicating across pages (the API may repeat results between pages).
 * `path: ''` searches the whole account. `truncated` reports whether the
 * result hit the API's 10,000-match ceiling (a truncated set is not a
 * trustworthy superset).
 */
export async function searchFiles(
  tm: DropboxTokenManager,
  query: string,
  opts: { path?: string; filenameOnly?: boolean } = {},
): Promise<SearchFilesResult> {
  const options: Record<string, unknown> = {
    max_results: SEARCH_PAGE,
    file_status: 'active',
    filename_only: opts.filenameOnly === true,
  }
  if (opts.path !== undefined && opts.path !== '') options.path = opts.path
  let resp = (await dropboxRpc(tm, '/files/search_v2', { query, options })) as SearchResponseV2
  const seen = new Set<string>()
  const paths: [string, string][] = []
  for (;;) {
    for (const m of resp.matches ?? []) {
      const entry = m.metadata?.metadata
      if (entry?.['.tag'] !== 'file') continue
      const lower = entry.path_lower ?? ''
      const display = entry.path_display ?? lower
      if (lower === '' || seen.has(lower)) continue
      seen.add(lower)
      paths.push([lower, display])
    }
    if (paths.length >= MAX_SEARCH_MATCHES) return { paths, truncated: true }
    if (resp.has_more !== true || resp.cursor === undefined) return { paths, truncated: false }
    resp = (await dropboxRpc(tm, '/files/search/continue_v2', {
      cursor: resp.cursor,
    })) as SearchResponseV2
  }
}
