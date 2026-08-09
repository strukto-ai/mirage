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

import type { LinkView, MountView } from '../../../../ops/types.ts'
import { type FileStat, FileType, LINK_TARGET_KEY, PathSpec } from '../../../../types.ts'
import { mountKey } from '../../../../utils/key_prefix.ts'
import { CycleError } from '../../../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../../../utils/slash.ts'
import type { Entry, MemberKind, Problem, Scan } from './types.ts'

// A mount boundary is a filesystem boundary, so both archivers stop at
// one and say so in GNU tar's --one-file-system wording. Descending
// would archive by accident exactly what the mount-root refusal forbids
// on purpose.
export const OTHER_FILESYSTEM = 'file is on a different filesystem; not dumped'
// Why a path could not be reached, in GNU's strerror wording. Both ride
// on a fatal Problem; tar prints them after "Cannot stat: " and Info-ZIP
// words every unreachable name the same way, so it ignores the reason.
const NO_SUCH = 'No such file or directory'
const TOO_MANY_LEVELS = 'Too many levels of symbolic links'

export type StatFn = (path: PathSpec) => Promise<FileStat>
export type WalkFn = (path: PathSpec, findType: string) => Promise<string[]>
export type DirProbe = (path: PathSpec) => Promise<boolean>

// What the shared scan needs from the mount it runs on, plus the two
// knobs the formats disagree about.
export interface ScanDeps {
  stat: StatFn
  walk: WalkFn
  links?: LinkView | null
  mounts?: MountView | null
  // Archive what a symlink points at rather than the link. tar sets
  // this from -h, zip from the absence of -y.
  dereference: boolean
  // Whether a directory contributes its contents as well as itself.
  // Always true for tar, only under -r for zip.
  recurse: boolean
}

function linkTarget(stat: FileStat): string {
  const target = stat.extra[LINK_TARGET_KEY]
  return typeof target === 'string' ? target : ''
}

// A PathSpec for a walked descendant of one operand. The walk reports
// absolute virtual paths; reading their bytes needs the backend key too,
// which is the virtual path with this mount's prefix removed.
function childSpec(virtual: string, root: PathSpec): PathSpec {
  const cut = rstripSlash(root.virtual).length - stripSlash(root.resourcePath).length
  const prefix = rstripSlash(root.virtual.slice(0, cut))
  const slash = virtual.lastIndexOf('/')
  return new PathSpec({
    virtual,
    directory: slash >= 0 ? virtual.slice(0, slash + 1) : '/',
    resourcePath: mountKey(virtual, prefix),
    rawPath: virtual,
  })
}

// Whether two virtual paths are served by the same mount. Outside a
// workspace (no MountView) there is only one mount.
function sameMount(mounts: MountView | null, one: string, other: string): boolean {
  if (mounts === null) return true
  return mounts.rootOf(one) === mounts.rootOf(other)
}

// Every entry under one directory, named under `nameBase`.
//
// Three sources have to be merged because no single one can see them
// all: the backend walk (files and directories), the namespace (its
// symlinks, which no backend readdir reports), and the mount table (a
// nested mount, whose keys live in another resource entirely).
//
// `base` and `nameBase` differ only when a link is being followed: the
// walk runs over the target while the members keep the link's own name.
async function subtree(
  root: PathSpec,
  base: string,
  nameBase: string,
  deps: ScanDeps,
): Promise<[Entry[], string[]]> {
  const walked = base !== root.virtual ? childSpec(base, root) : root
  const found = new Map<string, [MemberKind, string]>()
  for (const virtual of await deps.walk(walked, 'd')) {
    if (rstripSlash(virtual) !== base) found.set(rstripSlash(virtual), ['dir', ''])
  }
  for (const virtual of await deps.walk(walked, 'f')) {
    found.set(rstripSlash(virtual), ['file', ''])
  }
  const links = deps.links ?? null
  if (links !== null) {
    for (const [virtual, stat] of links.subtree(base)) {
      found.set(rstripSlash(virtual), ['link', linkTarget(stat)])
    }
  }
  const mounts = deps.mounts ?? null
  const crossings = mounts !== null ? mounts.descendants(base) : []
  for (const crossing of crossings) {
    // The mountpoint itself is still an entry, exactly as GNU's
    // --one-file-system keeps the directory and drops its contents.
    found.set(rstripSlash(crossing), ['dir', ''])
  }
  const below = crossings.map((c) => `${rstripSlash(c)}/`)
  const entries: Entry[] = []
  for (const [virtual, [kind, target]] of found) {
    if (below.some((c) => virtual.startsWith(c))) continue
    const named = rstripSlash(nameBase) + virtual.slice(rstripSlash(base).length)
    entries.push({
      namePath: named,
      kind,
      target,
      read: kind === 'file' ? childSpec(virtual, root) : null,
    })
  }
  entries.sort((a, b) => (a.namePath < b.namePath ? -1 : a.namePath > b.namePath ? 1 : 0))
  return [entries, crossings.map((c) => rstripSlash(c))]
}

