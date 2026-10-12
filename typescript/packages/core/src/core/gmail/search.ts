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

import type { GmailAccessor } from '../../accessor/gmail.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { GoogleApiError } from '../google/client.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import { ROOT } from '../hierarchy/scope.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

// The directories above a message, walked down to its files.
const WALKED: ReadonlySet<string> = new Set([ROOT, 'label', 'day'])

function childOf(directory: PathSpec, name: string): PathSpec {
  return mountedPath(directory, `${directory.mountPath.replace(/\/+$/, '')}/${name}`)
}

/**
 * The message files under `under` whose text holds `text` in any case.
 *
 * Gmail's search reads a message's HTML part and can miss a word of the
 * text/plain body a .gmail.json renders, such as one inside a link or one only
 * that part holds, so it is not asked. The listing fetches every message in
 * full anyway and, with `contentSearch`, keeps each one's rendered text,
 * lowercased; the files are picked from that. null for a text that is not
 * ASCII, whose case a lowercased copy may not keep, when a listing kept no
 * text, or when a listing fails. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: GmailAccessor,
  text: string,
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  if (/[\u0080-\uffff]/.test(text)) return null
  const needle = text.toLowerCase()
  const found: PathSpec[] = []
  const pending = under.filter((scope) => WALKED.has(detectScope(scope).kind))
  try {
    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      for (const listed of await readdir(accessor, current, index)) {
        const child = childOf(current, listed.slice(listed.lastIndexOf('/') + 1))
        const kind = detectScope(child).kind
        if (WALKED.has(kind)) pending.push(child)
        else if (kind === 'message') {
          const entry = await resolveEntry(readdir, accessor, child, index)
          const kept = entry?.extra.text
          if (typeof kept !== 'string') return null
          if (kept.includes(needle)) found.push(child)
        }
      }
    }
  } catch (err) {
    // fetch rejects with a TypeError when the connection fails and a
    // DOMException when its timeout aborts it
    if (
      !(err instanceof GoogleApiError || err instanceof TypeError || err instanceof DOMException)
    ) {
      throw err
    }
    console.warn(`gmail listing failed (${String(err)}); reading every file`)
    return null
  }
  return found
}
