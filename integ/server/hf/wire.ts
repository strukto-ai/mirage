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

import { RUN_QUERY, rangeHeaderOf } from '../kit/typescript/index.ts'
import type { Ctx, Headers, JsonValue, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { serveHash } from './xet.ts'

export interface HfObject {
  path: string
  content: Uint8Array
  etag: string
  modified: string
}

export function strip(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '')
}

// The Hub names a missing file EntryNotFound, and that code is what tells
// it apart from a 404 about the bucket or a CDN hop.
export function notFound(): Reply {
  return {
    status: 404,
    body: { error: 'Entry not found' },
    headers: { 'X-Error-Code': 'EntryNotFound', 'X-Error-Message': 'File not found' },
  }
}

/**
 * A body reply for a content route, clamping a `Range` instead of refusing it.
 *
 * This is the one place a fake in this repo does NOT use the kit's `rangeReply`,
 * and the difference is the whole reason it exists: `rangeReply` answers 416
 * when the first byte asked for is at or past EOF, which is what RFC 7233 says
 * and what a real CDN does, and opendal's hf service reads that 416 as a
 * PERMANENT read failure and gives up. mirage's own past-EOF read is meant to
 * come back short rather than fail (`range_offset_past_eof_is_empty`), so this
 * clamps the window and answers a 206 carrying however many bytes are left,
 * which is zero. The hf backend's behaviour against a real Hub past EOF is
 * tracked separately; a fake that refused the read here would only hide it
 * behind a crash.
 *
 * Args:
 *   headers (Headers): the request headers, read for `Range`.
 *   content (Uint8Array): the whole content.
 *   contentRange (boolean): whether to answer a `Content-Range` header.
 */
export function clampedReply(headers: Headers, content: Uint8Array, contentRange: boolean): Reply {
  const header = rangeHeaderOf(headers)
  if (header === undefined || !header.startsWith('bytes=')) {
    return { status: 200, body: Buffer.from(content) }
  }
  const [startRaw = '', endRaw = ''] = header.slice('bytes='.length).split('-')
  const start = startRaw === '' ? 0 : Number(startRaw)
  const end = Math.min(endRaw === '' ? content.length : Number(endRaw) + 1, content.length)
  const body = Buffer.from(content.slice(start, Math.max(start, end)))
  const extra = contentRange
    ? { 'Content-Range': `bytes ${String(start)}-${String(end - 1)}/${String(content.length)}` }
    : {}
  return { status: 206, body, headers: { 'Accept-Ranges': 'bytes', ...extra } }
}

/**
 * An absolute URL back to this fake, carrying the caller's run.
 *
 * The run has to ride the URL rather than a header, because the client follows
 * these links with no headers of its own at all (probed: the CAS data fetch
 * sends not even an `Authorization`). A run is a whole SQLite file, so reaching
 * the wrong one finds nothing. The tenant does not ride along, because every
 * link built here addresses content by hash, and content is not tenanted.
 *
 * Args:
 *   ctx (Ctx<C>): the request being answered.
 *   path (string): the absolute path to link to.
 */
export function selfUrl(ctx: Ctx<C>, path: string): string {
  const q = new URLSearchParams({ [RUN_QUERY]: ctx.run })
  return `${ctx.url.origin}${path}?${q.toString()}`
}

export function fileEntry(row: HfObject): Record<string, JsonValue> {
  return {
    type: 'file',
    path: row.path,
    size: row.content.length,
    xetHash: serveHash(row.content),
    uploadedAt: row.modified,
  }
}

export function dirEntry(path: string, modified: string): Record<string, JsonValue> {
  return { type: 'directory', path, uploadedAt: modified }
}

/**
 * The vendor's tree listing for one prefix.
 *
 * The real Hub answers a missing subpath with 200 and an empty list, flat file
 * entries when `recursive`, and files plus one directory row per immediate
 * child folder otherwise.
 *
 * Args:
 *   rows (HfObject[]): every object in the bucket.
 *   prefix (string): the path being listed, possibly empty for the root.
 *   recursive (boolean): whether to flatten the whole subtree.
 */
export function treeEntries(
  rows: HfObject[],
  prefix: string,
  recursive: boolean,
): Record<string, JsonValue>[] {
  const base = strip(prefix)
  const baseSlash = base === '' ? '' : `${base}/`
  const entries = new Map<string, Record<string, JsonValue>>()
  for (const row of rows) {
    if (base !== '' && !row.path.startsWith(baseSlash)) continue
    if (recursive) {
      entries.set(row.path, fileEntry(row))
      continue
    }
    const rest = row.path.slice(baseSlash.length)
    const cut = rest.indexOf('/')
    if (cut === -1) {
      entries.set(row.path, fileEntry(row))
      continue
    }
    const child = baseSlash + rest.slice(0, cut)
    if (!entries.has(child)) entries.set(child, dirEntry(child, row.modified))
  }
  return [...entries.values()].sort((a, b) =>
    String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0,
  )
}
