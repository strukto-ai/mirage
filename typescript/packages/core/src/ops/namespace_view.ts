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

import { normDir, rstripSlash } from '../utils/slash.ts'
import { FileStat, FileType, type PathSpec, type Visibility } from '../types.ts'
import { pathVisible } from '../utils/hidden.ts'
import type { NamespaceLinks } from './config.ts'
import type { NamespaceView } from './types.ts'
import { compareCodePoints } from '../utils/sort.ts'

/**
 * The child segments of `parent` that some allowed path runs through.
 *
 * The one session filter both namespace enumerations share, because both
 * owe a segment to a deeper thing rather than to an entry of its own: a
 * mount prefix and a link path each synthesize every directory above it,
 * and the segment is visible exactly when at least one of the things that
 * synthesized it is.
 *
 * The full path is what gets tested, never the segment. A hide is
 * subtree-closed on all three of its planes (an exact entry contains its
 * subtree, a component pattern matches any segment, an anchored one is
 * tested against every ancestor), so testing the deeper path is strictly
 * stronger: a segment can only be withheld by this, never granted.
 * Testing the segment instead is what leaked the name of a namespace-only
 * ancestor whose only mount or link the session hides, a directory that
 * answers ENOENT to every verb applied to it.
 */
export function visibleChildSegments(
  vis: Visibility | null,
  paths: Iterable<string>,
  parent: string,
): string[] {
  const norm = normDir(parent)
  const out = new Set<string>()
  for (const path of paths) {
    if (!path.startsWith(norm)) continue
    const name = path.slice(norm.length).split('/', 1)[0] ?? ''
    if (name === '' || out.has(name) || !pathVisible(vis, path)) continue
    out.add(name)
  }
  return [...out].sort(compareCodePoints)
}

/**
 * Immediate child segments of mounts strictly under `parent`.
 *
 * Session-filtered by `visibleChildSegments`: a child name appears only
 * when some mount whose prefix runs through it is visible to the current
 * session, so a scoped session never learns an ungranted mount's name
 * from a listing. Hidden names (leading dot) are included; presentation
 * filtering is the consumer's job, exactly as for backend entries.
 */
export function childMountNames(
  vis: Visibility | null,
  prefixes: readonly string[],
  parent: string,
): string[] {
  const norm = normDir(parent)
  const below: string[] = []
  for (const prefix of prefixes) {
    const p = normDir(prefix)
    if (p === norm || !p.startsWith(norm)) continue
    below.push(rstripSlash(p))
  }
  return visibleChildSegments(vis, below, parent)
}

/**
 * Immediate child segments owed to links at or below `parent`.
 *
 * Derived from every link path, not just direct children, exactly as
 * mount prefixes are: `ln` allows a link below a directory chain no
 * backend serves, and without its ancestors synthesized the link lists
 * at its own parent yet is unreachable from a walk above it.
 * Session-filtered by `visibleChildSegments`, the same predicate
 * `childMountNames` applies to a mount prefix: the link path is tested,
 * not the segment, so a namespace-only ancestor whose only link the
 * session hides is not named either.
 */
function linkNames(vis: Visibility | null, links: NamespaceLinks | null, parent: string): string[] {
  if (links === null) return []
  return visibleChildSegments(vis, links.symlinkTargets().keys(), parent)
}

/**
 * Every child segment the namespace owes `parent`: mounts + links.
 *
 * The one union both consumers derive from: the door merges these
 * names into its readdir and the `childMounts` fact offers them to
 * listing commands, so the shell and the ops surface cannot disagree
 * about what a directory holds.
 */
export function namespaceNames(
  vis: Visibility | null,
  prefixes: readonly string[],
  links: NamespaceLinks | null,
  parent: string,
): string[] {
  return [
    ...new Set([...childMountNames(vis, prefixes, parent), ...linkNames(vis, links, parent)]),
  ].sort(compareCodePoints)
}

/**
 * Merge namespace structure into a backend readdir listing.
 *
 * Child mounts and symlinks are namespace state no backend can see, so
 * a listing that stops at one backend misses both. Merged names are
 * appended as virtual paths (the shape RAM-style backends already
 * emit); deduplication is by final path segment because backends
 * disagree on entry shape (bare names, trailing-slash names, full
 * paths).
 */
export function mergeReaddir(
  vis: Visibility | null,
  entries: readonly string[],
  prefixes: readonly string[],
  links: NamespaceLinks | null,
  parent: string,
): string[] {
  const present = new Set(entries.map((e) => stripEntry(e)))
  const base = rstripSlash(parent)
  const merged = [...entries]
  for (const name of namespaceNames(vis, prefixes, links, parent)) {
    if (present.has(name)) continue
    present.add(name)
    merged.push(`${base}/${name}`)
  }
  return merged
}

function stripEntry(entry: string): string {
  const trimmed = rstripSlash(entry)
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/**
 * A listing for a directory that exists only as namespace structure.
 *
 * `/data/x` exists when a mount sits at `/data/x/y` or a link lives
 * directly under it, even though the `/data` backend holds nothing at
 * `/x`. Null when the namespace knows nothing there either, so a caller
 * re-throws the backend's miss.
 */
export function namespaceListing(
  vis: Visibility | null,
  prefixes: readonly string[],
  links: NamespaceLinks | null,
  parent: string,
): string[] | null {
  if (namespaceNames(vis, prefixes, links, parent).length === 0) {
    return null
  }
  return mergeReaddir(vis, [], prefixes, links, parent)
}

/**
 * A directory stat for a path that exists only as namespace structure.
 *
 * The listing and the stat must agree: a directory `readdir` can serve
 * (because a mount or a link sits below it) must stat as a directory,
 * or `os.walk` and `Path.is_dir` break on it.
 */
export function namespaceStat(
  vis: Visibility | null,
  prefixes: readonly string[],
  links: NamespaceLinks | null,
  path: string,
): FileStat | null {
  if (namespaceListing(vis, prefixes, links, path) === null) return null
  const name = stripEntry(path)
  return new FileStat({ name: name === '' ? '/' : name, type: FileType.DIRECTORY })
}

/**
 * Whether a hide, a path rule or a preOps policy judges anything a
 * command's operands reach, so a native walk that classifies the raw
 * tree gives way to the checked one.
 *
 * Per operand, not per session: a hidden `.env` under `/repo` must not
 * force `find` on `/s3` off its native op. `ns` is the command's
 * namespace view, whose `scoped` answers per path (none judges
 * nothing); `prefix` is the mount root, judged in place of a glob
 * operand.
 */
export function pathsScoped(
  ns: NamespaceView | undefined,
  paths: readonly PathSpec[],
  prefix = '',
): boolean {
  const scoped = ns?.scoped
  return (
    scoped !== undefined &&
    paths.some((path) => scoped(path.pattern !== null ? prefix || '/' : path.virtual))
  )
}
