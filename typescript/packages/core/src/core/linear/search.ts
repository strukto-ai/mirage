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

import type { LinearAccessor } from '../../accessor/linear.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { isFsError } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { mayHold, recordQueries } from '../../utils/record_search.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import { ROOT } from '../hierarchy/scope.ts'
import { LinearApiError, searchIssues } from './client.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'
import { rstripSlash } from '../../utils/slash.ts'

// The most issues one search answers; a full page may have left some out.
export const SEARCH_LIMIT = 250

// The words an issue's JSON holds whatever its text says: its letter-only key
// names and the JSON literals. Every other field Linear does not search is
// checked against the listing (`unsearchedText`).
export const RECORD_KEYS: ReadonlySet<string> = new Set([
  'title',
  'description',
  'priority',
  'url',
  'true',
  'false',
  'null',
])

// A team's directories whose files' listing entries keep their text
// (`keptText`).
export const KEPT_DIRS: readonly string[] = ['members', 'projects', 'cycles', 'documents']

function child(directory: PathSpec, name: string): PathSpec {
  return mountedPath(directory, `${rstripSlash(directory.mountPath)}/${name}`)
}

// The `issues` directories and the kept-text directories under `scope`; null
// for a scope inside an issue.
async function walked(
  accessor: LinearAccessor,
  scope: PathSpec,
  index: IndexCacheStore | undefined,
): Promise<[PathSpec[], PathSpec[]] | null> {
  const match = detectScope(scope)
  let teams: PathSpec[]
  if (match.kind === ROOT || match.kind === 'teams') {
    const root = mountedPath(scope, '/teams')
    teams = (await readdir(accessor, root, index)).map((name) =>
      child(root, name.split('/').at(-1) ?? name),
    )
  } else if (match.kind === 'team') {
    teams = [scope]
  } else if (match.kind === 'issues') {
    return [[scope], []]
  } else if (KEPT_DIRS.includes(match.kind)) {
    return [[], [scope]]
  } else {
    return null
  }
  return [
    teams.map((team) => child(team, 'issues')),
    teams.flatMap((team) => KEPT_DIRS.map((kind) => child(team, kind))),
  ]
}

// Each searched text's words, and the issues Linear names for each word; null
// when the text cannot be searched or a search fails or answers a full page.
async function named(
  accessor: LinearAccessor,
  text: string,
): Promise<[string[][], Map<string, Set<string>>] | null> {
  const queries = recordQueries(text, RECORD_KEYS, true)
  if (queries === null) return null
  const asked = queries.map((query) => query.toLowerCase().split(/\s+/).filter(Boolean))
  const found = new Map<string, Set<string>>()
  try {
    for (const word of [...new Set(asked.flat())].sort(compareCodePoints)) {
      const nodes = await searchIssues(accessor.transport, word, SEARCH_LIMIT)
      if (nodes.length >= SEARCH_LIMIT) return null
      found.set(word, new Set(nodes.map((node) => String(node.id))))
    }
  } catch (err) {
    // fetch rejects with a TypeError when the connection fails and a
    // DOMException when its timeout aborts it; a body that is not JSON
    // rejects with a SyntaxError
    const failed =
      isFsError(err) ||
      err instanceof LinearApiError ||
      err instanceof TypeError ||
      err instanceof DOMException ||
      err instanceof SyntaxError
    if (!failed) throw err
    console.debug(`linear search failed (${String(err)}); reading every issue`)
    return null
  }
  return [asked, found]
}

async function found(
  accessor: LinearAccessor,
  needle: string,
  under: readonly PathSpec[],
  index: IndexCacheStore | undefined,
  askLinear: boolean,
): Promise<PathSpec[] | null> {
  const issueDirs: PathSpec[] = []
  const keptDirs: PathSpec[] = []
  for (const scope of under) {
    const dirs = await walked(accessor, scope, index)
    if (dirs === null) return null
    issueDirs.push(...dirs[0])
    keptDirs.push(...dirs[1])
  }
  const issues: PathSpec[] = []
  for (const directory of issueDirs) {
    for (const listed of await readdir(accessor, directory, index)) {
      issues.push(child(directory, listed.split('/').at(-1) ?? listed))
    }
  }
  const fresh = new RAMIndexCacheStore()
  const answer = askLinear && issues.length > 0 ? await named(accessor, needle) : null
  const held: PathSpec[] = []
  if (answer !== null) {
    for (const path of issues) {
      const entry = await resolveEntry(readdir, accessor, path, fresh)
      const kept = entry?.extra.unsearched
      if (entry === null || typeof kept !== 'string' || mayHold(...answer, entry.id, kept)) {
        held.push(path)
      }
    }
  }
  const out = (held.length > 0 ? held : issues).map((path) => child(path, 'issue.json'))
  for (const directory of keptDirs) {
    for (const listed of await readdir(accessor, directory, index)) {
      const path = child(directory, listed.split('/').at(-1) ?? listed)
      const kept = (await resolveEntry(readdir, accessor, path, fresh))?.extra.text
      if (typeof kept !== 'string' || kept.includes(needle)) out.push(path)
    }
  }
  return out
}

/**
 * The files under `under` that may hold `text`: the `issue.json` files
 * Linear's search names or whose other fields hold it, and the member,
 * project, cycle and document files whose text holds it.
 *
 * Linear searches an issue's title and description by word, so with
 * `askLinear` each word is asked on its own, and an issue is read when each
 * word is either named there or held by the text the listing kept
 * (`unsearchedText`): the rest of its JSON (team, project, cycle, state,
 * people, labels, dates, link), and the words of those two the search may
 * split otherwise. The text goes through `recordQueries` for its key names and
 * escapes. Every issue is read without `askLinear`, when the text cannot be
 * searched, a search fails or answers a full page, or nothing is found, since
 * Linear indexes a write some time after it lands. A member, project, cycle or
 * document file is read when the text its listing entry kept (`keptText`)
 * holds `text` in any case, or when it was too large to keep. A read fetches
 * the record as it is now, so the kept text is checked against listings made
 * for this search rather than the walk's, which may be older; a file those
 * listings no longer hold is read. null for a text that is not ASCII or a
 * scope inside an issue. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: LinearAccessor,
  text: string,
  under: readonly PathSpec[],
  index: IndexCacheStore | undefined,
  askLinear: boolean,
): Promise<PathSpec[] | null> {
  if (/[\u0080-\uffff]/.test(text)) return null
  try {
    return await found(accessor, text.toLowerCase(), under, index, askLinear)
  } catch (err) {
    // fetch rejects with a TypeError when the connection fails and a
    // DOMException when its timeout aborts it; a body that is not JSON
    // rejects with a SyntaxError
    const failed =
      isFsError(err) ||
      err instanceof LinearApiError ||
      err instanceof TypeError ||
      err instanceof DOMException ||
      err instanceof SyntaxError
    if (!failed) throw err
    console.debug(`linear listing failed (${String(err)}); reading every file`)
    return null
  }
}
