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

import type { LinkView, StatPath } from '../../../ops/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { type FileStat, FileType, LINK_TARGET_KEY, PathSpec, type StatFn } from '../../../types.ts'
import {
  dotWalkError,
  eexist,
  enoent,
  isMissingPath,
  operandSpelling,
  type FsError,
} from '../../../utils/errors.ts'
import { mountKey, rekey, respelled } from '../../../utils/key_prefix.ts'
import { CycleError, dotPrefixes, norm, parent, resolvePath } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'

// Stat via dispatch in the shape the generics' probes take: destKind and
// its kin are written against a backend stat that raises on a miss, so a
// dispatcher answer of nothing becomes ENOENT. Mirrors Python's
// dispatch_stat.
export function dispatchStat(dispatch: DispatchFn): StatFn {
  return async (path: PathSpec) => {
    const [stat] = await dispatch('stat', path)
    if (stat === null || stat === undefined) throw enoent(path)
    return stat as FileStat
  }
}

// A dispatcher lookup in the shape a chain walk reads. StatPath answers
// null for a miss, while dotRefusal and its kin read a stat that throws, so
// a command that holds only the lookup (`opts.statPath`) wraps it here.
// Mirrors Python's stat_or_enoent.
export function statOrEnoent(statPath: StatPath): StatFn {
  return async (path: PathSpec) => {
    const row = await statPath(path)
    if (row === null) throw enoent(path)
    return row
  }
}

// `path` spelled from its operand as typed, the way GNU names it. Mirrors
// Python's spelled_from.
export function spelledFrom(path: PathSpec, operand: PathSpec): PathSpec {
  return respelled(path, operandSpelling(path.virtual, operand))
}

// A path on `root`'s mount, keyed and spelled the way `root` is. Mirrors
// Python's descendant_path.
export function descendantPath(root: PathSpec, virtual: string): PathSpec {
  return spelledFrom(
    PathSpec.fromStrPath(virtual, rekey(root.virtual, root.vfsPath, virtual)),
    root,
  )
}

// Probe a path once for {exists, isDir}. ENOTDIR counts as "does not exist":
// a path whose parent chain runs through a plain file cannot exist. This is
// the probe for a path that is not an operand (an ancestor in a chain walk,
// an overwrite target already paired); an operand itself goes through
// sourceKind or destKind, which keep the ENOTDIR a slashed spelling earns.
// isMissingPath stays ENOENT-only so read-family commands keep reporting
// "Not a directory" verbatim.
export async function entryKind(
  stat: StatFn,
  path: PathSpec,
): Promise<{ exists: boolean; isDir: boolean }> {
  let info: FileStat
  try {
    info = await stat(path)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (!isMissingPath(err) && code !== 'ENOTDIR') throw err
    return { exists: false, isDir: false }
  }
  return { exists: true, isDir: info.type === FileType.DIRECTORY }
}

// The nearest ancestor of `path` that exists, and whether it is a
// directory. Walked upward from the immediate parent, as the kernel stops
// resolving at the first component it cannot pass. The mount root always
// exists as a directory and is never stat-ed: a backend that cannot stat
// "/" must not fail every operand under it. Mirrors Python's
// nearest_ancestor.
export async function nearestAncestor(stat: StatFn, path: PathSpec): Promise<[string, boolean]> {
  let node = parent(norm(path.virtual))
  while (node !== '/') {
    const { exists, isDir } = await entryKind(stat, descendantPath(path, node))
    if (exists) return [node, isDir]
    node = parent(node)
  }
  return ['/', true]
}

// The strerror a create at an absent path meets in its parent chain: null
// when the immediate parent is a directory, so the path can be made there;
// `Not a directory` when a plain file stands in the chain; `No such file or
// directory` when a directory higher up is the nearest thing there, the
// components below it being absent. For a caller that already knows
// `target` is not there, which is what destKind finds out first. Mirrors
// Python's absent_dest_strerror.
export async function absentDestStrerror(stat: StatFn, target: PathSpec): Promise<string | null> {
  const [node, isDir] = await nearestAncestor(stat, target)
  if (!isDir) return 'Not a directory'
  return node === parent(norm(target.virtual)) ? null : 'No such file or directory'
}

// The link resolution a dot walk is handed, null while no link exists.
// Mirrors Python's link_follow.
export function linkFollow(links: LinkView | null | undefined): ((path: string) => string) | null {
  return links === null || links === undefined ? null : (path: string) => links.resolve(path)
}

// One link's target, the hop a canonicalizing walk reads, null while no
// link exists. Mirrors Python's link_target.
export function linkTarget(
  links: LinkView | null | undefined,
): ((path: string) => string | null) | null {
  if (links === null || links === undefined) return null
  return (path: string) => {
    const row = links.statAt(path)
    return row === null ? null : (row.extra[LINK_TARGET_KEY] as string)
  }
}