// What dereferencing puts in the archive in place of one symlink.
//
// The member keeps the link's own name and takes the target's content,
// which is what dereferencing means. Two links resolving to the same
// file are not a loop and both are archived; a real loop is whatever
// `resolve` refuses to resolve, since the namespace already walks the
// chain under a hop limit and raises ELOOP at the end of it. The third
// return value is why the link was unreachable, empty when it was not.
async function follow(
  virtual: string,
  root: PathSpec,
  deps: ScanDeps,
): Promise<[Entry[], string[], string]> {
  const links = deps.links ?? null
  if (links === null) return [[], [], '']
  let target: string
  try {
    target = links.resolve(virtual)
  } catch (e) {
    if (!(e instanceof CycleError)) throw e
    return [[], [], TOO_MANY_LEVELS]
  }
  if (!sameMount(deps.mounts ?? null, virtual, target)) return [[], [OTHER_FILESYSTEM], '']
  const spec = childSpec(target, root)
  let targetStat: FileStat
  try {
    targetStat = await deps.stat(spec)
  } catch {
    return [[], [], NO_SUCH]
  }
  if (targetStat.type !== FileType.DIRECTORY) {
    return [[{ namePath: virtual, kind: 'file', read: spec }], [], '']
  }
  if (!deps.recurse) return [[{ namePath: virtual, kind: 'dir' }], [], '']
  const [entries, crossings] = await subtree(root, target, virtual, deps)
  return [
    [{ namePath: virtual, kind: 'dir' }, ...entries],
    crossings.map(() => OTHER_FILESYSTEM),
    '',
  ]
}

/**
 * Everything one operand contributes to an archive.
 *
 * This is the whole of what tar and zip share: which paths go in, what each
 * one is, and which of them could not be reached. The two formats disagree
 * about the defaults, not the traversal, so both are parameters: tar stores a
 * symlink unless `-h` says to follow it and always descends, zip follows
 * unless `-y` says otherwise and only descends under `-r`.
 */
export async function scanOperand(path: PathSpec, deps: ScanDeps): Promise<Scan> {
  const base = rstripSlash(path.virtual) || '/'
  let entries: Entry[] = []
  let crossings: string[] = []
  const problems: Problem[] = []
  const links = deps.links ?? null
  const linkStat = links !== null ? links.statAt(path.virtual) : null
  if (linkStat !== null && !deps.dereference) {
    entries.push({ namePath: base, kind: 'link', target: linkTarget(linkStat) })
  } else if (linkStat !== null) {
    const [followed, why, unreachable] = await follow(base, path, deps)
    if (unreachable !== '') {
      return {
        entries: [],
        crossings: [],
        problems: [{ path: base, reason: unreachable, fatal: true }],
        missing: true,
      }
    }
    entries.push(...followed)
    problems.push(...why.map((reason) => ({ path: base, reason })))
  } else {
    let rootStat: FileStat
    try {
      rootStat = await deps.stat(path)
    } catch {
      return {
        entries: [],
        crossings: [],
        problems: [{ path: base, reason: NO_SUCH, fatal: true }],
        missing: true,
      }
    }
    if (rootStat.type !== FileType.DIRECTORY) {
      entries.push({ namePath: base, kind: 'file', read: path })
    } else {
      entries.push({ namePath: base, kind: 'dir' })
      if (deps.recurse) {
        const [below, found] = await subtree(path, base, base, deps)
        entries.push(...below)
        crossings = found
      }
    }
  }
  if (deps.dereference && links !== null) {
    const expanded: Entry[] = []
    for (const entry of entries) {
      if (entry.kind !== 'link') {
        expanded.push(entry)
        continue
      }
      const [followed, why, unreachable] = await follow(entry.namePath, path, deps)
      if (unreachable !== '') {
        problems.push({ path: entry.namePath, reason: unreachable, fatal: true })
        continue
      }
      expanded.push(...followed)
      problems.push(...why.map((reason) => ({ path: entry.namePath, reason })))
    }
    entries = expanded
  }
  return { entries, crossings, problems, missing: false }
}
