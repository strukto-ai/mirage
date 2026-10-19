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

import { type PathSpec, FileType, type FileStat } from '../../../../types.ts'
import git from 'isomorphic-git'

import { fsStrerror, isEacces, isEisdir, isEnotdir, isMissingPath } from '../../../../errors/fs.ts'
import { AmbiguousArgumentError, UnhashableFileError } from './errors.ts'
import { entryMode } from './add.ts'
import { EXECUTABLE_MODE, GITLINK_MODE, REGULAR_MODE, SYMLINK, SYMLINK_MODE } from './constants.ts'
import { readIndex } from './index_file.ts'
import { entryBytes } from './io.ts'
import { visibleEntries } from './pathspec.ts'

import { readBlobBytes, type Repo } from './repo.ts'
import { resolveCommit } from './revparse.ts'
import { similarityScore } from './similarity.ts'
import { commitEntries, type TreeEntry } from './tree.ts'
import type { ConflictedEntry, IndexEntry, IndexState, StatusEntry, WorkTree } from './types.ts'
import type { Files } from '../../../../workspace/files.ts'
import { scan, UNTRACKED_NO } from './worktree.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

const UNCHANGED = ' '
export const MODIFIED = 'M'
export const ADDED = 'A'
export const DELETED = 'D'
export const TYPE_CHANGED = 'T'
const RENAMED = 'R'
const UNTRACKED = '?'
const IGNORED = '!'
// git's own two rename knobs: a pair counts as a rename at 60% shared content,
// and the search is abandoned entirely once the add-by-delete matrix would
// exceed 200 by 200. Matching both is what makes mirage give up exactly where
// git gives up rather than answer differently.
const RENAME_THRESHOLD = 60
const MAX_RENAME_FILES = 200
// A regular file, as the mode's type bits spell it. Only these are scored for
// similarity: a symlink is paired only with another symlink holding the same
// bytes, since scoring one against a file would pair two unrelated things by
// the bytes of a path.
// What a mode says a path is, for pairing within one kind. Only the executable
// bit separates the two regular modes, and git renames across it.
const SYMLINK_KIND = 'symlink'
const REGULAR_KIND = 'regular'

// git spells an unmerged path by which of the three index stages it kept, keyed
// here as (ancestor, ours, theirs). The pair is the porcelain XY, and the long
// format's label follows from it.
const CONFLICT_CODES: Record<string, string> = {
  'true,true,true': 'UU',
  'true,true,false': 'UD',
  'true,false,true': 'DU',
  'true,false,false': 'DD',
  'false,true,true': 'AA',
  'false,true,false': 'AU',
  'false,false,true': 'UA',
}

/**
 * One staged verdict: its letter, the path it was renamed from, and how similar
 * the two are (0 when it is no rename).
 */
type StagedRow = readonly [string, string | null, number]

function isRegular(mode: string): boolean {
  return mode === REGULAR_MODE || mode === EXECUTABLE_MODE
}

/** What a mode makes a path, for a rename pair that must not cross kinds. */
export function kindOf(mode: string): string {
  if (isRegular(mode)) return REGULAR_KIND
  return mode === SYMLINK_MODE ? SYMLINK_KIND : mode
}

/**
 * Every path HEAD's tree holds, with its mode and blob id.
 *
 * Null rather than an empty map when HEAD resolves to nothing: a repository
 * before its first commit is a different thing from one whose commit is empty,
 * and git says so ("No commits yet").
 *
 * Resolved through the revision parser so a HEAD detached onto a tag peels to
 * the commit it names, rather than being read as a tree it does not have.
 */
export async function headEntries(repo: Repo): Promise<Map<string, TreeEntry> | null> {
  let head: string
  try {
    head = await resolveCommit(repo, 'HEAD')
  } catch (err) {
    if (err instanceof AmbiguousArgumentError) return null
    throw err
  }
  return commitEntries(repo, head)
}

/**
 * Pair an add with a delete holding byte-identical content.
 *
 * Costs a map rather than a read, so it runs first and takes every pair it can
 * before anything is fetched. Keyed by kind as well as content, because a
 * symlink and a regular file that happen to share bytes are not a rename of
 * each other, while a moved symlink is exactly one.
 */
