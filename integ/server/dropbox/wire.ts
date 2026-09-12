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

import { createHash } from 'node:crypto'
import type { JsonValue, Reply } from '../kit/typescript/index.ts'

export interface Item {
  path: string
  isFolder: boolean
  content: Uint8Array | null
  modified: string | null
}

// The vendor reports a failed RPC as a 409 carrying `error_summary`, whatever
// the failure was; only a malformed argument is a 400. The client tells the
// two apart by status, so neither collapses into the other.
export function apiError(summary: string): Reply {
  return { status: 409, body: { error_summary: summary } }
}

export function malformed(): Reply {
  return { status: 400, body: { error_summary: 'path/malformed' } }
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function dirname(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '' : path.slice(0, cut)
}

// Real Dropbox derives content_hash from a SHA-256 over 4 MiB block digests;
// the fake hashes the whole content instead, which is opaque to a client that
// only ever compares it for equality, and keeps the property that matters:
// identical bytes hash identically.
export function deletedEntry(path: string): JsonValue {
  return {
    '.tag': 'deleted',
    name: basename(path),
    path_lower: path.toLowerCase(),
    path_display: path,
  }
}

export function entryFor(item: Item): JsonValue {
  const name = basename(item.path)
  if (item.isFolder) {
    return {
      '.tag': 'folder',
      id: `id:${item.path}`,
      name,
      path_lower: item.path.toLowerCase(),
      path_display: item.path,
    }
  }
  const data = item.content ?? new Uint8Array(0)
  const digest = createHash('sha256').update(data).digest('hex')
  return {
    '.tag': 'file',
    id: `id:${item.path}`,
    name,
    path_lower: item.path.toLowerCase(),
    path_display: item.path,
    size: data.length,
    server_modified: item.modified,
    rev: digest.slice(0, 16),
    content_hash: digest,
  }
}

export function matchTag(nameHit: boolean, contentHit: boolean): string {
  if (nameHit && contentHit) return 'filename_and_content'
  return nameHit ? 'filename' : 'file_content'
}

export function searchMatch(item: Item, tag: string): JsonValue {
  return {
    match_type: { '.tag': tag },
    metadata: { '.tag': 'metadata', metadata: entryFor(item) },
  }
}

// Content matches whole words, mirroring the vendor's index, so `foo` never
// matches `foobar`. Modelling that is what lets the battery prove grep/rg
// push-down cannot silently drop substring matches; a substring fake would
// agree with a full scan and test nothing. Names stay substring: extra hits
// there only over-fetch, which the local scan filters.
export function wholeWordHit(query: string, text: string): boolean {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text)
}
