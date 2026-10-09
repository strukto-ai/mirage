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

import { decodeText } from '../../../../shell/bytes.ts'
import { GitError } from './errors.ts'
import { resolveObject, unwrapped } from './revparse.ts'
import { repoArgs, type Repo } from './repo.ts'

const SPACE = 0x20
const NUL = 0x00
const OID_BYTES = 20
const SHORT_TREE_MODE = '40000'
export const TREE_MODE = '040000'
const DEC = new TextDecoder()

/** One tree entry, flattened to a repository-relative path. */
export interface TreeEntry {
  readonly oid: string
  /** git's own octal spelling, e.g. `100644`. */
  readonly mode: string
}

/** One entry of one tree object, not descended into. */
export interface TreeItem {
  readonly path: string
  readonly oid: string
  /** git's own octal spelling, e.g. `100644`; a subtree reads `040000`. */
  readonly mode: string
}

/**
 * The entries of one tree object, read from its raw bytes.
 *
 * Parsed here rather than through isomorphic-git's readTree, which decodes each
 * name as UTF-8 and turns a byte that is not into U+FFFD. A name keeps every
 * byte, a byte UTF-8 cannot read carried as its surrogate escape, so the name
 * quotes and prints the way git's does. A subtree's `40000` is spelled
 * `040000`, as isomorphic-git spells it.
 */
export async function treeItems(repo: Repo, treeOid: string): Promise<TreeItem[]> {
  // Deprecated upstream for being general, but the raw content is exactly what
  // a byte-faithful name needs.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const read = await git.readObject({ ...repoArgs(repo), oid: treeOid, format: 'content' })
  const raw = read.object as Uint8Array
  const items: TreeItem[] = []
  for (let at = 0; at < raw.length;) {
    const space = raw.indexOf(SPACE, at)
    const nul = space < 0 ? -1 : raw.indexOf(NUL, space)
    if (nul < 0 || nul + 1 + OID_BYTES > raw.length)
      throw new GitError(`unable to read tree (${treeOid})`)
    const mode = DEC.decode(raw.subarray(at, space))
    const oid = Array.from(raw.subarray(nul + 1, nul + 1 + OID_BYTES), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    items.push({
      path: decodeText(raw.subarray(space + 1, nul)),
      oid,
      mode: mode === SHORT_TREE_MODE ? TREE_MODE : mode,
    })
    at = nul + 1 + OID_BYTES
  }
  return items
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
  const out = new Map<string, TreeEntry>()
  for (const entry of await treeItems(repo, treeOid)) {
    const path = prefix === '' ? entry.path : `${prefix}/${entry.path}`
    if (entry.mode === TREE_MODE) {
      for (const [key, value] of await treeEntries(repo, entry.oid, path)) out.set(key, value)
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode })
    }
  }
  return out
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
export async function resolveTree(repo: Repo, name: string): Promise<string> {
  const obj = await unwrapped(repo, await resolveObject(repo, name), name)
  if (obj.type === 'commit')
    return (await git.readCommit({ ...repoArgs(repo), oid: obj.oid })).commit.tree
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
  for (const entry of await treeItems(repo, tree)) {
    const path = prefix ? `${prefix}/${entry.path}` : entry.path
    const selected =
      patterns.length === 0 ||
      patterns.some(
        (pattern) =>
          pattern === '' || path === pattern || path.startsWith(pattern.replace(/\/$/, '') + '/'),
      )
    const directory = entry.mode === TREE_MODE
    const descend =
      directory &&
      ((recursive && selected) || patterns.some((pattern) => pattern.startsWith(path + '/')))
    if (
      (selected || (directory && descend && (trees || (directories && recursive)))) &&
      ((directory && (!descend || trees || directories)) || (!directory && !directories))
    )
      out.push([path, entry.mode, entry.oid])
    if (descend)
      out.push(
        ...(await listedTree(repo, entry.oid, patterns, recursive, trees, directories, path)),
      )
  }
  return out
}
