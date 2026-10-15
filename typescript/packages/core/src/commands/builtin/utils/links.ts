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

import type { CommandIO, CommandOpts } from '../../config.ts'
import type { Accessor } from '../../../accessor/base.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import type { LinkView, MountView } from '../../../view/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { eloop, isEnoent, isEnotdir } from '../../../errors/fs.ts'
import { CycleError, gnuBasename, resolvePath } from '../../../utils/path.ts'
import { compareCodePoints } from '../../../utils/sort.ts'

/**
 * Where a name stands as lstat reaches it: every link above its final name
 * followed, the name itself kept.
 *
 * The walk the kernel gives a path before a call that does not follow its
 * final name, and the key the table files a link under, since every link is
 * keyed by its resolved parent. A path ending in a slash resolves whole:
 * POSIX reads `dlink/` as `dlink/.`. Throws CycleError on a loop. Mirrors
 * Python's link_location.
 */
export function linkLocation(links: LinkView, virtual: string): string {
  const cut = virtual.lastIndexOf('/')
  const name = virtual.slice(cut + 1)
  if (name === '') return links.resolve(virtual)
  const head = virtual.slice(0, cut)
  return `${links.resolve(head === '' ? '/' : head).replace(/\/+$/, '')}/${name}`
}

/**
 * The names the links owe a directory: each link standing in it, and each
 * directory holding one further down.
 *
 * No backend can list either, and the second may be one no backend serves at
 * all (a link made below a directory chain that holds no key), so these are the
 * names the dispatcher merges into its own listing, derived from the same
 * table. Mirrors Python's owed_names.
 */
export function owedNames(links: LinkView, directory: string): string[] {
  const base = directory.replace(/\/+$/, '') + '/'
  const names = new Set<string>()
  for (const [path] of links.subtree(base)) {
    names.add(path.slice(base.length).split('/')[0] ?? '')
  }
  return [...names].sort(compareCodePoints)
}

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
  return linkLocation(links, resolvePath(typed, cwd))
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
 * The namespace's links as a command meets a name, and the dispatcher past them.
 *
 * A link is invisible to every backend, so a command bound to one mount needs
 * the links to tell a name that stands on one, and the dispatcher to act where
 * the link leads or where it stands: the target may live on any mount, and so
 * may the link. Mirrors Python's LinkResolver.
 */
export class LinkResolver {
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
   * Where a link leads, every link on the way followed. A chain that loops
   * throws ELOOP, an error a walker reports as it reports any failed stat.
   */
  target(link: string): string {
    return orEloop((path) => this.links.resolve(path), link)
  }

  /** What a name leads to, its stat through the dispatcher, on any mount. */
  async stat(virtual: string): Promise<FileStat> {
    const [stat] = await this.dispatch('stat', PathSpec.fromStrPath(virtual))
    return stat as FileStat
  }

  /** A directory's entries through the dispatcher, links among them. */
  async readdir(virtual: string): Promise<string[]> {
    const [entries] = await this.dispatch('readdir', PathSpec.fromStrPath(virtual))
    return [...(entries as string[])]
  }

  /** A name's own stat through the dispatcher: a link's, not its target's. */
  async lstat(path: PathSpec): Promise<FileStat> {
    const [stat] = await this.dispatch('stat', path, [], { nofollow: true })
    return stat as FileStat
  }

