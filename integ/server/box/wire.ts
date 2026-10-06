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

import type { JsonValue, Reply } from '../kit/typescript/index.ts'

export interface Item {
  id: string
  type: string
  name: string
  parentId: string | null
  modified: string
  content: Uint8Array | null
  sha1: string | null
  version: number
  url: string | null
  extractedText: string | null
}

// Real Box's error envelope. The `code` is what a client switches on, so it is
// carried rather than derived from the status.
export function boxError(status: number, code: string, message: string): Reply {
  return { status, body: { type: 'error', status, code, message } }
}

export const notFound = (what: string): Reply => boxError(404, 'not_found', `${what} not found`)
export const nameInUse = (name: string): Reply =>
  boxError(409, 'item_name_in_use', `${name} already exists`)
export const unauthorized = (): Reply => boxError(401, 'unauthorized', 'missing bearer token')

export function render(item: Item): JsonValue {
  const out: Record<string, JsonValue> = {
    type: item.type,
    id: item.id,
    name: item.name,
    modified_at: item.modified,
    parent: item.parentId === null ? null : { type: 'folder', id: item.parentId },
  }
  if (item.type === 'file') {
    out.size = (item.content ?? new Uint8Array(0)).length
    out.sha1 = item.sha1
    out.etag = String(item.version)
  } else {
    out.etag = '0'
  }
  return out
}

// The chain from the account root down to an item's parent, the vendor's
// path_collection shape, shared by every row that places an item.
export function pathCollection(ancestors: Item[]): JsonValue {
  return {
    total_count: ancestors.length,
    entries: ancestors.map((a) => ({ type: 'folder', id: a.id, name: a.name })),
  }
}

// The vendor's search rows carry the ancestor chain instead of a parent
// reference, so a consumer can render a path without a call per level.
export function searchEntry(item: Item, ancestors: Item[]): JsonValue {
  return {
    type: item.type,
    id: item.id,
    name: item.name,
    path_collection: pathCollection(ancestors),
  }
}

// An event's `source` is the full item plus the chain that places it, the
// shape the vendor sends on the user stream.
export function eventSource(item: Item, ancestors: Item[]): JsonValue {
  return {
    ...(render(item) as Record<string, JsonValue>),
    path_collection: pathCollection(ancestors),
  }
}

// A trashed item as the vendor renders one: its path_collection is the Trash,
// never the folder it was trashed from.
export function trashedSource(item: Item): JsonValue {
  return {
    ...(render(item) as Record<string, JsonValue>),
    item_status: 'trashed',
    path_collection: { total_count: 1, entries: [{ type: 'folder', id: '1', name: 'Trash' }] },
  }
}

export function eventEntry(
  seq: number,
  eventType: string,
  source: string,
  createdAt: string,
): JsonValue {
  return {
    type: 'event',
    event_id: `event-${String(seq)}`,
    event_type: eventType,
    created_at: createdAt,
    source: JSON.parse(source) as JsonValue,
  }
}

// Real Box indexes content by whole words, so `foo` never matches `foobar`.
// Modelling that is what lets the battery prove grep/rg push-down cannot
// silently drop substring matches; a substring fake would agree with a full
// scan and test nothing. Names stay substring: extra hits there only
// over-fetch, which the local scan filters.
export function wholeWordHit(query: string, text: string): boolean {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text)
}

// Folders first, then files, each alphabetically -- the vendor's own order.
export function listOrder(a: Item, b: Item): number {
  const af = a.type === 'folder' ? 0 : 1
  const bf = b.type === 'folder' ? 0 : 1
  if (af !== bf) return af - bf
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}
