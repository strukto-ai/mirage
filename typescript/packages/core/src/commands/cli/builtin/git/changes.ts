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

import git from 'isomorphic-git'

import type { StatPath } from '../../../../ops/types.ts'
import type { FileStat } from '../../../../types.ts'
import { isMissingPath } from '../../../../utils/errors.ts'
import { readIndex } from './index_file.ts'
import { readFile, under } from './io.ts'
import { repoArgs, type Repo } from './repo.ts'
import { resolveCommit } from './revparse.ts'
import { similarityScore } from './similarity.ts'
import { commitEntries, type TreeEntry } from './tree.ts'
import type {
  ConflictedEntry,
  Dispatch,
  IndexEntry,
  IndexState,
  StatusEntry,
  WorkTree,
} from './types.ts'
import { scan } from './worktree.ts'

const UNCHANGED = ' '
const MODIFIED = 'M'
const ADDED = 'A'
const DELETED = 'D'
const RENAMED = 'R'
const UNTRACKED = '?'
// git's own two rename knobs: a pair counts as a rename at 60% shared content,
// and the search is abandoned entirely once the add-by-delete matrix would
// exceed 200 by 200. Matching both is what makes mirage give up exactly where
// git gives up rather than answer differently.
const RENAME_THRESHOLD = 60
const MAX_RENAME_FILES = 200
// A regular file, as the mode's type bits spell it. Only these are rename
// candidates: a symlink and a file that happen to share bytes are not a rename
// of each other.
const REGULAR_MODE = '100644'
const REGULAR_EXEC_MODE = '100755'

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

/** One staged verdict: its letter, and the path it was renamed from. */
type StagedRow = readonly [string, string | null]

function isRegular(mode: string): boolean {
  return mode === REGULAR_MODE || mode === REGULAR_EXEC_MODE
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
  try {
    return await commitEntries(repo, await resolveCommit(repo, 'HEAD'))
  } catch {
    return null
  }
}

/**
 * Pair an add with a delete holding byte-identical content.
 *
 * Costs a map rather than a read, so it runs first and takes every pair it can
 * before anything is fetched.
 */
function exactRenames(
  adds: readonly string[],
  deletes: readonly string[],
  oids: ReadonlyMap<string, string>,
): [string, string][] {
  const sources = new Map<string, string>()
  for (const path of deletes) {
    const oid = oids.get(path)
    if (oid !== undefined && !sources.has(oid)) sources.set(oid, path)
  }
  const taken = new Set<string>()
  const pairs: [string, string][] = []
  for (const path of adds) {
    const oid = oids.get(path)
    const origin = oid === undefined ? undefined : sources.get(oid)
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
): Promise<[string, string][]> {
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
    const { blob } = await git.readBlob({ ...repoArgs(repo), oid })
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
      if (score >= RENAME_THRESHOLD) candidates.push([-score, fresh, old])
    }
  }
  candidates.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]))
  const takenNew = new Set<string>()
  const takenOld = new Set<string>()
  const pairs: [string, string][] = []
  for (const [, fresh, old] of candidates) {
    if (takenNew.has(fresh) || takenOld.has(old)) continue
    takenNew.add(fresh)
    takenOld.add(old)
    pairs.push([fresh, old])
  }
  return pairs
}

/**
 * Fold an add and a delete of the same file into one rename.
 *
 * Two passes, git's own order: identical content first, then what is merely
 * similar enough.
 */
async function pairRenames(
  repo: Repo,
  staged: ReadonlyMap<string, string>,
  oids: ReadonlyMap<string, string>,
  regular: ReadonlySet<string>,
): Promise<Map<string, StagedRow>> {
  const pick = (letter: string): string[] =>
    [...staged.entries()]
      .filter(([path, held]) => held === letter && regular.has(path))
      .map(([path]) => path)
      .sort()
  const adds = pick(ADDED)
  const deletes = pick(DELETED)
  const pairs = exactRenames(adds, deletes, oids)
  const matchedNew = new Set(pairs.map(([fresh]) => fresh))
  const matchedOld = new Set(pairs.map(([, old]) => old))
  pairs.push(
    ...(await contentRenames(
      repo,
      adds.filter((p) => !matchedNew.has(p)),
      deletes.filter((p) => !matchedOld.has(p)),
      oids,
    )),
  )
  const paired = new Map(pairs.map(([fresh, old]) => [fresh, [RENAMED, old] as StagedRow]))
  const consumed = new Set(pairs.map(([, old]) => old))
  const out = new Map<string, StagedRow>()
  for (const [path, letter] of staged) {
    if (consumed.has(path)) continue
    out.set(path, paired.get(path) ?? [letter, null])
  }
  return out
}

