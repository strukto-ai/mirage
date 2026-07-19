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

import {
  boxDelete,
  boxGet,
  boxGetBytes,
  boxGetStream,
  boxPostJson,
  boxPutJson,
  boxUploadMultipart,
} from './_client.ts'
import type { BoxTokenManager } from './_client.ts'

export type BoxItemType = 'file' | 'folder' | 'web_link'

export interface BoxItem {
  type: BoxItemType
  id: string
  name: string
  size?: number
  modified_at?: string
  etag?: string
  sha1?: string
  parent?: { id: string; type: 'folder' } | null
}

interface ListItemsResponse {
  total_count: number
  entries: BoxItem[]
  offset: number
  limit: number
}

const LIST_FIELDS = 'id,name,type,size,modified_at,etag,sha1,parent'
const SEARCH_FIELDS = 'id,name,type,path_collection'
const SEARCH_PAGE = 200
// Box search serves at most 10,000 matches across all pages; a result set
// that reaches the ceiling may be incomplete and must not narrow a scan.
const MAX_SEARCH_MATCHES = 10_000

interface BoxPathCollectionEntry {
  type: 'folder'
  id: string
  name: string
}

export interface BoxSearchItem {
  type: BoxItemType
  id: string
  name: string
  path_collection?: { total_count: number; entries: BoxPathCollectionEntry[] }
}

export async function listFolderItems(
  tm: BoxTokenManager,
  folderId: string,
  opts: { limit?: number } = {},
): Promise<BoxItem[]> {
  const limit = opts.limit ?? 1000
  const out: BoxItem[] = []
  let offset = 0
  for (;;) {
    const data = (await boxGet(tm, `${tm.apiBase}/folders/${folderId}/items`, {
      fields: LIST_FIELDS,
      limit,
      offset,
    })) as ListItemsResponse
    out.push(...data.entries)
    offset += data.entries.length
    if (offset >= data.total_count || data.entries.length === 0) {
      break
    }
  }
  return out
}

export async function getFolderInfo(tm: BoxTokenManager, folderId: string): Promise<BoxItem> {
  return (await boxGet(tm, `${tm.apiBase}/folders/${folderId}`)) as BoxItem
}

export async function downloadFile(tm: BoxTokenManager, fileId: string): Promise<Uint8Array> {
  return boxGetBytes(tm, `${tm.apiBase}/files/${fileId}/content`)
}

export async function* downloadFileStream(
  tm: BoxTokenManager,
  fileId: string,
): AsyncIterable<Uint8Array> {
  for await (const chunk of boxGetStream(tm, `${tm.apiBase}/files/${fileId}/content`)) {
    yield chunk
  }
}

interface SearchResponse {
  total_count: number
  entries: BoxSearchItem[]
}

/**
 * Name+content search scoped to a folder subtree. Pages Box `/search` with
 * `ancestor_folder_ids` scoping and `content_types=name,file_content` so the
 * query matches file names and the server-indexed body text. Each returned
 * item carries `path_collection` (its ancestor chain) for mount-relative path
 * reconstruction. The boolean is true when the result reached the
 * 10,000-match ceiling (a truncated set is not a trustworthy superset).
 */
export async function searchContent(
  tm: BoxTokenManager,
  query: string,
  ancestorFolderId: string,
): Promise<{ items: BoxSearchItem[]; truncated: boolean }> {
  const out: BoxSearchItem[] = []
  let offset = 0
  for (;;) {
    const data = (await boxGet(tm, `${tm.apiBase}/search`, {
      query,
      ancestor_folder_ids: ancestorFolderId,
      content_types: 'name,file_content',
      type: 'file',
      fields: SEARCH_FIELDS,
      limit: SEARCH_PAGE,
      offset,
    })) as SearchResponse
    out.push(...data.entries)
    offset += data.entries.length
    if (out.length >= MAX_SEARCH_MATCHES) return { items: out, truncated: true }
    if (offset >= data.total_count || data.entries.length === 0) {
      return { items: out, truncated: false }
    }
  }
}

export async function uploadNewFile(
  tm: BoxTokenManager,
  parentId: string,
  name: string,
  data: Uint8Array,
): Promise<BoxItem> {
  return (await boxUploadMultipart(
    tm,
    `${tm.apiBase}/files/content`,
    { name, parent: { id: parentId } },
    name,
    data,
  )) as BoxItem
}

export async function uploadFileVersion(
  tm: BoxTokenManager,
  fileId: string,
  name: string,
  data: Uint8Array,
): Promise<BoxItem> {
  return (await boxUploadMultipart(
    tm,
    `${tm.apiBase}/files/${fileId}/content`,
    { name },
    name,
    data,
  )) as BoxItem
}

export async function createFolder(
  tm: BoxTokenManager,
  parentId: string,
  name: string,
): Promise<BoxItem> {
  return (await boxPostJson(tm, `${tm.apiBase}/folders`, {
    name,
    parent: { id: parentId },
  })) as BoxItem
}

export async function deleteFile(tm: BoxTokenManager, fileId: string): Promise<void> {
  await boxDelete(tm, `${tm.apiBase}/files/${fileId}`)
}

export async function deleteFolder(
  tm: BoxTokenManager,
  folderId: string,
  recursive = true,
): Promise<void> {
  await boxDelete(tm, `${tm.apiBase}/folders/${folderId}`, {
    recursive: recursive ? 'true' : 'false',
  })
}

export async function updateFile(
  tm: BoxTokenManager,
  fileId: string,
  opts: { name?: string; parentId?: string },
): Promise<BoxItem> {
  const body: Record<string, unknown> = {}
  if (opts.name !== undefined) body.name = opts.name
  if (opts.parentId !== undefined) body.parent = { id: opts.parentId }
  return (await boxPutJson(tm, `${tm.apiBase}/files/${fileId}`, body)) as BoxItem
}

export async function updateFolder(
  tm: BoxTokenManager,
  folderId: string,
  opts: { name?: string; parentId?: string },
): Promise<BoxItem> {
  const body: Record<string, unknown> = {}
  if (opts.name !== undefined) body.name = opts.name
  if (opts.parentId !== undefined) body.parent = { id: opts.parentId }
  return (await boxPutJson(tm, `${tm.apiBase}/folders/${folderId}`, body)) as BoxItem
}

export async function copyFile(
  tm: BoxTokenManager,
  fileId: string,
  parentId: string,
  name?: string,
): Promise<BoxItem> {
  const body: Record<string, unknown> = { parent: { id: parentId } }
  if (name !== undefined) body.name = name
  return (await boxPostJson(tm, `${tm.apiBase}/files/${fileId}/copy`, body)) as BoxItem
}

export async function copyFolder(
  tm: BoxTokenManager,
  folderId: string,
  parentId: string,
  name?: string,
): Promise<BoxItem> {
  const body: Record<string, unknown> = { parent: { id: parentId } }
  if (name !== undefined) body.name = name
  return (await boxPostJson(tm, `${tm.apiBase}/folders/${folderId}/copy`, body)) as BoxItem
}
