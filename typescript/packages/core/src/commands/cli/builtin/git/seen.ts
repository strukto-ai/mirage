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

import git, { Errors, type TreeObject } from 'isomorphic-git'

import { getAdmission } from '../../../../context/session_context.ts'
import { readerOf } from '../../../../workspace/files.ts'
import { readIndex } from './index_file.ts'
import { visiblePath } from './pathspec.ts'
import { loadRefs } from './refs.ts'
import { objectType, repoArgs, type Repo } from './repo.ts'
import type { GitObject, RepoLocation } from './types.ts'

/** A leaf as a tree or the index lists it: its mode and its object id. */
interface Entry {
  readonly mode: string
  readonly oid: string
}

// What a session is shown of a repository's history. A hide or a path rule
// names a place in the working tree, and git keeps every version of what stood
// there in its object store, which no file call reaches: so git asks the same
// two questions of the place an object stands at. A hidden place is one the
// history never had, and content at a place a rule keeps from the command is
// refused as the file is. Mirrors Python's `seen`.

/**
 * Whether a hide or a rule in force could cover anything in the repository's
 * working tree for the running command; when nothing can, every object is shown
 * as stored and nothing is looked up.
 *
 * @param repo the opened repository
 */
export function guarded(repo: Repo): boolean {
  const vfs = repo.location.vfs
  if (vfs === undefined || vfs === null) return false
  if (repo.guarded === null) {
    const worktree = repo.location.worktree.virtual
    const gate = getAdmission()
    repo.guarded = readerOf(vfs).hidesUnder(worktree) || gate?.scopes(worktree) === true
  }
  return repo.guarded
}

/**
 * Refuse a place as the dispatcher refuses its file: a rule in force for the
 * running command throws `PolicyDenied` naming it.
 *
 * @param location the discovered repository
 * @param relative the repository-relative place
 */
export function checkRules(location: RepoLocation, relative: string): void {
  const gate = getAdmission()
  if (gate !== null && location.vfs !== undefined && location.vfs !== null)
    gate.check(location.worktree.join(relative).virtual)
}

/**
 * An object a revision found at a place, which the session may be shown there:
 * noted, so a tree prints what that place holds, and a blob's content refused
 * where a rule keeps the place from the command. A rule guards content, not
 * names, so a tree is listed.
 *
 * The caller has already refused a hidden place in its own words.
 *
 * @param repo the opened repository
 * @param obj the object found
 * @param relative the repository-relative place
 */
export function placed<T extends GitObject>(repo: Repo, obj: T, relative: string): T {
  if (obj.type === 'blob') checkRules(repo.location, relative)
  if (!repo.places.has(obj.oid)) repo.places.set(obj.oid, relative)
  return obj
}

/**
 * Note a commit's tree, which stands at the repository's root.
 *
 * @param repo the opened repository
 * @param tree the root tree's id
 */
export function rooted(repo: Repo, tree: string): void {
  if (!repo.places.has(tree)) repo.places.set(tree, '')
}

/**
 * An object named by id, if the session may be shown it: one reachable at a
 * place it sees and no rule keeps from the command; null when it is shown
 * nowhere.
 *
 * A commit and a tag carry no place and are always shown. A tree or a blob is
 * looked for where the history and the index hold it, so an id an agent
 * computed for content it guessed answers exactly as an id nothing holds. A
 * blob held only where a rule keeps it throws that rule's `PolicyDenied`.
 *
 * @param repo the opened repository
 * @param obj the object the id names
 */
export async function located<T extends GitObject>(repo: Repo, obj: T): Promise<T | null> {
  if (!guarded(repo) || obj.type === 'commit' || obj.type === 'tag' || repo.places.has(obj.oid))
    return obj
  const place = await find(repo, obj.oid)
  if (place === null) return null
  repo.places.set(obj.oid, place)
  return obj
}

/**
 * Whether an id names an object the session may be shown: one the store holds,
 * which `located` finds wherever it stands.
 *
 * @param repo the opened repository
 * @param oid the object's id
 */
export async function visibleObject(repo: Repo, oid: string): Promise<boolean> {
  const type = await objectType(repo, oid)
  if (type === null) return false
  if (!guarded(repo)) return true
  return (await located(repo, { oid, type })) !== null
}

/**
 * Where this command found an object, for a tree whose entries are shown
 * relative to it; the root when nothing narrows what is shown.
 *
 * @param repo the opened repository
 * @param oid the object's id
 */
export async function placeOf(repo: Repo, oid: string): Promise<string> {
  let found = repo.places.get(oid) ?? null
  if (found === null && guarded(repo)) found = await find(repo, oid)
  return found ?? ''
}

/**
 * A tree's entries the session sees, at the place it was found.
 *
 * @param repo the opened repository
 * @param tree the tree's id
 */
export async function shownItems(repo: Repo, tree: string): Promise<TreeObject> {
  const items = (await git.readTree({ ...repoArgs(repo), oid: tree })).tree
  if (!guarded(repo)) return items
  const base = await placeOf(repo, tree)
  return items.filter((entry) =>
    visiblePath(repo.location, base ? `${base}/${entry.path}` : entry.path),
  )
}