function exactRenames(
  adds: readonly string[],
  deletes: readonly string[],
  oids: ReadonlyMap<string, string>,
  kinds: ReadonlyMap<string, string>,
): [string, string][] {
  const key = (path: string): string | undefined => {
    const oid = oids.get(path)
    return oid === undefined ? undefined : `${kinds.get(path) ?? ''}:${oid}`
  }
  const sources = new Map<string, string>()
  for (const path of deletes) {
    const held = key(path)
    if (held !== undefined && !sources.has(held)) sources.set(held, path)
  }
  const taken = new Set<string>()
  const pairs: [string, string][] = []
  for (const path of adds) {
    const held = key(path)
    const origin = held === undefined ? undefined : sources.get(held)
    if (origin !== undefined && !taken.has(origin)) {
      taken.add(origin)
      pairs.push([path, origin])
    }
  }
  return pairs
}

/**
 * Pair the rest by how much content they still have in common.
 *
 * This is what makes a move that also edited the file read as one rename instead
 * of an add beside a delete. It costs a read of both sides of every candidate
 * pair, which is why git bounds the matrix and stops trying rather than slow
 * down on a large rewrite; the same bound is kept here so the answer agrees with
 * git's on the trees where git gives up.
 */
async function contentRenames(
  repo: Repo,
  adds: readonly string[],
  deletes: readonly string[],
  oids: ReadonlyMap<string, string>,
  threshold: number = RENAME_THRESHOLD,
): Promise<[string, string, number][]> {
  if (
    adds.length === 0 ||
    deletes.length === 0 ||
    adds.length * deletes.length > MAX_RENAME_FILES ** 2
  ) {
    return []
  }
  const blobs = new Map<string, Uint8Array>()
  const load = async (oid: string): Promise<Uint8Array> => {
    const held = blobs.get(oid)
    if (held !== undefined) return held
    const blob = await readBlobBytes(repo, oid)
    blobs.set(oid, blob)
    return blob
  }
  const candidates: [number, string, string][] = []
  for (const old of deletes) {
    const oldOid = oids.get(old)
    if (oldOid === undefined) continue
    const source = await load(oldOid)
    for (const fresh of adds) {
      const newOid = oids.get(fresh)
      if (newOid === undefined) continue
      const score = similarityScore(source, await load(newOid))
      // Negative score so the strongest pair sorts first while paths still
      // tie-break in ascending order, which is what makes two equally similar
      // candidates resolve the same way on every run.
      if (score >= threshold) candidates.push([-score, fresh, old])
    }
  }
  // Python is `candidates.sort()`, a code-point tuple sort, so the paths
  // tie-break by code point rather than ICU collation. The comment above
  // promises the same resolution on every run; that only holds if both
  // trees break the tie the same way.
  candidates.sort(
    (a, b) => a[0] - b[0] || compareCodePoints(a[1], b[1]) || compareCodePoints(a[2], b[2]),
  )
  const takenNew = new Set<string>()
  const takenOld = new Set<string>()
  const pairs: [string, string, number][] = []
  for (const [score, fresh, old] of candidates) {
    if (takenNew.has(fresh) || takenOld.has(old)) continue
    takenNew.add(fresh)
    takenOld.add(old)
    pairs.push([fresh, old, -score])
  }
  return pairs
}

/**
 * Fold an add and a delete of the same file into one rename.
 *
 * Two passes, git's own order: identical content first, then what is merely
 * similar enough. Both pair within one kind, and only the second is limited to
 * regular files: a moved symlink is a rename git reports as one. Each rename
 * carries its similarity, 100 for identical content.
 */
export async function pairRenames(
  repo: Repo,
  staged: ReadonlyMap<string, string>,
  oids: ReadonlyMap<string, string>,
  kinds: ReadonlyMap<string, string>,
  threshold: number = RENAME_THRESHOLD,
): Promise<Map<string, StagedRow>> {
  const pick = (letter: string): string[] =>
    [...staged.entries()]
      .filter(([path, held]) => held === letter && kinds.has(path))
      .map(([path]) => path)
      .sort(compareCodePoints)
  const adds = pick(ADDED)
  const deletes = pick(DELETED)
  const pairs: [string, string, number][] = exactRenames(adds, deletes, oids, kinds).map(
    ([fresh, old]) => [fresh, old, 100],
  )
  const matchedNew = new Set(pairs.map(([fresh]) => fresh))
  const matchedOld = new Set(pairs.map(([, old]) => old))
  const scored = (side: string[]): string[] => side.filter((p) => kinds.get(p) === REGULAR_KIND)
  pairs.push(
    ...(await contentRenames(
      repo,
      scored(adds.filter((p) => !matchedNew.has(p))),
      scored(deletes.filter((p) => !matchedOld.has(p))),
      oids,
      threshold,
    )),
  )
  const paired = new Map(
    pairs.map(([fresh, old, score]) => [fresh, [RENAMED, old, score] as StagedRow]),
  )
  const consumed = new Set(pairs.map(([, old]) => old))
  const out = new Map<string, StagedRow>()
  for (const [path, letter] of staged) {
    if (consumed.has(path)) continue
    out.set(path, paired.get(path) ?? [letter, null, 0])
  }
  return out
}

