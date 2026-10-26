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

import { resolveLimit } from '../../policy/builtin/output_cap.ts'
import { type FileStat, Limit, PathSpec, type Visibility } from '../../types.ts'
import { hiddenUnder, leadsHidden, pathVisible } from '../../utils/hidden.ts'
import { norm } from '../../utils/path.ts'
import { normDir, ownerPrefix, rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { namespaceNames } from '../../view/namespace_view.ts'
import type { MountView, NamespaceLinks } from '../../view/types.ts'
import type { MountRow } from '../types.ts'

/**
 * Whether a session sees a path: it is not hidden, and no link on it leads
 * where the session cannot see.
 *
 * The rule the dispatcher refuses a call by, and the one every answer a
 * `NamespaceReader` gives is filtered by. Mirrors Python's `sees`.
 */
export function sees(
  vis: Visibility | null,
  links: NamespaceLinks | null,
  virtual: string,
): boolean {
  if (!pathVisible(vis, virtual)) return false
  if (vis === null || links === null) return true
  return !leadsHidden(vis, virtual, links.symlinkTargets())
}

/**
 * What one session sees of the namespace: its links and its mounts.
 *
 * The namespace the dispatcher answers from owns the link table and the mount
 * table and hands this out (`Namespace.readers`); it is the one way anything
 * above the dispatcher reads them. Every answer is filtered by the rule the
 * dispatcher refuses a call by (`sees`): a hidden link, or one that leads
 * where the session cannot see, has no row, no listing entry and no target,
 * and a hidden mount is a boundary a walk stops at but is never named. It is a
 * link table itself (`NamespaceLinks`), the namespace's as the session sees
 * it, so whatever takes a link table above the dispatcher is handed this one.
 * Live, so a link made or removed mid-command is seen by the next question,
 * and synchronous, so a walk asks per entry at no dispatch cost. Mirrors
 * Python's `NamespaceReader`.
 */
export class NamespaceReader implements NamespaceLinks {
  /**
   * @param links the namespace's link table, null where the files stand
   *   outside a workspace.
   * @param allRows every registered mount.
   * @param sessionId the session the answers are for, which decides the
   *   mounts it is told of at all.
   * @param visibility the visibility of that session, asked when a question is.
   */
  constructor(
    private readonly links: NamespaceLinks | null,
    private readonly allRows: () => readonly MountRow[],
    private readonly sessionId: string | null,
    private readonly visibility: () => Visibility | null,
  ) {}

  /** Whether a link table stands behind the answers. */
  get linked(): boolean {
    return this.links !== null
  }

  /** Whether the session sees `path` (`sees`). */
  visible(path: string | PathSpec): boolean {
    const virtual = PathSpec.fromStrPath(path, undefined, '/').virtual
    return sees(this.visibility(), this.links, virtual)
  }

  /**
   * Whether the session could hide anything at or under `path`, so a reader
   * of a store of its own (a repository's history, say) has to ask `visible`
   * of what it finds there.
   */
  hidesUnder(path: string | PathSpec): boolean {
    const virtual = PathSpec.fromStrPath(path, undefined, '/').virtual
    const vis = this.visibility()
    if (hiddenUnder(vis, virtual)) return true
    if (this.links === null || !hiddenUnder(vis, '/')) return false
    // `visible` follows links, so a link at, under or above the path can lead
    // where the session hides even when nothing named under the path is hidden.
    const below = `${rstripSlash(virtual)}/`
    return [...this.links.symlinkTargets().keys()].some(
      (link) =>
        link === virtual || link.startsWith(below) || virtual.startsWith(`${rstripSlash(link)}/`),
    )
  }

  /**
   * Every registered mount, hides and sessions aside, longest prefix first:
   * what a facade's record asks of the mount table.
   */
  rows(): MountRow[] {
    return [...this.allRows()].sort((a, b) => b.prefix.length - a.prefix.length)
  }

  /** The registered mount owning `path` by longest prefix. */
  owner(path: string): MountRow | null {
    const rows = this.rows()
    const found = ownerPrefix(
      rows.map((m) => m.prefix),
      path,
    )
    return rows.find((m) => m.prefix === found) ?? null
  }

  /**
   * The mounts the session is told of at all, hides aside. A session's own
   * documents mount is one only it is told of.
   */
  served(): MountRow[] {
    return this.rows().filter(
      (m) => m.visible === undefined || m.visible === null || m.visible(this.sessionId),
    )
  }

  /**
   * The mounts whose root the session sees. A hidden mount is left out of
   * every list here, as it is left out of a listing, so no list names it.
   */
  shown(): MountRow[] {
    const vis = this.visibility()
    return this.served().filter((m) => pathVisible(vis, norm(m.prefix)))
  }

  /**
   * The prefix of the mount serving `path`, without a trailing slash; null
   * for a path the session cannot see.
   */
  mountOf(path: string | PathSpec): string | null {
    const virtual = PathSpec.fromStrPath(path, undefined, '/').virtual
    if (!pathVisible(this.visibility(), virtual)) return null
    const owner = ownerPrefix(
      this.served().map((m) => m.prefix),
      virtual,
    )
    return owner === null ? null : norm(owner)
  }

  /** Whether `path` is the root of a mount the session sees. */
  isMount(path: string | PathSpec): boolean {
    const virtual = norm(PathSpec.fromStrPath(path, undefined, '/').virtual)
    return this.shown().some((m) => norm(m.prefix) === virtual)
  }

  /**
   * The mount roots strictly under `path`, sorted, without a trailing slash;
   * a hidden one reported by the nearest folder above it the session sees.
   */
  submounts(path: string | PathSpec): string[] {
    const virtual = norm(PathSpec.fromStrPath(path, undefined, '/').virtual)
    const vis = this.visibility()
    if (!pathVisible(vis, virtual)) return []
    const below = normDir(virtual)
    const found = new Set<string>()
    for (const m of this.served()) {
      let root = norm(m.prefix)
      if (root === virtual || !normDir(root).startsWith(below)) continue
      while (root !== virtual && !pathVisible(vis, root)) {
        root = root.slice(0, root.lastIndexOf('/')) || '/'
      }
      found.add(root)
    }
    return [...found].sort(compareCodePoints)
  }

  /** Whether a link the session sees stands at `path`. */
  isLink(path: string): boolean {
    return this.links !== null && this.visible(path) && this.links.isLink(path)
  }

  /**
   * The link standing at a path, its own row; null where none stands or the
   * session cannot see it.
   */
  linkStatAt(path: string): FileStat | null {
    if (this.links === null || !this.visible(path)) return null
    return this.links.linkStatAt(path)
  }

  /**
   * Every link the session sees, to its stored target. A session that hides
   * nothing sees the whole table, which is asked of no link.
   */
  symlinkTargets(): ReadonlyMap<string, string> {
    if (this.links === null) return new Map()
    const targets = this.links.symlinkTargets()
    const vis = this.visibility()
    if (vis === null || !hiddenUnder(vis, '/')) return targets
    return new Map([...targets].filter(([path]) => this.visible(path)))
  }

  /** The links at any depth under a directory the session sees, each with its own row. */
  linkStatsBelow(directory: string): [string, FileStat][] {
    if (this.links === null) return []
    return this.links.linkStatsBelow(directory).filter(([path]) => this.visible(path))
  }

  /**
   * The names of the links directly under a directory that the session sees,
   * which a listing's link marks need.
   */
  linkNamesUnder(directory: string): Set<string> {
    if (this.links === null) return new Set()
    const base = directory === '/' ? '/' : `${rstripSlash(directory)}/`
    return new Set(
      [...this.links.linkNamesUnder(directory)].filter((name) => this.visible(base + name)),
    )
  }

  /**
   * A link's stored target, as typed; null where no link stands or the
   * session cannot see it.
   */
  readlink(path: string): string | null {
    if (this.links === null || !this.visible(path)) return null
    return this.links.readlink(path)
  }

  /**
   * Where a path the session sees leads, every link followed; one it cannot
   * see, a link on it leading through a hide included, is left as typed, for
   * the dispatcher to refuse. Throws CycleError where a link loop stands in
   * the walk.
   */
  follow(path: string): string {
    if (this.links === null || !this.visible(path)) return path
    return this.links.follow(path)
  }

  /**
   * A path with every link above its final name followed, the walk a call
   * that acts on the name itself is given; a path the session cannot see is
   * left as typed.
   * Throws CycleError where a link loop stands in the walk.
   */
  followParent(path: string): string {
    if (this.links === null || !this.visible(path)) return path
    return this.links.followParent(path)
  }

  /**
   * The names a directory holds only as namespace structure: the mounts
   * below it and its links, by their first segment under it.
   */
  owed(directory: string): string[] {
    return namespaceNames(
      this.visibility(),
      this.served().map((m) => m.prefix),
      this.links,
      directory,
    )
  }

  /**
   * Where the mount boundaries are, as the session sees them.
   *
   * Every mount below a path, hidden or not, is a boundary a backend's own
   * walk stops at: a mount the session cannot see still shadows the parent
   * backend's keys under its prefix. Only the visible ones are ever named. A
   * walk through the dispatcher (`crossing`) descends into each mount itself,
   * so it has no boundary to stop at: no mount below a path, and no mount
   * root; and it takes no mount's shortcut, so no mount answers a function
   * for it or narrows its search. A walk's `walkLimit` on each mount is
   * `command`'s, resolved through the session's `profile`, the mount's and
   * the workspace's command limits; without a command, the mount's own.
   */
  mounts(
    crossing: boolean,
    command: string | null = null,
    profile: Readonly<Record<string, Limit>> = {},
  ): MountView {
    const below = (path: string): string[] => {
      if (crossing) return []
      const base = normDir(path)
      return this.served()
        .map((m) => m.prefix)
        .filter((prefix) => prefix !== base && prefix.startsWith(base))
        .sort(compareCodePoints)
        .map((prefix) => rstripSlash(prefix) || '/')
    }
    const owner = (path: string): MountRow | null => {
      const served = this.served()
      const found = ownerPrefix(
        served.map((m) => m.prefix),
        path,
      )
      return served.find((m) => m.prefix === found) ?? null
    }
    return {
      descendants: below,
      visibleDescendants: (path: string) => {
        const vis = this.visibility()
        return below(path).filter((root) => pathVisible(vis, root))
      },
      isRoot: (path: string) => !crossing && this.served().some((m) => m.prefix === normDir(path)),
      rootOf: (path: string) => owner(path)?.prefix ?? '/',
      answers: (path: string, name: string) =>
        !crossing && (owner(path)?.calls?.has(name) ?? false),
      searchable: (path: string) => (crossing ? null : (owner(path)?.searchable ?? null)),
      walkLimit: (path: string) => {
        const row = owner(path)
        if (row === null) return -1
        const own = row.walkLimit ?? -1
        if (command === null) return own
        const found = resolveLimit(
          command,
          [
            {
              commandLimits: new Map(row.commandLimits ?? []),
              defaultLimit: new Limit({ walkLimit: own }),
            },
          ],
          null,
          null,
          row.workspaceLimits ?? {},
          profile,
        )
        return found?.walkLimit ?? own
      },
    }
  }
}