/**
 * A tree's leaves the session sees, keyed relative to `base`.
 *
 * What a diff, a log or a search reads its sides from, so a hidden path is no
 * change, no match and no count, as if never committed. A leaf at a place a
 * rule may keep from the command stays listed, a rule guarding content rather
 * than names, and its blob is noted so `readable` refuses to read it there.
 *
 * @param repo the opened repository
 * @param entries leaves keyed by git name
 * @param base the place the tree stands at
 */
export function shownEntries(
  repo: Repo,
  entries: ReadonlyMap<string, Entry>,
  base = '',
): Map<string, Entry> {
  if (!guarded(repo)) return new Map(entries)
  const location = repo.location
  const gate = getAdmission()
  const shown = new Map<string, Entry>()
  for (const [path, entry] of entries) {
    const relative = base ? `${base}/${path}` : path
    if (!visiblePath(location, relative)) continue
    shown.set(path, entry)
    if (gate?.scopes(location.worktree.join(relative).virtual) === true) {
      if (!repo.sealed.has(entry.oid)) repo.sealed.set(entry.oid, relative)
    } else {
      repo.free.add(entry.oid)
    }
  }
  return shown
}

/**
 * Refuse a blob's content where this command found it only at a place a rule
 * keeps from it: the same bytes anywhere it may read are no secret, so those
 * read.
 *
 * @param repo the opened repository
 * @param sha the blob's id
 * @throws PolicyDenied the rule's refusal, naming the place
 */
export function readable(repo: Repo, sha: string): void {
  if (repo.free.has(sha)) return
  const place = repo.sealed.get(sha)
  if (place !== undefined) checkRules(repo.location, place)
}

/**
 * The first place the index or the history holds an object at that the session
 * sees and, for a blob, no rule keeps from the command.
 *
 * The index comes first, then every commit any ref reaches; a subtree is read
 * once per place, however many commits share it. A hidden place is never
 * descended into: what stands under it is hidden too. A blob found only where
 * a rule may refuse it is judged at the first such place, the gate's own
 * answer, so a granted ask still reads.
 *
 * @param repo the opened repository
 * @param oid the object's id
 * @throws PolicyDenied it is held only where a rule keeps it
 */
async function find(repo: Repo, oid: string): Promise<string | null> {
  const location = repo.location
  const gate = getAdmission()
  const ruled: string[] = []
  const allowed = (relative: string): boolean => {
    const where = location.worktree.join(relative).virtual
    if (gate?.scopes(where) !== true) return true
    ruled.push(relative)
    return false
  }
  const state = await readIndex(repo, repo.vfs)
  const staged: [string, string][] = [...state.entries].map(([name, entry]) => [name, entry.oid])
  for (const [name, conflict] of state.conflicts) {
    for (const side of [conflict.ancestor, conflict.this, conflict.other])
      if (side !== null) staged.push([name, side.oid])
  }
  for (const [relative, sha] of staged) {
    if (sha === oid && relative && visiblePath(location, relative) && allowed(relative))
      return relative
  }
  const walked = new Set<string>()
  const walk = async (treeId: string, base: string): Promise<string | null> => {
    const key = `${treeId}\0${base}`
    if (walked.has(key)) return null
    walked.add(key)
    if (treeId === oid) return base
    for (const entry of (await git.readTree({ ...repoArgs(repo), oid: treeId })).tree) {
      const relative = base ? `${base}/${entry.path}` : entry.path
      if (!visiblePath(location, relative)) continue
      if (entry.type === 'tree') {
        const found = await walk(entry.oid, relative)
        if (found !== null) return found
      } else if (entry.oid === oid && allowed(relative)) {
        return relative
      }
    }
    return null
  }
  const refs = await loadRefs(repo.vfs, location.gitdir, location.commondir)
  // A symbolic ref names another ref the table already holds.
  const pending = [...refs.values()].filter((value) => /^[0-9a-f]{40}$/.test(value))
  const seen = new Set<string>()
  for (let sha = pending.pop(); sha !== undefined; sha = pending.pop()) {
    if (seen.has(sha)) continue
    seen.add(sha)
    let read
    try {
      // Deprecated upstream for being general, but one read saying which kind
      // an id names, its fields parsed, is what the walk needs.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      read = await git.readObject({ ...repoArgs(repo), oid: sha })
    } catch (err) {
      if (err instanceof Errors.NotFoundError) continue
      throw err
    }
    if (read.format !== 'parsed') continue
    if (read.type === 'tag') {
      pending.push(read.object.object)
      continue
    }
    if (read.type === 'commit') {
      pending.push(...read.object.parent)
      const found = await walk(read.object.tree, '')
      if (found !== null) return found
    }
  }
  const first = ruled[0]
  if (first === undefined) return null
  checkRules(location, first)
  return first
}