/**
 * Compare HEAD's tree with the index: what a commit would record, before an
 * add and a delete pair into a rename.
 *
 * Conflicted paths are excluded rather than compared. An unmerged path holds no
 * ordinary index entry, so comparing it against HEAD's tree would find the path
 * on one side only and call it deleted, which is the opposite of what is
 * happening to it. Returns each changed path's letter, then the blob id and the
 * kind of each added and deleted path, which is what `pairRenames` takes.
 * Mirrors Python's `staged_letters`.
 */
function stagedLetters(
  head: ReadonlyMap<string, TreeEntry> | null,
  entries: ReadonlyMap<string, IndexEntry>,
  conflicts: ReadonlySet<string>,
): [Map<string, string>, Map<string, string>, Map<string, string>] {
  const tree = head ?? new Map<string, TreeEntry>()
  const staged = new Map<string, string>()
  const oids = new Map<string, string>()
  const kinds = new Map<string, string>()
  for (const [path, entry] of entries) {
    const recorded = tree.get(path)
    if (recorded === undefined) {
      staged.set(path, ADDED)
      oids.set(path, entry.oid)
      kinds.set(path, kindOf(entry.mode.toString(8)))
    } else if (recorded.oid !== entry.oid || Number.parseInt(recorded.mode, 8) !== entry.mode) {
      staged.set(path, MODIFIED)
    }
  }
  for (const [path, recorded] of tree) {
    if (entries.has(path) || conflicts.has(path)) continue
    staged.set(path, DELETED)
    oids.set(path, recorded.oid)
    kinds.set(path, kindOf(recorded.mode))
  }
  return [staged, oids, kinds]
}

/** The two-letter code for each unmerged path. */
function conflictCodes(conflicts: ReadonlyMap<string, ConflictedEntry>): Map<string, string> {
  const codes = new Map<string, string>()
  for (const [path, entry] of conflicts) {
    const key = [entry.ancestor !== null, entry.this !== null, entry.other !== null].join(',')
    codes.set(path, CONFLICT_CODES[key] ?? 'UU')
  }
  return codes
}

/**
 * Whether the executable bit moved since the path was staged.
 *
 * git tracks exactly one permission bit and only the owner's copy of it:
 * `chmod 744` is a modification and `chmod 645` is not, pinned against git 2.47.
 * Nothing is claimed when the mount reports no mode at all, which is most of
 * them; a backend that has no permissions to report would otherwise make every
 * executable file look changed.
 */
function modeDiffers(entry: IndexEntry, info: FileStat): boolean {
  if (info.mode === null || !isRegular(entry.mode.toString(8))) return false
  return Boolean(entry.mode & 0o100) !== Boolean(info.mode & 0o100)
}

/**
 * Whether a working-tree file differs from what the index staged.
 *
 * A size the mount already reported settles most of it for free, since an edit
 * that keeps the byte count is the exception. When the sizes agree the file is
 * read and hashed, because that is the only thing that actually answers the
 * question. git normally skips even that by trusting the stat data it cached
 * (device, inode, mtime to the nanosecond); a mount serves none of those
 * meaningfully, so the cheap answer is not available here and a wrong one is
 * worse than a slow one.
 *
 * A recorded size of zero is read as "not stated" rather than "empty", because
 * that is what mirage writes for an entry it restored from a tree without
 * reading the blob. Trusting it would report every tracked file as modified the
 * moment anything was unstaged. Nothing is lost: a genuinely empty file falls
 * through to the hash and compares equal there.
 */
async function differs(
  repo: Repo,
  vfs: Files,
  worktree: PathSpec,
  path: string,
  entry: IndexEntry,
  info: FileStat,
): Promise<boolean> {
  if (modeDiffers(entry, info)) return true
  if (info.size !== null && entry.size !== 0 && info.size !== entry.size) return true
  let data: Uint8Array
  try {
    data = await entryBytes(vfs, worktree.join(path), info)
  } catch (err) {
    if (isMissingPath(err) || isEnotdir(err) || isEisdir(err)) return true
    // git counts a file it cannot read as changed; a command that needs its
    // bytes then refuses it (UnhashableFileError).
    if (isEacces(err)) return true
    throw err
  }
  const oid = await git.hashBlob({ object: data })
  return oid.oid !== entry.oid
}

