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

import { mountAllowed } from '../context/session_context.ts'
import { stripSlash } from '../utils/slash.ts'
import { FileStat, FileType } from '../types.ts'
import type { NamespaceLinks } from './config.ts'

function normDir(path: string): string {
  const stripped = stripSlash(path)
  return stripped === '' ? '/' : '/' + stripped + '/'
}

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
    if (name === '' || !mountAllowed(p)) continue
    out.add(name)
  }
  return [...out].sort()
}

function linkNames(links: NamespaceLinks | null, parent: string): string[] {
  if (links === null) return []
  return [...links.linksUnder(parent).keys()].filter((name) => name !== '')
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
  const base = parent.replace(/\/+$/, '')
  const merged = [...entries]
  for (const name of [...childMountNames(prefixes, parent), ...linkNames(links, parent)]) {
    if (present.has(name)) continue
    present.add(name)
    merged.push(`${base}/${name}`)
  }
  return merged
}

function stripEntry(entry: string): string {
  const trimmed = entry.replace(/\/+$/, '')
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
export function structureListing(
  prefixes: readonly string[],
  links: NamespaceLinks | null,
  parent: string,
): string[] | null {
  if (childMountNames(prefixes, parent).length === 0 && linkNames(links, parent).length === 0) {
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
export function structureStat(
  prefixes: readonly string[],
  links: NamespaceLinks | null,
  path: string,
): FileStat | null {
  if (structureListing(prefixes, links, path) === null) return null
  const name = stripEntry(path)
  return new FileStat({ name: name === '' ? '/' : name, type: FileType.DIRECTORY })
}
