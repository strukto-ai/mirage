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

import { chunks } from '../../../io/cooperative.ts'
import type { Context } from '../../config.ts'
import type { FollowOperands, LinkView, MountView } from '../../../view/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import type { FileStat, Limit } from '../../../types.ts'
import { type Caller, currentCaller } from '../../../context/session_context.ts'
import { PathSpec } from '../../../types.ts'
import { eloop, isEnoent, isEnotdir } from '../../../errors/fs.ts'
import type { ByteSource } from '../../../io/types.ts'
import { CycleError, posixNormpath, resolvePath } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { type Files, operandsOf, readerOf } from '../../../workspace/files.ts'
import { resolvePathStat } from './paths.ts'

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
    const [data] = await this.dispatch('read', PathSpec.fromStrPath(virtual), [], { stream: true })
    yield* chunks(data as ByteSource)
  }

  /** Write a file on the mount that owns the name. */
  async write(virtual: string, data: ByteSource): Promise<void> {
    await this.dispatch('write', PathSpec.fromStrPath(virtual), [data])
  }

  /** Remove the name itself, a link rather than what it leads to. */
  async unlink(virtual: string): Promise<void> {
    await this.dispatch('unlink', PathSpec.fromStrPath(virtual))
  }
}

function orEloop(resolve: (virtual: string) => string, virtual: string): string {
  try {
    return resolve(virtual)
  } catch (err) {
    if (err instanceof CycleError) throw eloop(virtual)
    throw err
  }
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

/**
 * The symlink facts a walk goes by, read off the session's files, or
 * undefined outside a workspace.
 *
 * The dispatcher's reader answers (`NamespaceReader`), filtered by the rule
 * it refuses a call by: a hidden link, or one that leads where the session
 * cannot see, has no row, no listing entry and no target. Resolving a hidden
 * path leaves it as typed, for the dispatcher to refuse; a visible one
 * resolves, so a walker judges where it lands. Mirrors Python's link_view.
 */
export function linkView(files: Files | undefined): LinkView | undefined {
  if (files === undefined) return undefined
  const seen = readerOf(files)
  if (!seen.linked) return undefined
  return {
    statAt: (path: string) => seen.linkStatAt(path),
    subtree: (directory: string) => seen.linkStatsBelow(directory),
    resolve: (path: string) => posixNormpath(seen.follow(path)),
    exists: async (path: string) => {
      try {
        return (
          (await resolvePathStat(files.dispatch, PathSpec.fromStrPath(path, undefined, '/'))) !==
          null
        )
      } catch (err) {
        console.debug(`link probe at ${path} failed: ${String(err)}`)
        return false
      }
    },
    targetStat: async (path: string) => {
      if (!seen.visible(path)) return null
      try {
        return await files.stat(posixNormpath(seen.follow(path)))
      } catch (err) {
        if (!(err instanceof CycleError) && !isEnoent(err) && !isEnotdir(err)) throw err
        console.debug(`link target of ${path} has no row: ${String(err)}`)
        return null
      }
    },
  }
}

/**
 * Where the mount boundaries are, read off the session's files, or undefined
 * outside a workspace. Every mount below a path, hidden or not, is a boundary
 * a backend's own walk stops at; only the visible ones are ever named. A walk
 * through the dispatcher (`crossing`) has no boundary to stop at
 * (`NamespaceReader.mounts`). Mirrors Python's mount_view.
 */
export function mountView(
  files: Files | undefined,
  crossing = false,
  command: string | null = null,
  profile: Readonly<Record<string, Limit>> = {},
): MountView | undefined {
  if (files === undefined) return undefined
  return readerOf(files).mounts(crossing, command, profile)
}

/**
 * The names a directory holds only as namespace structure, as the session
 * sees them: the mounts below it and its links, each by its first segment
 * under the directory.
 *
 * No backend can list either, and the first may be one no backend serves at
 * all (a link made below a directory chain that holds no key); these are the
 * names the dispatcher merges into its own listing, from the same tables.
 * Mirrors Python's owed_names.
 */
export function owedNames(files: Files | undefined, directory: string): string[] {
  if (files === undefined) return []
  return readerOf(files).owed(directory)
}

/** The workspace's links as the command's session sees them, read off its
 * files; undefined outside a workspace. Mirrors Python's links_of. */
export function linksOf(ctx: Context): LinkView | undefined {
  return linkView(ctx.vfs)
}

/**
 * The mount whose command scope the command runs in, null for none: the one
 * its files were said to run in (`Files.servedBy`), so a read after an await
 * answers for this run even where the async context does not isolate tasks;
 * else the context's.
 */
function servingMount(files: Files): Caller['mount'] {
  return files.served !== undefined ? files.served : currentCaller().mount
}

/**
 * Whether the command walks across mounts: it runs on the session's files
 * with no mount's command scope bound, as a cross-mount run does, so every
 * call it makes reaches whichever mount serves the path. Mirrors Python's
 * crosses_mounts.
 */
export function crossesMounts(ctx: Context): boolean {
  return ctx.vfs !== undefined && servingMount(ctx.vfs) === null
}

/**
 * The prefix of the mount the command runs on, without its trailing slash:
 * what a path the command makes up (an output name, a file a list names) is
 * keyed below. '' for a run across mounts, which keys every path by its
 * whole virtual path, and outside a workspace. Mirrors Python's mount_root.
 */
export function mountRoot(ctx: Context): string {
  const mount = ctx.vfs === undefined ? null : servingMount(ctx.vfs)
  return mount === null ? '' : rstripSlash(mount[0])
}

/**
 * Where the mount boundaries are for the command's walk, read off its files;
 * undefined outside a workspace. A run across mounts (`crossesMounts`) has
 * the dispatcher descend into every mount, so it has no boundary to stop at.
 * Mirrors Python's mounts_of.
 */
export function mountsOf(ctx: Context): MountView | undefined {
  return mountView(
    ctx.vfs,
    crossesMounts(ctx),
    ctx.spec?.name ?? null,
    ctx.session?.access().commandLimits ?? {},
  )
}

/** The link resolver an invocation carries: null outside a workspace.
 * Mirrors Python's link_resolver. */
export function linkResolver(ctx: Context): LinkResolver | null {
  const links = linksOf(ctx)
  if (links === undefined || ctx.vfs === undefined) return null
  return new LinkResolver(links, ctx.vfs.dispatch, ctx.cwd.virtual)
}

/** The dispatcher a command's files run on. Mirrors Python's dispatch_of. */
export function dispatchOf(ctx: Context): DispatchFn | undefined {
  return ctx.vfs?.dispatch
}

/** The line's operand resolution its files carry. Mirrors Python's follow_of. */
export function followOf(ctx: Context): FollowOperands | undefined {
  return ctx.vfs === undefined ? undefined : (operandsOf(ctx.vfs) ?? undefined)
}
