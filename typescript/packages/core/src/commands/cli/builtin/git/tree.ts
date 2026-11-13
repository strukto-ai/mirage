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

import { SYMLINK, TREE_MODE } from './constants.ts'
import { GitError } from './errors.ts'
import { resolveObject, unwrapped } from './revparse.ts'
import { repoArgs, storedItems, type Repo } from './repo.ts'
import { decoded, rooted } from './seen.ts'
import type { GitObject } from './types.ts'

/** One tree entry, flattened to a repository-relative path. */
export interface TreeEntry {
  readonly oid: string
  /** git's own octal spelling, e.g. `100644`. */
  readonly mode: string
}

/**
 * Every blob a tree holds, keyed by repository-relative path.
 *
 * Flattened rather than walked per directory because every caller here compares
 * two whole trees; git's own diff does the same on the paths it has already
 * expanded. A submodule (`160000`) is carried through as an entry rather than
 * descended into: it names a commit in another repository.
 */
export async function treeEntries(
  repo: Repo,
  treeOid: string,
  prefix = '',
): Promise<Map<string, TreeEntry>> {
  const rows = await listedTree(repo, treeOid, [], true, false, false, prefix)
  return new Map(rows.map(([path, mode, oid]) => [path, { mode, oid }]))
}

const DOT_GIT = /^(?:\.git|git~1)[ .]*(?::.*)?$/is
const GITMODULES_LINK =
  /^(?:\.gitmodules|gitmod~[1-4]|~[1-9][0-9]{6}|g~[1-9][0-9]{5}|gi~[1-9][0-9]{4}|gi7~[1-9][0-9]{3}|gi7e~[1-9][0-9]{2}|gi7eb~[1-9][0-9]|gi7eba~[1-9])[ .]*(?::.*)?$/is
const GITMODULES_DIR = /^\.gitmodules(?::.*)?$/is

/**
 * A path part as NTFS reads it: split at every backslash but one that starts
 * the part, which git keeps as part of the name.
 */
export function ntfsPieces(part: string): string[] {
  const [head = '', ...rest] = part.slice(1).split('\\')
  return [part.slice(0, 1) + head, ...rest]
}

/**
 * Whether a tree path passes git's checkout rule, pinned against git 2.47.3
 * with its defaults (every row is in tree.test.ts).
 *
 * Refused: a part that is empty, `.` or `..`; a part, or an NTFS piece of one,
 * that NTFS reads as `.git` (`.git` or its short name `git~1`, then dots or
 * spaces, then the end or a `:` stream); and for a symlink, a last piece NTFS
 * reads as `.gitmodules` (the name, its short names `gitmod~1`-`~4`, or the
 * 8-character hashed short name built on `gi7eba`), or a directory part that is
 * `.gitmodules`, with or without a `:` stream. Case is ASCII-folded, as git
 * folds it. macOS's HFS spellings of `.git` are not covered. An empty-named
 * tree entry never reaches here: reading the tree refuses it first.
 */
export function validPath(path: string, mode: string): boolean {
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false
  if (parts.some((part) => ntfsPieces(part).some((piece) => DOT_GIT.test(piece)))) return false
  // The file-type bits decide a symlink, so `0120000` and `120644` are ones.
  if ((Number.parseInt(mode, 8) & 0o170000) !== SYMLINK) return true
  return (
    !GITMODULES_LINK.test(ntfsPieces(parts.at(-1) ?? '').at(-1) ?? '') &&
    !parts.slice(0, -1).some((part) => GITMODULES_DIR.test(part))
  )
}

/**
 * Every blob a commit's tree holds, or an empty map for no commit at all.
 *
 * An empty map is what an unborn HEAD means: nothing is committed yet, so every
 * staged path reads as an addition.
 */
export async function commitEntries(
  repo: Repo,
  commitOid: string | null,
): Promise<Map<string, TreeEntry>> {
  if (commitOid === null) return new Map()
  const { commit } = await git.readCommit({ ...repoArgs(repo), oid: commitOid })
  return treeEntries(repo, commit.tree)
}

/** Resolve a tree-ish through tags and commits. */
export async function resolveTree(repo: Repo, name: string, resolved?: GitObject): Promise<string> {
  const obj = await unwrapped(repo, resolved ?? (await resolveObject(repo, name)), name)
  if (obj.type === 'commit') {
    const tree = (await git.readCommit({ ...repoArgs(repo), oid: obj.oid })).commit.tree
    rooted(repo, tree, name)
    return tree
  }
  if (obj.type === 'tree') return obj.oid
  throw new GitError('not a tree object')
}

/** Literal tree prefixes; a trailing slash descends even without -r. */
export async function listedTree(
  repo: Repo,
  tree: string,
  patterns: readonly string[],
  recursive: boolean,
  trees: boolean,
  directories: boolean,
  prefix = '',
): Promise<[string, string, string][]> {
  const out: [string, string, string][] = []
  for (const entry of decoded(await storedItems(repo, tree))) {
    const path = prefix ? `${prefix}/${entry.path}` : entry.path
    const selected =
      patterns.length === 0 ||
      patterns.some(
        (pattern) =>
          pattern === '' || path === pattern || path.startsWith(pattern.replace(/\/$/, '') + '/'),
      )
    const row: [string, string, string] = [path, entry.mode, entry.oid]
    if (entry.mode !== TREE_MODE) {
      if (selected && !directories) out.push(row)
      continue
    }
    const descend =
      (recursive && selected) || patterns.some((pattern) => pattern.startsWith(path + '/'))
    const showTree = trees || (directories && (selected || recursive))
    if ((selected && !descend) || (descend && showTree)) out.push(row)
    if (descend) {
      const children = await listedTree(
        repo,
        entry.oid,
        patterns,
        recursive,
        trees,
        directories,
        path,
      )
      for (const child of children) out.push(child)
    }
  }
  return out
}
