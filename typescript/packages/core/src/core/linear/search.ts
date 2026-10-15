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
import { isFsError } from '../../errors/fs.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { mayHold, recordQueries } from '../../utils/record_search.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { rowAt, rowsOf } from '../hierarchy/probe.ts'
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

// A team's directories whose files' rows keep their text (`keptText`).
export const KEPT_DIRS: readonly string[] = ['members', 'projects', 'cycles', 'documents']

function child(directory: PathSpec, name: string): PathSpec {
  return mountedPath(directory, `${rstripSlash(directory.mountPath)}/${name}`)
}

// A path, its row and its directory's row.
type Walked = [PathSpec, FileStat, FileStat | null][]

// A directory's children, each with its row and the directory's.
async function listed(
  accessor: LinearAccessor,
  directory: PathSpec,
  entry: FileStat | null,
  parent: FileStat | null,
): Promise<Walked> {
  const rows = rowsOf(await readdir(accessor, directory, entry, parent))
  return rows.map((row) => [child(directory, row.name), row, entry])
}

// The `issues` directories and the kept-text directories under `scope`, each
// with its row and its team's; null for a scope inside an issue.
async function walked(accessor: LinearAccessor, scope: PathSpec): Promise<[Walked, Walked] | null> {
  const match = detectScope(scope)
  let teams: Walked
  if (match.kind === ROOT || match.kind === 'teams') {
    teams = await listed(accessor, mountedPath(scope, '/teams'), null, null)
  } else if (match.kind === 'team' || match.kind === 'issues' || KEPT_DIRS.includes(match.kind)) {
    const [entry, parent] = await rowAt(readdir, accessor, scope)
    if (entry === null) return null
    if (match.kind === 'issues') return [[[scope, entry, parent]], []]
    if (match.kind !== 'team') return [[], [[scope, entry, parent]]]
    teams = [[scope, entry, parent]]
  } else {
    return null
  }
  const issueDirs: Walked = []
  const keptDirs: Walked = []
  for (const [team, row] of teams) {
    for (const found of await listed(accessor, team, row, null)) {
      if (found[1].name === 'issues') issueDirs.push(found)
      else if (KEPT_DIRS.includes(found[1].name)) keptDirs.push(found)
    }
  }
  return [issueDirs, keptDirs]
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
  askLinear: boolean,
): Promise<PathSpec[] | null> {
  const issueDirs: Walked = []
  const keptDirs: Walked = []
  for (const scope of under) {
    const dirs = await walked(accessor, scope)
    if (dirs === null) return null
    issueDirs.push(...dirs[0])
    keptDirs.push(...dirs[1])
  }
  const issues: Walked = []
  for (const [directory, row, above] of issueDirs) {
    issues.push(...(await listed(accessor, directory, row, above)))
  }
  const answer = askLinear && issues.length > 0 ? await named(accessor, needle) : null
  const held: PathSpec[] = []
  if (answer !== null) {
    for (const [path, row] of issues) {
      const kept = row.extra.unsearched
      if (typeof kept !== 'string' || mayHold(...answer, String(row.extra.issue_id), kept)) {
        held.push(path)
      }
    }
  }
  const out = (held.length > 0 ? held : issues.map(([path]) => path)).map((path) =>
    child(path, 'issue.json'),
  )
  for (const [directory, row, above] of keptDirs) {
    for (const [path, file] of await listed(accessor, directory, row, above)) {
      const kept = file.extra.text
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
 * document file is read when the text its row kept (`keptText`) holds `text`
 * in any case, or when it was too large to keep. The walk lists each directory
 * from Linear, so the kept text is checked against the records as they are
 * now. null for a text that is not ASCII or a scope inside an issue. Mirrors
 * Python's `files_containing`.
 */
export async function filesContaining(
  accessor: LinearAccessor,
  text: string,
  under: readonly PathSpec[],
  askLinear: boolean,
): Promise<PathSpec[] | null> {
  if (/[\u0080-\uffff]/.test(text)) return null
  try {
    return await found(accessor, text.toLowerCase(), under, askLinear)
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