/** Compare the index with the working tree: what is not staged yet. */
export async function workChanges(
  repo: Repo,
  vfs: Files,
  worktree: PathSpec,
  entries: ReadonlyMap<string, IndexEntry>,
  found: WorkTree,
): Promise<Map<string, string>> {
  const changes = new Map<string, string>()
  for (const [path, entry] of entries) {
    // A 160000 entry records another repository's HEAD, and what stands at the
    // name is a directory, so the walk never finds a file there and every
    // submodule read as deleted. git compares the submodule's own HEAD, which
    // is unreadable from here, and says nothing at all when there is none;
    // saying nothing is both the closest this can get and what keeps a branch
    // switch away from a submodule from being refused over a file that was
    // never missing.
    if (entry.mode === Number.parseInt(GITLINK_MODE, 8)) continue
    const info = found.files.get(path)
    if (info === undefined) changes.set(path, DELETED)
    // A symlink and a file holding its target text hash alike.
    else if ((info.type === FileType.SYMLINK) !== ((entry.mode & 0o170000) === SYMLINK)) {
      changes.set(path, TYPE_CHANGED)
    } else if (await differs(repo, vfs, worktree, path, entry, info)) {
      changes.set(path, MODIFIED)
    }
  }
  return changes
}

/** The index as entries, path to mode and id, conflict stages left out. */
export function stagedEntries(state: IndexState): Map<string, TreeEntry> {
  return new Map(
    [...state.entries].map(([path, entry]) => [
      path,
      { oid: entry.oid, mode: entry.mode.toString(8).padStart(6, '0') },
    ]),
  )
}

/**
 * The working tree as entries, for the side `git diff` compares.
 *
 * The index stands for every file the walk found unchanged; a modified file is
 * hashed and its blob held on the repo for this invocation only, as git writes
 * nothing on a diff. Untracked files are not part of it. A path the index holds
 * only as conflict stages is the file standing there, if any: what a revision
 * is compared with, while the index side leaves it out (git shows a combined
 * diff there, which is not offered). Mirrors Python's work_entries.
 */
export async function workEntries(
  repo: Repo,
  vfs: Files,
  state: IndexState,
): Promise<Map<string, TreeEntry>> {
  const tracked = new Set([...state.entries.keys(), ...state.conflicts.keys()])
  const found = await scan(vfs, repo.location, tracked, UNTRACKED_NO)
  const changes = await workChanges(repo, vfs, repo.location.worktree, state.entries, found)
  const entries = stagedEntries(state)
  for (const path of state.conflicts.keys()) {
    if (found.files.has(path)) changes.set(path, MODIFIED)
  }
  for (const [path, code] of changes) {
    const info = found.files.get(path)
    if (code === DELETED || info === undefined) {
      entries.delete(path)
      continue
    }
    let data: Uint8Array
    try {
      data = await entryBytes(vfs, repo.location.worktree.join(path), info)
    } catch (err) {
      if (!isEacces(err)) throw err
      throw new UnhashableFileError(path, fsStrerror(err) ?? 'Permission denied')
    }
    const { oid } = await git.hashBlob({ object: data })
    repo.held.set(oid, data)
    entries.set(path, { oid, mode: entryMode(info).toString(8).padStart(6, '0') })
  }
  return entries
}

/**
 * Assemble one row per path from the three comparisons.
 *
 * A path can appear in both the staged and unstaged mappings, and that is the
 * point of carrying two columns: it is one row reading `MM`, not two rows.
 *
 * Sorting is per group, not overall, which is git's own order: everything
 * tracked sorts together (an unmerged path among the rest, verified against git
 * 2.47), and untracked paths follow as their own sorted block however they
 * collate against the tracked ones.
 */
function merge(
  staged: ReadonlyMap<string, StagedRow>,
  unstaged: ReadonlyMap<string, string>,
  conflicts: ReadonlyMap<string, string>,
  untracked: readonly string[],
): StatusEntry[] {
  const rows: StatusEntry[] = []
  const paths = [...new Set([...staged.keys(), ...unstaged.keys(), ...conflicts.keys()])].sort(
    compareCodePoints,
  )
  for (const path of paths) {
    const code = conflicts.get(path)
    if (code !== undefined) {
      rows.push({
        path,
        indexStatus: code.charAt(0),
        treeStatus: code.charAt(1),
        original: null,
      })
      continue
    }
    const [letter, origin] = staged.get(path) ?? [UNCHANGED, null]
    rows.push({
      path,
      indexStatus: letter,
      treeStatus: unstaged.get(path) ?? UNCHANGED,
      original: origin,
    })
  }
  for (const path of [...untracked].sort(compareCodePoints)) {
    rows.push({ path, indexStatus: UNTRACKED, treeStatus: UNTRACKED, original: null })
  }
  return rows
}

