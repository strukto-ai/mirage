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

import type { IndexEntry } from '../../cache/index/config.ts'
import { CONTENT_HASH } from './constants.ts'

/**
 * A file's content token: its content_hash, or null. The one rule stat,
 * readdir and read all stamp by, so the two sides of a `read: fresh` check
 * are always the same kind. server_modified is no content token: the real
 * service repeats it across same-size rewrites.
 */
export function tokenOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** The content token a listing row carries. */
export function entryToken(entry: IndexEntry): string | null {
  return tokenOf(entry.extra[CONTENT_HASH])
}

/**
 * The content token a download's `Dropbox-API-Result` names. The header
 * carries the file's metadata on a full and on a ranged (206) download
 * alike, so a read stamps the token stat answers with no request of its
 * own. A missing or unreadable header is no token.
 */
export function resultToken(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  let result: unknown
  try {
    result = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null
  return tokenOf((result as Record<string, unknown>)[CONTENT_HASH])
}