// Whether `virtual` is the path a dotted spelling names: the textual
// simplification, or that simplification taken through the links. The
// kernel walk (`followPaths`) resolves an operand before its command runs,
// every component or all but the last, and the operand it hands on is still
// the one typed. Mirrors Python's _spells.
function spells(
  dotted: string,
  virtual: string,
  follow: ((path: string) => string) | null,
): boolean {
  const spelled = resolvePath(dotted, '/')
  if (spelled === virtual) return true
  if (follow === null) return false
  const trimmed = rstripSlash(dotted)
  const cut = trimmed.lastIndexOf('/')
  const head = trimmed.slice(0, cut)
  const name = trimmed.slice(cut + 1)
  try {
    const whole = resolvePath(follow(dotted), '/')
    const above = follow(head === '' ? '/' : head)
    return virtual === whole || virtual === resolvePath(`${rstripSlash(above)}/${name}`, '/')
  } catch (err) {
    if (err instanceof CycleError) return false
    throw err
  }
}

/**
 * The typed spelling, links before `..`, while it names the path. Mirrors
 * Python's walk_spelling.
 *
 * Without a trailing slash: that is a final `.`, which `dotRefusal` proves,
 * and a store that keeps no directories reads a slashed key as one, so
 * `cat reg/` there was ENOENT, not ENOTDIR.
 */
export function walkSpelling(path: PathSpec, follow: ((path: string) => string) | null): string {
  const dotted = path.dotted
  if (dotted !== null && spells(dotted, path.virtual, follow)) return rstripSlash(dotted) || '/'
  return path.virtual
}

/**
 * What a path's dot components answer, null when every one resolves.
 *
 * The kernel resolves `.` and `..` against the directory they sit in, so a
 * walk through a missing name fails ENOENT and one through a plain file
 * ENOTDIR (`cat nope/../f`, `cat f.txt/.`), where the textual simplification
 * in `virtual` reached `f` regardless. Each name in front of a dot is proved
 * a directory, in walk order, and one that is not is judged by its chain the
 * way a create is, so a miss under a plain file is ENOTDIR on every store.
 * A link in front of a dot is followed first, as the kernel walks (only
 * bash's `cd` reads `link/..` logically). A trailing slash is a final `.`:
 * an existing name in front of it has to be a directory too (`cat reg/`); a
 * call that creates that name (`creates`: mkdir, symlink) answers EEXIST
 * instead (`mkdir reg/`), however the store keeps the name.
 *
 * Only the path the spelling names is walked: a path derived from it (a
 * child a walker builds, a respelled match) carries the field along but no
 * longer spells it, while the operand the kernel walk followed through a
 * link (`lnk/nope/../f`) still does, which `follow` recognizes. The error
 * names the operand as typed and is a DotWalkError, final for every layer
 * that re-reads a miss. Mirrors Python's dot_refusal.
 */
export async function dotRefusal(
  stat: StatFn,
  path: PathSpec,
  follow: ((path: string) => string) | null = null,
  creates = false,
): Promise<FsError | null> {
  const dotted = path.dotted
  if (dotted === null || !spells(dotted, resolvePath(path.virtual, '/'), follow)) return null
  const proved: string[] = []
  let prefixes: string[]
  try {
    prefixes = dotPrefixes(dotted, follow)
  } catch (err) {
    if (err instanceof CycleError) return dotWalkError(path, 'ELOOP')
    throw err
  }
  for (const prefix of prefixes) {
    if (proved.some((done) => done.startsWith(`${prefix}/`))) continue
    const spec = PathSpec.fromStrPath(prefix)
    const { exists, isDir } = await entryKind(stat, spec)
    if (exists && isDir) {
      proved.push(prefix)
      continue
    }
    if (!exists && (await nearestAncestor(stat, spec))[1]) return dotWalkError(path, 'ENOENT')
    return dotWalkError(path, 'ENOTDIR')
  }
  if (dotted.endsWith('/')) {
    const { exists, isDir } = await entryKind(stat, PathSpec.fromStrPath(path.virtual))
    if (exists && !isDir) return creates ? eexist(path) : dotWalkError(path, 'ENOTDIR')
  }
  return null
}

// True when any operand still carries a glob to expand. Backend push-down
// branches read paths[0] directly to build SQL, so they must not run before
// glob expansion: a pattern segment would be taken for a literal entity
// name, and tables/*/rows.jsonl would query a relation actually called "*".
export function hasUnresolvedGlob(paths: PathSpec[]): boolean {
  return paths.some((p) => p.pattern !== null && p.pattern !== '')
}

// Resolve a script operand (absolute or cwd-relative) to a fully-resolved
// PathSpec, the way python3/js locate a mounted script before running it.
// The spelling as typed rides along in rawPath, which is the name an
// interpreter gives its program.
export function resolveScript(name: string, cwd: string): PathSpec {
  return PathSpec.fromStrPath(name, undefined, cwd)
}

// Default a command's path operands the way the shell would: explicit
// operands pass through, otherwise the session cwd becomes the single
// operand (keyed against the mount prefix when the caller knows it).
export function defaultPaths(paths: PathSpec[], cwd: string, mountPrefix = ''): PathSpec[] {
  if (paths.length > 0) return paths
  return [PathSpec.fromStrPath(cwd, mountKey(cwd, mountPrefix))]
}
