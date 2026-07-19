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

import { dropboxRpc } from './_client.ts'
import type { DropboxTokenManager } from './_client.ts'

export type DropboxEntryTag = 'file' | 'folder' | 'deleted'

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

export async function listFolder(
  tm: DropboxTokenManager,
  path: string,
  opts: { recursive?: boolean; limit?: number } = {},
): Promise<DropboxEntry[]> {
  const apiPath = path === '/' || path === '' ? '' : path
  const recursive = opts.recursive === true
  const limit = opts.limit ?? 2000
  const out: DropboxEntry[] = []
  let resp = (await dropboxRpc(tm, '/files/list_folder', {
    path: apiPath,
    recursive,
    limit,
  })) as ListFolderResponse
  out.push(...resp.entries)
  while (resp.has_more) {
    resp = (await dropboxRpc(tm, '/files/list_folder/continue', {
      cursor: resp.cursor,
    })) as ListFolderResponse
    out.push(...resp.entries)
  }
  return out
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

export async function searchFiles(
  tm: DropboxTokenManager,
  query: string,
  opts: { path?: string; maxResults?: number; fileStatus?: 'active' | 'deleted' } = {},
): Promise<DropboxEntry[]> {
  const max = opts.maxResults ?? 100
  const body: Record<string, unknown> = {
    query,
    options: {
      max_results: max,
      file_status: opts.fileStatus ?? 'active',
    },
  }
  if (opts.path !== undefined && opts.path !== '' && opts.path !== '/') {
    ;(body.options as Record<string, unknown>).path = opts.path
  }
  const resp = (await dropboxRpc(tm, '/files/search_v2', body)) as SearchResponseV2
  const matches = resp.matches ?? []
  const entries: DropboxEntry[] = []
  for (const m of matches) {
    const entry = m.metadata?.metadata
    if (entry === undefined) continue
    if (entry['.tag'] !== 'deleted') entries.push(entry)
  }
  return entries
}
