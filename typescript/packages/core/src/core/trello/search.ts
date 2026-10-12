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

import type { TrelloAccessor } from '../../accessor/trello.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { isFsError } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { mayHold, recordQueries } from '../../utils/record_search.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import { ROOT } from '../hierarchy/scope.ts'
import { TrelloApiError, searchCards } from './client.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'
import { rstripSlash } from '../../utils/slash.ts'

// The most cards one search answers; a full page may have left some out.
export const SEARCH_LIMIT = 1000

// The words a card's JSON holds whatever its text says: its letter-only key
// names and the JSON literals. Every other field Trello does not search is
// checked against the listing (`unsearchedText`).
export const RECORD_KEYS: ReadonlySet<string> = new Set([
  'due',
  'closed',
  'desc',
  'url',
  'true',
  'false',
  'null',
])

// The directories above a card, walked down to its cards.
export const WALKED: ReadonlySet<string> = new Set([
  ROOT,
  'workspaces',
  'workspace',
  'boards',
  'board',
  'lists',
  'list',
])

// Each card directory under `scope`; null for a scope inside a card.
async function cards(
  accessor: TrelloAccessor,
  scope: PathSpec,
  index: IndexCacheStore | undefined,
): Promise<PathSpec[] | null> {
  const kind = detectScope(scope).kind
  if (kind === 'card') return [scope]
  if (kind === 'card_json' || kind === 'comments_jsonl') return null
  if (!WALKED.has(kind) && kind !== 'cards') return []
  const base = rstripSlash(scope.mountPath)
  const found: PathSpec[] = []
  for (const listed of await readdir(accessor, scope, index)) {
    const leaf = listed.split('/').at(-1) ?? listed
    const below = await cards(accessor, mountedPath(scope, `${base}/${leaf}`), index)
    if (below === null) return null
    found.push(...below)
  }
  return found
}

/**
 * The `card.json` files under `under` whose card Trello's search names, or
 * whose other fields hold `text`.
 *
 * Trello searches a card's name and description by word, so each word is
 * asked on its own, and a card is read when each word is either named there
 * or held by the text the listing kept (`unsearchedText`): the rest of its
 * JSON (ids, due date, flags, link), and the words of those two the search
 * may split otherwise. A read fetches the card as it is now, so the kept text
 * is checked against listings made for this search rather than the walk's,
 * which may be older; a card those listings no longer hold is read. The text
 * goes through `recordQueries` for its key names and escapes. Null when the text cannot be searched, a scope lies
 * inside a card, a search answers a full page or fails, or nothing is found,
 * since Trello indexes a write some time after it lands. Mirrors Python's
 * `files_containing`.
 */
export async function filesContaining(
  accessor: TrelloAccessor,
  text: string,
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const queries = recordQueries(text, RECORD_KEYS, true)
  if (queries === null) return null
  const asked = queries.map((query) => query.toLowerCase().split(/\s+/).filter(Boolean))
  const found: PathSpec[] = []
  try {
    const named = new Map<string, Set<string>>()
    for (const word of [...new Set(asked.flat())].sort(compareCodePoints)) {
      const hits = await searchCards(accessor.transport, word, SEARCH_LIMIT)
      if (hits.length >= SEARCH_LIMIT) return null
      named.set(word, new Set(hits.map((hit) => String(hit.id))))
    }
    const fresh = new RAMIndexCacheStore()
    for (const scope of under) {
      const walked = await cards(accessor, scope, index)
      if (walked === null) return null
      for (const path of walked) {
        const entry = await resolveEntry(readdir, accessor, path, fresh)
        if (entry !== null) {
          const kept = entry.extra.unsearched
          if (typeof kept !== 'string') return null
          if (!mayHold(asked, named, entry.id, kept)) continue
        }
        found.push(mountedPath(path, `${rstripSlash(path.mountPath)}/card.json`))
      }
    }
  } catch (err) {
    // fetch rejects with a TypeError when the connection fails and a
    // DOMException when its timeout aborts it; a body that is not JSON
    // rejects with a SyntaxError
    const failed =
      isFsError(err) ||
      err instanceof TrelloApiError ||
      err instanceof TypeError ||
      err instanceof DOMException ||
      err instanceof SyntaxError
    if (!failed) throw err
    console.debug(`trello search failed (${String(err)}); reading every file`)
    return null
  }
  return found.length > 0 ? found : null
}