  /** What a name leads to, read through the dispatcher, which follows it. */
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

// What a table miss is: the name is not there, or a component above it is
// not a directory. Mirrors Python's _MISSES.
function missed(err: unknown): boolean {
  return isEnoent(err) || isEnotdir(err)
}

function orEloop(resolve: (virtual: string) => string, virtual: string): string {
  try {
    return resolve(virtual)
  } catch (err) {
    if (err instanceof CycleError) throw eloop(virtual)
    throw err
  }
}

function named(row: FileStat, virtual: string): FileStat {
  const name = gnuBasename(virtual)
  return row.name === name ? row : row.with({ name })
}

/** An entry the dispatcher listed under `where`, named under `base`. Mirrors
 * Python's _rebased. */
function rebased(entry: string, where: string, base: string): string {
  const root = where.replace(/\/+$/, '') + '/'
  return `${base}/${entry.startsWith(root) ? entry.slice(root.length) : gnuBasename(entry)}`
}

/** Whether the mount at `prefix` is the one serving `virtual`; every path is
 * where no mount table says otherwise. Mirrors Python's serves. */
export function serves(mounts: MountView | undefined, prefix: string, virtual: string): boolean {
  return mounts === undefined || mounts.rootOf(virtual).replace(/\/+$/, '') === prefix
}

/**
 * The mount a walked path lands on, every link on it followed. A mount is
 * mirage's filesystem, so this stands for the device stat(2) reports, which
 * `find -xdev` compares with the start point's: a link onto another mount
 * leaves it as a mount root does (findutils 4.10). `virtual` is a directory
 * the walk reached, which resolves. Mirrors Python's landing_root.
 */
export function landingRoot(mounts: MountView, links: LinkView | null, virtual: string): string {
  return mounts.rootOf(links !== null ? links.resolve(virtual) : virtual)
}

async function linkedStat<A extends Accessor>(
  stat: CommandIO<A>['stat'],
  links: LinkView,
  dispatch: DispatchFn,
  owns: (virtual: string) => boolean,
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const here = path.virtual
  const where = orEloop((virtual) => linkLocation(links, virtual), here)
  const row = here.endsWith('/') ? null : links.statAt(where)
  if (row !== null) return row
  if (where.replace(/\/+$/, '') !== here.replace(/\/+$/, '') || !owns(where)) {
    const [found] = await dispatch('stat', PathSpec.fromStrPath(where), [], { nofollow: true })
    return named(found as FileStat, here)
  }
  try {
    return await stat(accessor, path, index)
  } catch (err) {
    if (!missed(err) || owedNames(links, here).length === 0) throw err
    console.debug(`${here}: a directory for the links below it: ${String(err)}`)
    return new FileStat({ name: gnuBasename(here), type: FileType.DIRECTORY })
  }
}

async function linkedReaddir<A extends Accessor>(
  readdir: CommandIO<A>['readdir'],
  links: LinkView,
  dispatch: DispatchFn,
  owns: (virtual: string) => boolean,
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const here = path.virtual.replace(/\/+$/, '') || '/'
  const where = orEloop((virtual) => links.resolve(virtual), here)
  const base = here.replace(/\/+$/, '')
  if (where !== here || !owns(where)) {
    const [listed] = await dispatch('readdir', PathSpec.fromStrPath(where))
    return (listed as string[]).map((entry) => rebased(entry, where, base))
  }
  const owed = owedNames(links, here)
  let entries: string[]
  try {
    entries = await readdir(accessor, path, index)
  } catch (err) {
    if (!missed(err) || owed.length === 0) throw err
    console.debug(`${here}: listed for the links below it: ${String(err)}`)
    entries = []
  }
  if (owed.length === 0) return entries
  const present = new Set(entries.map((entry) => entry.replace(/\/+$/, '')))
  return [...entries, ...owed.map((n) => `${base}/${n}`).filter((entry) => !present.has(entry))]
}

async function linkedTree<A extends Accessor>(
  readTree: NonNullable<CommandIO<A>['readTree']>,
  links: LinkView,
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Map<string, FileStat> | null> {
  const found = await readTree(accessor, path, index)
  const base = path.virtual.replace(/\/+$/, '') + '/'
  const rows = links.subtree(base)
  if (found === null || rows.length === 0) return found
  const merged = new Map(found)
  for (const [key, row] of rows) merged.set(key.slice(base.length), row)
  return merged
}

/**
 * `ops` whose stat, readdir and subtree read see the namespace's links, the
 * way the dispatcher's own do.
 *
 * No backend stores a link, so a mount's table asked about a name a link
 * stands at answers ENOENT, its listing leaves the link out, and a name below a
 * link to a directory reaches nothing. Here the table answers once for every
 * command: `stat` is lstat (a link's own row, and the dispatcher's answer for a
 * name a link above it leads elsewhere), `readdir` names the links among the
 * backend's entries and lists a directory a link leads to through the
 * dispatcher, `readTree` carries the links under its root, and a directory that
 * holds only a link stats and lists as the dispatcher's does. What a command
 * does with a link, follow it, copy it or leave it, stays its own rule. `owns`
 * says whether this mount serves a path; one a link led to on another mount
 * goes to the dispatcher. Mirrors Python's with_links.
 */
export function withLinks<A extends Accessor>(
  ops: CommandIO<A>,
  links: LinkView | undefined,
  dispatch: DispatchFn | undefined,
  owns: (virtual: string) => boolean,
): CommandIO<A> {
  if (links === undefined || dispatch === undefined) return ops
  const { stat, readdir, readTree } = ops
  return {
    ...ops,
    stat: (accessor, path, index) => linkedStat(stat, links, dispatch, owns, accessor, path, index),
    readdir: (accessor, path, index) =>
      linkedReaddir(readdir, links, dispatch, owns, accessor, path, index),
    ...(readTree !== undefined
      ? {
          readTree: (accessor: A, path: PathSpec, index?: IndexCacheStore) =>
            linkedTree(readTree, links, accessor, path, index),
        }
      : {}),
  }
}

/** The link resolver an invocation carries: null when the namespace holds no
 * link, the fast path, or outside a workspace. Mirrors Python's link_resolver. */
export function linkResolver(opts: CommandOpts): LinkResolver | null {
  const links = opts.ns?.links
  if (links === undefined || opts.dispatch === undefined) return null
  return new LinkResolver(links, opts.dispatch, opts.cwd)
}