/**
 * One path's status before renames pair, as the row `status` hands over.
 *
 * An added and a deleted path stay two rows, so a hide drops either alone and
 * the renderer pairs only the renames the session sees. Mirrors Python's
 * `StatusRow`.
 */
export interface StatusRow {
  /** Where it sits in the session's tree. */
  readonly path: PathSpec
  /** Git's repository-relative name; a collapsed untracked directory ends in `/`. */
  readonly name: string
  /** HEAD against the index, `?` untracked and `!` ignored. */
  readonly indexStatus: string
  /** The index against the working tree. */
  readonly treeStatus: string
  /** The kind and blob id of a staged add or delete, which a rename pairs by. */
  readonly end: readonly [string, string] | null
  /** Whether the two letters are a conflict code. */
  readonly unmerged: boolean
}

/**
 * The status entries the rows a session sees make, renames paired. Mirrors
 * Python's `assembled`.
 */
export async function assembled(repo: Repo, shown: readonly StatusRow[]): Promise<StatusEntry[]> {
  const staged = new Map<string, string>()
  const oids = new Map<string, string>()
  const kinds = new Map<string, string>()
  const unstaged = new Map<string, string>()
  const conflicts = new Map<string, string>()
  const untracked: string[] = []
  const ignored: string[] = []
  for (const row of shown) {
    if (row.indexStatus === UNTRACKED) untracked.push(row.name)
    else if (row.indexStatus === IGNORED) ignored.push(row.name)
    else if (row.unmerged) conflicts.set(row.name, row.indexStatus + row.treeStatus)
    else {
      if (row.indexStatus !== UNCHANGED) staged.set(row.name, row.indexStatus)
      if (row.treeStatus !== UNCHANGED) unstaged.set(row.name, row.treeStatus)
      if (row.end !== null) {
        kinds.set(row.name, row.end[0])
        oids.set(row.name, row.end[1])
      }
    }
  }
  const rows = merge(await pairRenames(repo, staged, oids, kinds), unstaged, conflicts, untracked)
  for (const path of ignored.sort(compareCodePoints))
    rows.push({ path, indexStatus: IGNORED, treeStatus: IGNORED, original: null })
  return rows
}

/** Everything `status` reports, in one pass over the three sources. */
export async function collect(
  repo: Repo,
  vfs: Files,
  mode: string,
  showIgnored = false,
): Promise<[StatusRow[], IndexState, boolean]> {
  const state = await readIndex(repo, vfs)
  const head = await headEntries(repo)
  const [staged, oids, kinds] = stagedLetters(head, state.entries, new Set(state.conflicts.keys()))
  // The walk collapses a directory holding nothing tracked into `dir/`, and
  // which directories those are is the session's view of the index: one whose
  // only tracked file is hidden reads as untracked, as it would in a checkout
  // of what the session sees.
  const tracked = new Set([
    ...visibleEntries(repo.location, state.entries).keys(),
    ...visibleEntries(repo.location, state.conflicts).keys(),
  ])
  const found = await scan(vfs, repo.location, tracked, mode, showIgnored)
  const unstaged = await workChanges(repo, vfs, repo.location.worktree, state.entries, found)
  const at = (name: string): PathSpec => repo.location.worktree.join(name.replace(/\/+$/, ''))
  const row = (
    name: string,
    indexStatus: string,
    treeStatus: string,
    end: readonly [string, string] | null = null,
    unmerged = false,
  ): StatusRow => ({ path: at(name), name, indexStatus, treeStatus, end, unmerged })
  const rows: StatusRow[] = []
  for (const [name, code] of conflictCodes(state.conflicts))
    rows.push(row(name, code.charAt(0), code.charAt(1), null, true))
  for (const name of [...new Set([...staged.keys(), ...unstaged.keys()])].sort(compareCodePoints)) {
    const oid = oids.get(name)
    const kind = kinds.get(name)
    rows.push(
      row(
        name,
        staged.get(name) ?? UNCHANGED,
        unstaged.get(name) ?? UNCHANGED,
        oid !== undefined && kind !== undefined ? [kind, oid] : null,
      ),
    )
  }
  for (const name of found.untracked) rows.push(row(name, UNTRACKED, UNTRACKED))
  for (const name of found.ignored) rows.push(row(name, IGNORED, IGNORED))
  return [rows, state, head === null]
}
