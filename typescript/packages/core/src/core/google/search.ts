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

import type { GoogleApiAccessor } from '../../accessor/google_api.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { isFsError } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { recordQueries } from '../../utils/record_search.ts'
import { stripSlash } from '../../utils/slash.ts'
import { type ReaddirFn, entriesUnder } from '../hierarchy/probe.ts'
import { GoogleApiError } from './client.ts'
import { RENDERED_WORDS, TOP_LEVEL_DIRS } from './constants.ts'
import { searchFiles } from './drive.ts'
import { rstripSlash } from '../../utils/slash.ts'

function noFolder(_entry: IndexEntry): boolean {
  return false
}

/**
 * The whole words Drive is asked for `text` over an app mount's JSON, or null
 * when its index cannot stand in for grep: the `recordQueries` of the text,
 * with the app's API names and the words every rendering carries as keys. A
 * digit, a JSON literal or a word an id can hold is never asked, and a word a
 * JSON escape can run into is asked without its first letter too. Mirrors
 * Python's `drive_queries`.
 */
export function driveQueries(text: string, vocabulary: ReadonlySet<string>): string[] | null {
  return recordQueries(text, new Set([...vocabulary, ...RENDERED_WORDS]), true)
}

/**
 * The Docs, Sheets or Slides files under `under` Drive full-text search names.
 *
 * One query asks for every file of the app's MIME type holding the word, and
 * the answer is matched by id against the owned and shared listings grep walks
 * next. Null for a word `driveQueries` turns down, a scope below a corpus,
 * a listing or search that fails or that Drive did not finish, or an empty
 * answer.
 *
 * Drive searches a file's text, so the answer can leave out one whose JSON
 * holds the word only in a value that is not text (a font, a time zone, a link
 * or image address, a tab title, an id or a formula), or only as part of a word
 * styling splits into text runs (`snow` bold in `snowman`). Mirrors Python's
 * `files_containing`.
 */
export async function filesContaining<A extends GoogleApiAccessor>(
  accessor: A,
  readdir: ReaddirFn<A>,
  mime: string,
  vocabulary: ReadonlySet<string>,
  text: string,
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const queries = driveQueries(text, vocabulary)
  if (queries === null) return null
  const corpora: PathSpec[] = []
  for (const directory of under) {
    const key = stripSlash(directory.vfsPath)
    if (key === '') {
      for (const corpus of TOP_LEVEL_DIRS) corpora.push(mountedPath(directory, `/${corpus}`))
    } else if ((TOP_LEVEL_DIRS as readonly string[]).includes(key)) {
      corpora.push(directory)
    } else {
      return null
    }
  }
  const found: PathSpec[] = []
  try {
    const named = new Set<string>()
    for (const query of queries) {
      const answer = await searchFiles(accessor.tokenManager, query, [], mime)
      if (!answer.complete) return null
      for (const id of answer.ids) named.add(id)
    }
    for (const corpus of corpora) {
      const walked = await entriesUnder(readdir, accessor, corpus, index, noFolder)
      // An unfinished listing caches its entries but not the directory, and
      // grep's own walk lists it again.
      const listing = await index?.listDir(rstripSlash(corpus.virtual))
      if (walked === null || (listing?.entries ?? null) === null) return null
      for (const [path, entry] of walked) if (named.has(entry.id)) found.push(path)
    }
  } catch (err) {
    // fetch rejects with a TypeError when the connection fails and a
    // DOMException when its timeout aborts it
    const failed =
      isFsError(err) ||
      err instanceof GoogleApiError ||
      err instanceof TypeError ||
      err instanceof DOMException
    if (!failed) throw err
    console.debug(`drive search failed (${String(err)}); reading every file`)
    return null
  }
  return found.length > 0 ? found : null
}