/**
 * Compare HEAD's tree with the index: what a commit would record.
 *
 * Conflicted paths are excluded rather than compared. An unmerged path holds no
 * ordinary index entry, so comparing it against HEAD's tree would find the path
 * on one side only and call it deleted, which is the opposite of what is
 * happening to it.
 */
async function stageChanges(
  repo: Repo,
  head: ReadonlyMap<string, TreeEntry> | null,
  entries: ReadonlyMap<string, IndexEntry>,
  conflicts: ReadonlySet<string>,
): Promise<Map<string, StagedRow>> {
  const tree = head ?? new Map<string, TreeEntry>()
  const staged = new Map<string, string>()
  const oids = new Map<string, string>()
  const regular = new Set<string>()
  for (const [path, entry] of entries) {
    const recorded = tree.get(path)
    if (recorded === undefined) {
      staged.set(path, ADDED)
      oids.set(path, entry.oid)
      if (isRegular(entry.mode.toString(8))) regular.add(path)
    } else if (recorded.oid !== entry.oid || Number.parseInt(recorded.mode, 8) !== entry.mode) {
      staged.set(path, MODIFIED)
    }
  }
  for (const [path, recorded] of tree) {
    if (entries.has(path) || conflicts.has(path)) continue
    staged.set(path, DELETED)
    oids.set(path, recorded.oid)
    if (isRegular(recorded.mode)) regular.add(path)
  }
  return pairRenames(repo, staged, oids, regular)
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
  dispatch: Dispatch,
  worktree: string,
  path: string,
  entry: IndexEntry,
  info: FileStat,
): Promise<boolean> {
  if (modeDiffers(entry, info)) return true
  if (info.size !== null && entry.size !== 0 && info.size !== entry.size) return true
  let data: Uint8Array
  try {
    data = await readFile(dispatch, under(worktree, path))
  } catch (err) {
    if (isMissingPath(err)) return true
    throw err
  }
  const oid = await git.hashBlob({ object: data })
  return oid.oid !== entry.oid
}

/** Compare the index with the working tree: what is not staged yet. */
export async function workChanges(
  repo: Repo,
  dispatch: Dispatch,
  worktree: string,
  entries: ReadonlyMap<string, IndexEntry>,
  found: WorkTree,
): Promise<Map<string, string>> {
  const changes = new Map<string, string>()
  for (const [path, entry] of entries) {
    const info = found.files.get(path)
    if (info === undefined) changes.set(path, DELETED)
    else if (await differs(repo, dispatch, worktree, path, entry, info)) {
      changes.set(path, MODIFIED)
    }
  }
  return changes
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
  const paths = [...new Set([...staged.keys(), ...unstaged.keys(), ...conflicts.keys()])].sort()
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
  for (const path of [...untracked].sort()) {
    rows.push({ path, indexStatus: UNTRACKED, treeStatus: UNTRACKED, original: null })
  }
  return rows
}

/** Everything `status` reports, in one pass over the three sources. */
export async function collect(
  repo: Repo,
  dispatch: Dispatch,
  statPath: StatPath,
  mode: string,
): Promise<[StatusEntry[], IndexState, boolean]> {
  const state = await readIndex(repo, dispatch)
  const head = await headEntries(repo)
  const staged = await stageChanges(repo, head, state.entries, new Set(state.conflicts.keys()))
  const tracked = new Set([...state.entries.keys(), ...state.conflicts.keys()])
  const found = await scan(dispatch, statPath, repo.location, tracked, mode)
  const unstaged = await workChanges(repo, dispatch, repo.location.worktree, state.entries, found)
  const rows = merge(staged, unstaged, conflictCodes(state.conflicts), found.untracked)
  return [rows, state, head === null]
}
