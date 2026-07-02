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
  BOX_API_BASE,
  BoxApiError,
  boxAuthHeaders,
  boxGet,
  boxGetBytes,
  boxGetStream,
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

export async function listFolderItems(
  tm: BoxTokenManager,
  folderId: string,
  opts: { limit?: number } = {},
): Promise<BoxItem[]> {
  const limit = opts.limit ?? 1000
  const out: BoxItem[] = []
  let offset = 0
  for (;;) {
    const data = (await boxGet(tm, `${BOX_API_BASE}/folders/${folderId}/items`, {
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

export async function downloadFile(tm: BoxTokenManager, fileId: string): Promise<Uint8Array> {
  return boxGetBytes(tm, `${BOX_API_BASE}/files/${fileId}/content`)
}

export async function* downloadFileStream(
  tm: BoxTokenManager,
  fileId: string,
): AsyncIterable<Uint8Array> {
  for await (const chunk of boxGetStream(tm, `${BOX_API_BASE}/files/${fileId}/content`)) {
    yield chunk
  }
}

interface SearchResponse {
  total_count: number
  entries: BoxItem[]
}

export async function searchItems(
  tm: BoxTokenManager,
  query: string,
  opts: { limit?: number; type?: 'file' | 'folder' } = {},
): Promise<BoxItem[]> {
  const params: Record<string, string | number> = {
    query,
    fields: LIST_FIELDS,
    limit: opts.limit ?? 100,
  }
  if (opts.type !== undefined) params.type = opts.type
  const data = (await boxGet(tm, `${BOX_API_BASE}/search`, params)) as SearchResponse
  return data.entries
}

interface RepresentationsResponse {
  representations?: {
    entries?: {
      representation?: string
      status?: { state?: 'success' | 'pending' | 'none' | 'error' }
      content?: { url_template?: string }
    }[]
  }
}

/**
 * Fetches the auto-extracted plain-text representation of a Box file.
 * Box transcodes .docx / .xlsx / .pptx (and many other formats) server-side
 * into plain text, exposed via the `representations` API. Returns "" if the
 * representation isn't ready or doesn't exist for this file type.
 */
export async function getExtractedText(tm: BoxTokenManager, fileId: string): Promise<string> {
  const headers = await boxAuthHeaders(tm)
  const metaUrl = `${BOX_API_BASE}/files/${fileId}?fields=representations`
  const r = await fetch(metaUrl, {
    headers: { ...headers, 'X-Rep-Hints': '[extracted_text]' },
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new BoxApiError(`Box GET extracted_text meta → ${String(r.status)} ${text}`, r.status)
  }
  const data = (await r.json()) as RepresentationsResponse
  const entry = data.representations?.entries?.find((e) => e.representation === 'extracted_text')
  if (entry === undefined) return ''
  if (entry.status?.state !== 'success') return ''
  const tmpl = entry.content?.url_template
  if (tmpl === undefined) return ''
  const contentUrl = tmpl.replace('{+asset_path}', '')
  const r2 = await fetch(contentUrl, { headers })
  if (!r2.ok) return ''
  return r2.text()
}
