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

import type { CommandOpts } from '../../config.ts'
import type { LinkView } from '../../../doors/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { type FileStat, PathSpec } from '../../../types.ts'
import { eloop } from '../../../errors/fs.ts'
import { CycleError, resolvePath } from '../../../utils/path.ts'

/**
 * Where the name an operand was typed as stands, as lstat reaches it.
 *
 * Every component but the last resolves through the links, as the kernel
 * walks any path, so `dl/tl.gz` with `dl` a link to `dir` stands at
 * `dir/tl.gz`: the table keys every link by that resolved parent. Null where
 * the last component resolves as well, which is a name typed with a trailing
 * slash or ending in a dot, and where the walk already failed. Mirrors
 * Python's name_location.
 */
export function nameLocation(links: LinkView, path: PathSpec, cwd: string): string | null {
  const typed = path.rawPath !== '' ? path.rawPath : path.virtual
  const last = typed.slice(typed.lastIndexOf('/') + 1)
  if (path.walkError !== null || typed.endsWith('/') || last === '.' || last === '..') return null
  const full = resolvePath(typed, cwd)
  const cut = full.lastIndexOf('/')
  const parent = full.slice(0, cut)
  const resolved = links.resolve(parent === '' ? '/' : parent).replace(/\/+$/, '')
  return `${resolved}/${full.slice(cut + 1)}`
}

/**
 * The link standing at the name an operand was typed as, its own row.
 *
 * The router follows an operand through its link before the command runs,
 * which leaves `virtual` at the target and the name in `rawPath`; a command
 * that acts on the name itself (cp -P, gzip's O_NOFOLLOW open) asks here.
 * Null where no link stands at the name. Mirrors Python's typed_link.
 */
export function typedLink(links: LinkView, path: PathSpec, cwd: string): FileStat | null {
  const where = nameLocation(links, path, cwd)
  return where === null ? null : links.statAt(where)
}

/**
 * The namespace's links as a command meets a name, and the door past them.
 *
 * A link is invisible to every backend, so a command bound to one mount needs
 * the links to tell a name that stands on one, and the op door to act where
 * the link leads or where it stands: the target may live on any mount, and so
 * may the link. Mirrors Python's LinkDoor.
 */
export class LinkDoor {
  constructor(
    readonly links: LinkView,
    readonly dispatch: DispatchFn,
    readonly cwd: string,
  ) {}

  /** Where the link standing at an operand's name sits, null where no link
   * stands there. */
  linkAt(path: PathSpec): string | null {
    const where = nameLocation(this.links, path, this.cwd)
    if (where === null || this.links.statAt(where) === null) return null
    return where
  }

  /**
   * Whether the link the router followed an operand through is gone.
   *
   * The router follows every operand before the command runs, so an earlier
   * operand that removed the link (`gunzip -f l.gz l.gz`) leaves a later one
   * at the old target: GNU opens each name when it reaches it, and finds
   * nothing there.
   */
  vanished(path: PathSpec): boolean {
    const where = nameLocation(this.links, path, this.cwd)
    return where !== null && where !== path.virtual && this.links.statAt(where) === null
  }

  /**
   * The links standing directly in a directory, as virtual paths: what a
   * walker merges into a backend's listing, which never holds a link.
   * `directory` has every link above it resolved, which is how the table
   * keys its links.
   */
  children(directory: string): string[] {
    const base = directory.replace(/\/+$/, '')
    return this.links.children(directory).map((row) => `${base}/${row.name}`)
  }

  /**
   * Where a link leads, every link on the way followed. A chain that loops
   * throws ELOOP, an error a walker reports as it reports any failed stat.
   */
  target(link: string): string {
    try {
      return this.links.resolve(link)
    } catch (err) {
      if (err instanceof CycleError) throw eloop(link)
      throw err
    }
  }

  /** What a name leads to, its stat through the door, on any mount. */
  async stat(virtual: string): Promise<FileStat> {
    const [stat] = await this.dispatch('stat', PathSpec.fromStrPath(virtual))
    return stat as FileStat
  }

  /** A directory's entries through the door, links among them. */
  async readdir(virtual: string): Promise<string[]> {
    const [entries] = await this.dispatch('readdir', PathSpec.fromStrPath(virtual))
    return [...(entries as string[])]
  }

  /** A name's own stat through the door: a link's, not its target's. */
  async lstat(path: PathSpec): Promise<FileStat> {
    const [stat] = await this.dispatch('stat', path, [], { nofollow: true })
    return stat as FileStat
  }

  /** What a name leads to, read through the door, which follows it. */
  async *read(virtual: string): AsyncIterable<Uint8Array> {
    const [data] = await this.dispatch('read', PathSpec.fromStrPath(virtual))
    yield data as Uint8Array
  }

  /** Write a file on the mount that owns the name. */
  async write(virtual: string, data: Uint8Array): Promise<void> {
    await this.dispatch('write', PathSpec.fromStrPath(virtual), [data])
  }

  /** Remove the name itself, a link rather than what it leads to. */
  async unlink(virtual: string): Promise<void> {
    await this.dispatch('unlink', PathSpec.fromStrPath(virtual))
  }
}

/** The link door an invocation carries: null when the namespace holds no
 * link, the fast path, or outside a workspace. Mirrors Python's link_door. */
export function linkDoor(opts: CommandOpts): LinkDoor | null {
  const links = opts.ns?.links
  if (links === undefined || opts.dispatch === undefined) return null
  return new LinkDoor(links, opts.dispatch, opts.cwd)
}
