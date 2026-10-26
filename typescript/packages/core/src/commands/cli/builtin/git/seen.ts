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
import { decodeText } from '../../../../shell/bytes.ts'
import { concat } from '../../../../utils/bytes.ts'
import { readerOf } from '../../../../workspace/files.ts'
import { readIndex } from './index_file.ts'
import { visiblePath } from './pathspec.ts'
import { loadRefs } from './refs.ts'
import { objectType, rawObject, repoArgs, type Repo } from './repo.ts'
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
 * Whether a rule in force could refuse anything at or under a place for the
 * running command; when none can, nothing there is asked.
 *
 * @param location the discovered repository
 * @param relative the repository-relative place, the root by default
 */
export function ruledUnder(location: RepoLocation, relative = ''): boolean {
  const gate = getAdmission()
  if (gate === null || location.vfs === undefined || location.vfs === null) return false
  return gate.scopes(location.worktree.join(relative).virtual)
}

/**
 * Whether no rule in force refuses a place for the running command, asked
 * without refusing it.
 *
 * @param location the discovered repository
 * @param relative the repository-relative place
 */
export function permitted(location: RepoLocation, relative: string): boolean {
  const gate = getAdmission()
  if (gate === null || location.vfs === undefined || location.vfs === null) return true
  return gate.refusal(location.worktree.join(relative).virtual) === null
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
 * @param revision the operand that named it, whose place this is whatever other
 *   place holds the same object
 */
export function placed<T extends GitObject>(
  repo: Repo,
  obj: T,
  relative: string,
  revision: string | null = null,
): T {
  if (obj.type === 'blob') checkRules(repo.location, relative)
  if (!repo.places.has(obj.oid)) repo.places.set(obj.oid, relative)
  if (revision !== null) repo.named.set(revision, relative)
  return obj
}

/**
 * Note a commit's tree, which stands at the repository's root.
 *
 * @param repo the opened repository
 * @param tree the root tree's id
 * @param revision the operand that named it
 */
export function rooted(repo: Repo, tree: string, revision: string | null = null): void {
  if (!repo.places.has(tree)) repo.places.set(tree, '')
  if (revision !== null) repo.named.set(revision, '')
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
  const place = await find(repo, obj.oid, obj.type === 'blob')
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
  if (found === null && guarded(repo)) found = await find(repo, oid, false)
  return found ?? ''
}

/**
 * Where the object an operand names stands for that operand: the place its own
 * path gave it (`HEAD:b` is `b` even where `HEAD:a` holds the same tree), else
 * where this command found it.
 *
 * @param repo the opened repository
 * @param name the operand as typed
 * @param oid the object's id
 */
export async function placeNamed(repo: Repo, name: string, oid: string): Promise<string> {
  const named = repo.named.get(name)
  return named ?? (await placeOf(repo, oid))
}

/**
 * A tree's entries the session sees, at the place it was found.
 *
 * @param repo the opened repository
 * @param tree the tree's id
 * @param base the place it stands at, null for where this command found it
 */
export async function shownItems(
  repo: Repo,
  tree: string,
  base: string | null = null,
): Promise<TreeObject> {
  const items = (await git.readTree({ ...repoArgs(repo), oid: tree })).tree
  if (!guarded(repo)) return items
  const where = base ?? (await placeOf(repo, tree))
  return items.filter((entry) =>
    visiblePath(repo.location, where ? `${where}/${entry.path}` : entry.path),
  )
}

/**
 * An object's stored bytes as the session is shown them: a tree's with only the
 * entries it sees, so neither the bytes nor their count name a hidden one. Only
 * a tree is placed, so a commit's or a blob's bytes cost no lookup.
 *
 * A tree's entries stand in its bytes in git's order, each its mode, its name
 * and its id, so dropping the ones the session does not see leaves exactly the
 * tree git would store for the rest.
 *
 * @param repo the opened repository
 * @param obj the object
 * @param name the operand that named it, whose place a tree is listed at; null
 *   for where this command found it
 */
export async function shownRaw(
  repo: Repo,
  obj: GitObject,
  name: string | null = null,
): Promise<Uint8Array> {
  const { raw } = await rawObject(repo, obj.oid)
  if (obj.type !== 'tree' || !guarded(repo)) return raw
  const where = name === null ? await placeOf(repo, obj.oid) : await placeNamed(repo, name, obj.oid)
  // Each entry ends in its id's twenty bytes, right after the NUL.
  const idBytes = 20
  const kept: Uint8Array[] = []
  for (let at = 0; at < raw.length;) {
    const space = raw.indexOf(0x20, at)
    const nul = space < 0 ? -1 : raw.indexOf(0, space)
    if (nul < 0) break
    const end = nul + 1 + idBytes
    const name = decodeText(raw.subarray(space + 1, nul))
    if (visiblePath(repo.location, where ? `${where}/${name}` : name))
      kept.push(raw.subarray(at, end))
    at = end
  }
  return concat(kept)
}

/**
 * A tree's leaves the session sees, keyed relative to `base`.
 *
 * What a diff, a log or a search reads its sides from, so a hidden path is no
 * change, no match and no count, as if never committed. A leaf at a place a
 * rule keeps from the command stays listed, a rule guarding content rather
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
  const shown = new Map<string, Entry>()
  for (const [path, entry] of entries) {
    const relative = base ? `${base}/${path}` : path
    if (!visiblePath(location, relative)) continue
    shown.set(path, entry)
    if (permitted(location, relative)) repo.free.add(entry.oid)
    else if (!repo.sealed.has(entry.oid)) repo.sealed.set(entry.oid, relative)
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
 * sees and, for content, no rule keeps from the command.
 *
 * Every lookup a command makes shares one walk (`sightings`), resumed where the
 * last stopped and remembered as it goes, so a batch naming the same or many
 * ids reads the history once. Content held only where rules refuse it is judged
 * at the first such place, which throws that rule's `PolicyDenied`.
 *
 * @param repo the opened repository
 * @param oid the object's id
 * @param content whether it is a blob, whose bytes rules guard
 */
async function find(repo: Repo, oid: string, content: boolean): Promise<string | null> {
  const location = repo.location
  const usable = (place: string): boolean => !content || permitted(location, place)
  for (const place of repo.seen.get(oid) ?? []) if (usable(place)) return place
  repo.sightings ??= sightings(repo)
  // Stepped by hand: leaving a `for await` early would close the walk the
  // next lookup resumes.
  for (let next = await repo.sightings.next(); next.done !== true;) {
    const [found, place] = next.value
    const held = repo.seen.get(found)
    if (held === undefined) repo.seen.set(found, [place])
    else held.push(place)
    if (found === oid && usable(place)) return place
    next = await repo.sightings.next()
  }
  const first = repo.seen.get(oid)?.[0]
  if (first === undefined) return null
  checkRules(location, first)
  return first
}

/**
 * Every object the index and the history hold, each with a place the session
 * sees, in the order a lookup wants them: the index first, then each commit any
 * ref reaches. A subtree is read once per place, however many commits share
 * it, an object is sighted once per place, and a hidden place is never
 * descended into: what stands under it is hidden too. An object only a ref
 * names directly stands at no place and is never sighted.
 *
 * @param repo the opened repository
 */
async function* sightings(repo: Repo): AsyncGenerator<[string, string], void> {
  const location = repo.location
  const state = await readIndex(repo, repo.vfs)
  const staged: [string, string][] = [...state.entries].map(([name, entry]) => [name, entry.oid])
  for (const [name, conflict] of state.conflicts) {
    for (const side of [conflict.ancestor, conflict.this, conflict.other])
      if (side !== null) staged.push([name, side.oid])
  }
  const sighted = new Set<string>()
  const fresh = (oid: string, place: string): boolean => {
    const key = `${oid}\0${place}`
    if (sighted.has(key)) return false
    sighted.add(key)
    return true
  }
  for (const [relative, sha] of staged)
    if (relative && visiblePath(location, relative) && fresh(sha, relative)) yield [sha, relative]
  const walk = async function* (
    treeId: string,
    base: string,
  ): AsyncGenerator<[string, string], void> {
    if (!fresh(treeId, base)) return
    yield [treeId, base]
    for (const entry of (await git.readTree({ ...repoArgs(repo), oid: treeId })).tree) {
      const relative = base ? `${base}/${entry.path}` : entry.path
      if (!visiblePath(location, relative)) continue
      if (entry.type === 'tree') yield* walk(entry.oid, relative)
      else if (fresh(entry.oid, relative)) yield [entry.oid, relative]
    }
  }
  const refs = await loadRefs(repo.vfs, location.gitdir, location.commondir)
  // A symbolic ref names another ref the table already holds.
  const pending = [...refs.values()].filter((value) => /^[0-9a-f]{40}$/.test(value))
  const reached = new Set<string>()
  for (let sha = pending.pop(); sha !== undefined; sha = pending.pop()) {
    if (reached.has(sha)) continue
    reached.add(sha)
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
    } else if (read.type === 'commit') {
      for (const item of read.object.parent) pending.push(item)
      yield* walk(read.object.tree, '')
    }
  }
}
