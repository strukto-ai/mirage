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

import { mountAllowed, pathAllowed } from '../context/session_context.ts'
import { normDir, ownerPrefix, rstripSlash } from '../utils/slash.ts'
import { FileStat, FileType } from '../types.ts'
import type { NamespaceLinks } from './config.ts'
import { compareCodePoints } from '../utils/sort.ts'

/**
 * Immediate child segments of mounts strictly under `parent`.
 *
 * Session-filtered: a child name appears only when some mount whose
 * prefix runs through it is visible to the current session, so a scoped
 * session never learns an ungranted mount's name from a listing. Hidden
 * names (leading dot) are included; presentation filtering is the
 * consumer's job, exactly as for backend entries.
 */
export function childMountNames(prefixes: readonly string[], parent: string): string[] {
  const norm = normDir(parent)
  const out = new Set<string>()
  for (const prefix of prefixes) {
    const p = normDir(prefix)
    if (p === norm || !p.startsWith(norm)) continue
    const name = p.slice(norm.length).split('/', 1)[0] ?? ''
    if (name === '' || !mountAllowed(p) || !pathAllowed(norm + name)) continue
    out.add(name)
  }
  return [...out].sort(compareCodePoints)
}

/**
 * Whether the current session may see the link at `link`.
 *
 * A link is namespace state, but its path lies on some mount's turf:
 * the longest mount prefix above it owns it, the same longest-match
 * rule dispatch resolves the path by. A scoped session that may not
 * touch that mount must not learn the link's name from a listing,
 * exactly as `childMountNames` hides the mount itself. A link above
 * every mount is bare namespace structure and stays visible.
 */
function linkAllowed(prefixes: readonly string[], link: string): boolean {
  const owner = ownerPrefix(prefixes, link)
  return owner === null || mountAllowed(normDir(owner))
}

/**
 * Immediate child segments owed to links at or below `parent`.
 *
 * Derived from every link path, not just direct children, exactly as
 * mount prefixes are: `ln` allows a link below a directory chain no
 * backend serves, and without its ancestors synthesized the link lists
 * at its own parent yet is unreachable from a walk above it.
 * Session-filtered through `linkAllowed`: a link below an ungranted
 * mount would otherwise leak that mount's name into a listing
 * `childMountNames` had already filtered.
 */
function linkNames(
  prefixes: readonly string[],
  links: NamespaceLinks | null,
  parent: string,
): string[] {
  if (links === null) return []
  const norm = normDir(parent)
  const out = new Set<string>()
  for (const link of links.symlinkTargets().keys()) {
    if (!link.startsWith(norm)) continue
    const name = link.slice(norm.length).split('/', 1)[0] ?? ''
    if (name !== '' && linkAllowed(prefixes, link) && pathAllowed(norm + name)) out.add(name)
  }
  return [...out].sort(compareCodePoints)
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
  prefixes: readonly string[],
  links: NamespaceLinks | null,
  parent: string,
): string[] {
  return [
    ...new Set([...childMountNames(prefixes, parent), ...linkNames(prefixes, links, parent)]),
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
  entries: readonly string[],
  prefixes: readonly string[],
  links: NamespaceLinks | null,
  parent: string,
): string[] {
  const present = new Set(entries.map((e) => stripEntry(e)))
  const base = rstripSlash(parent)
  const merged = [...entries]
  for (const name of namespaceNames(prefixes, links, parent)) {
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
  prefixes: readonly string[],
  links: NamespaceLinks | null,
  parent: string,
): string[] | null {
  if (namespaceNames(prefixes, links, parent).length === 0) {
    return null
  }
  return mergeReaddir([], prefixes, links, parent)
}

/**
 * A directory stat for a path that exists only as namespace structure.
 *
 * The listing and the stat must agree: a directory `readdir` can serve
 * (because a mount or a link sits below it) must stat as a directory,
 * or `os.walk` and `Path.is_dir` break on it.
 */
export function namespaceStat(
  prefixes: readonly string[],
  links: NamespaceLinks | null,
  path: string,
): FileStat | null {
  if (namespaceListing(prefixes, links, path) === null) return null
  const name = stripEntry(path)
  return new FileStat({ name: name === '' ? '/' : name, type: FileType.DIRECTORY })
}
