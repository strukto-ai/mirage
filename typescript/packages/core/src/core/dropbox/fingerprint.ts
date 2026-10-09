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

import type { LiveVersion } from '../../cache/types.ts'
import type { DropboxEntry } from './api.ts'
import { CONTENT_HASH, RESULT_HEADER, REV } from './constants.ts'

/**
 * A file's content token: its content_hash, or null. stat, readdir and read
 * all stamp by this, so both sides of a `read: fresh` check are the same kind.
 * server_modified is no token: Dropbox repeats it across same-size rewrites.
 */
export function tokenOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** A looked-up entry's live tokens, null when it is no file. Mirrors Python's `live_of`. */
export function liveOf(entry: DropboxEntry | null): LiveVersion | null {
  if (entry?.['.tag'] !== 'file') return null
  return { content: tokenOf(entry[CONTENT_HASH]), native: tokenOf(entry[REV]) }
}

/**
 * The content token a download's `Dropbox-API-Result` names. Dropbox sends the
 * file's metadata there on a full and on a ranged (206) download, so a read
 * stamps the token with no extra request.
 */
export function resultToken(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  let result: unknown
  try {
    result = JSON.parse(raw)
  } catch {
    result = null
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    console.warn(`unreadable ${RESULT_HEADER} header: ${raw}`)
    return null
  }
  return tokenOf((result as Record<string, unknown>)[CONTENT_HASH])
}
