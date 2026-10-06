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
import { SHA1 } from './constants.ts'

/**
 * A file's content token: its sha1, or null. The one rule stat, readdir and
 * read all stamp by, so the two sides of a `read: fresh` check are always the
 * same kind. modified_at is no content token: two same-size edits in one
 * second share it on the real service.
 */
export function tokenOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** The content token a listing row carries. */
export function entryToken(entry: IndexEntry): string | null {
  return tokenOf(entry.extra[SHA1])
}

/**
 * The token a whole read stamps: the listed sha1, if the bytes match it. A
 * download carries no version header, so the bytes are checked against the
 * row they were resolved through. A writer between the listing and the
 * download leaves them disagreeing, and new bytes are never labelled with
 * the old token. `digest` is the SHA-1 hex of the bytes the read returned.
 */
export function readToken(entry: IndexEntry, digest: string): string | null {
  const token = entryToken(entry)
  return token !== null && token === digest ? token : null
}
