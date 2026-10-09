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

import type {
  MkdirOp,
  ReadBytesOp,
  ResolveGlobOp,
  SearchQuery,
  StatOp,
} from '../../../vfs/types.ts'
import type { BaseVFS, FindOptions } from '../../../vfs/base.ts'
import { getExtension } from '../../../utils/filetype.ts'
import { streamFromBytes } from '../utils/wrap.ts'
import { ensureStream } from '../../../io/stream.ts'
import { materialize, type ByteSource } from '../../../io/types.ts'

import type { Accessor } from '../../../accessor/base.ts'
import {
  requirePathsWritable,
  effectivePathMode,
  getAdmission,
  getCurrentSession,
  hiddenRefusal,
  mountGateFor,
  sessionVisibility,
  walkProbeFor,
} from '../../../context/session_context.ts'
import { pathsScoped } from '../../../view/namespace_view.ts'
import { METADATA_OPS } from '../../../policy/constants.ts'
import { preVfsGate, type Policies, getOpPolicies } from '../../../policy/policies.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { hasAborted } from '../../../workspace/abort.ts'
import { makeAbortError } from '../../../concurrency/limiter.ts'
import { hiddenUnder, moveReveals, pathVisible } from '../../../utils/hidden.ts'
import { removeRemnants, visibleBelow, type RemnantChannel } from '../../../utils/remnants.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { refuseTaken } from '../../../core/generic/rewrite.ts'
import type { NamespaceView, StatOverlay } from '../../../view/types.ts'

import {
  FileType,
  MountMode,
  PathSpec,
  type FileStat,
  type SetAttrFields,
  type WalkProbe,
} from '../../../types.ts'
import {
  eacces,
  eexist,
  eisdir,
  enoent,
  enotdir,
  enotsup,
  erofs,
  isDotWalkError,
  isEnoent,
  isEnotdir,
  isMissError,
  walkRefusal,
} from '../../../errors/fs.ts'
import { dotRefusal } from '../utils/paths.ts'
import { makeResolveGlob } from '../../../utils/glob_walk.ts'
import { norm, parent } from '../../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'

import type {
  AggregateFn,
  CommandFn,
  CommandFnResult,
  CommandIO,
  CommandOpts,
} from '../../config.ts'

/**
 * The table of the mount a command runs on. Throws when the command ran
 * outside a mount. Mirrors Python's `mount_io`.
 */
export function mountIo(opts: CommandOpts): CommandIO {
  if (opts.io === undefined)
    throw new TypeError(`${opts.command ?? ''}: ran without its mount's table`)
  return opts.io
}

/**
 * A handler that builds `build`'s handler over the running mount's table,
 * wrapped by `wrap`, on every call. For a builder that reads its slots
 * once, up front: the table is the mount's, so it is only known once a
 * command runs. Mirrors Python's `over_mount_io`.
 */
export function overMountIo(
  build: (io: CommandIO) => CommandFn,
  wrap?: (io: CommandIO) => CommandIO,
): CommandFn {
  return (accessor, paths, texts, opts) => {
    const io = mountIo(opts)
    return build(wrap === undefined ? io : wrap(io))(accessor, paths, texts, opts)
  }
}

// What a command calls a slot with: the accessor in front, which the VFS
// holds itself, so it is dropped here.
function withoutAccessor<T extends unknown[], R>(
  method: (...args: T) => R,
): (accessor: unknown, ...args: T) => R {
  return (_accessor, ...args) => method(...args)
}

async function existsByStat(vfs: BaseVFS, path: PathSpec): Promise<boolean> {
  try {
    await vfs.stat(path)
    return true
  } catch (error) {
    if (isEnoent(error) || isEnotdir(error)) return false
    throw error
  }
}

// What a command reads: the stored bytes through `vfs.read`, so an in-place
// edit (`sed -i`) writes back what it read and a byte read agrees with a
// stream. Only a VFS with no `read` of its own (gdocs, gsheets, gslides,
// whose stored form is the rendering) is read through the renderer of the
// path's filetype. Both are looked up per call, as the op door looks them
// up; the op door renders for the surfaces that show files. Mirrors
// Python's `_reader`.
function reader(
  vfs: BaseVFS,
): (
  path: PathSpec,
  index?: IndexCacheStore,
  offset?: number,
  size?: number | null,
) => Promise<Uint8Array> {
  return (path, index, offset = 0, size = null) => {
    const renderer = vfs.supports('read')
      ? undefined
      : vfs.renderers[getExtension(path.virtual) ?? '']
    if (renderer === undefined) return vfs.read(path, index, offset, size)
    const render = (vfs as unknown as Record<string, typeof vfs.read>)[renderer]
    if (render === undefined) throw new TypeError(`${vfs.name}: no renderer named ${renderer}`)
    return render.call(vfs, path, index, offset, size)
  }
}

/**
 * The command tier's table for `vfs`, built from its functions.
 *
 * A function the VFS does not define is an absent slot, except the two
 * every reader needs: a stream, which reads the file whole when the VFS
 * does not stream, and an existence check, which asks `stat`. A ranged
 * read is the VFS's own `read` only when it reads ranges. Mirrors Python's
 * `command_io`.
 */
export function commandIo(vfs: BaseVFS): CommandIO {
  const has = (name: string): boolean => vfs.supports(name)
  const read = reader(vfs)
  const readBytes: ReadBytesOp = (_accessor, path, index) => read(path, index)
  const streams = has('readStream')
  return {
    readdir: withoutAccessor((path: PathSpec, index?: IndexCacheStore) => vfs.readdir(path, index)),
    readBytes,
    stat: withoutAccessor((path: PathSpec, index?: IndexCacheStore) => vfs.stat(path, index)),
    readStream: streams
      ? withoutAccessor((path: PathSpec, index?: IndexCacheStore) => vfs.readStream(path, index))
      : (a, p, i) => streamFromBytes(readBytes, a, p, i),
    ...(vfs.readsRanges
      ? {
          readRange: (
            _a: Accessor,
            path: PathSpec,
            index: IndexCacheStore | undefined,
            offset: number,
            size: number | null,
          ) => read(path, index, offset, size),
        }
      : {}),
    exists: has('exists')
      ? withoutAccessor((path: PathSpec) => vfs.exists(path))
      : (_a: Accessor, path: PathSpec) => existsByStat(vfs, path),
    ...(has('find')
      ? {
          find: withoutAccessor((path: PathSpec, options: FindOptions, index?: IndexCacheStore) =>
            vfs.find(path, options, index),
          ),
        }
      : {}),
    ...(has('duSize') && has('duEntries')
      ? {
          du: {
            size: withoutAccessor((path: PathSpec, index?: IndexCacheStore) =>
              vfs.duSize(path, index),
            ),
            entries: withoutAccessor((path: PathSpec, index?: IndexCacheStore) =>
              vfs.duEntries(path, index),
            ),
          },
        }
      : {}),
    ...(has('write')
      ? { write: withoutAccessor((p: PathSpec, d: Uint8Array) => vfs.write(p, d)) }
      : {}),
    ...(has('append')
      ? { append: withoutAccessor((p: PathSpec, d: Uint8Array) => vfs.append(p, d)) }
      : {}),
    ...(has('pwrite')
      ? { pwrite: withoutAccessor((p: PathSpec, d: Uint8Array, o: number) => vfs.pwrite(p, d, o)) }
      : {}),
    ...(has('create') ? { create: withoutAccessor((p: PathSpec) => vfs.create(p)) } : {}),
    ...(has('mkdir')
      ? { mkdir: withoutAccessor((p: PathSpec, parents?: boolean) => vfs.mkdir(p, parents)) }
      : {}),
    ...(has('unlink') ? { unlink: withoutAccessor((p: PathSpec) => vfs.unlink(p)) } : {}),
    ...(has('rmdir')
      ? { rmdir: withoutAccessor((p: PathSpec, index?: IndexCacheStore) => vfs.rmdir(p, index)) }
      : {}),
    ...(has('rmR') ? { rmR: withoutAccessor((p: PathSpec) => vfs.rmR(p)) } : {}),
    ...(has('rename')
      ? { rename: withoutAccessor((src: PathSpec, dst: PathSpec) => vfs.rename(src, dst)) }
      : {}),
    ...(has('copy')
      ? { copy: withoutAccessor((src: PathSpec, dst: PathSpec) => vfs.copy(src, dst)) }
      : {}),
    ...(has('dirCopy')
      ? { dirCopy: withoutAccessor((src: PathSpec, dst: PathSpec) => vfs.dirCopy(src, dst)) }
      : {}),
    ...(has('truncate')
      ? {
          truncate: withoutAccessor((p: PathSpec, length: number, noCreate?: boolean) =>
            vfs.truncate(p, length, noCreate),
          ),
        }
      : {}),
    ...(has('setattr')
      ? {
          setAttrs: withoutAccessor((p: PathSpec, fields: SetAttrFields) => vfs.setattr(p, fields)),
        }
      : {}),
    isMounted: () => vfs.isMounted(),
    local: vfs.local,
    maxGlobMatches: vfs.maxGlobMatches,
    maxDuEntries: vfs.maxDuEntries,
    ...(has('search')
      ? {
          search: {
            search: withoutAccessor((p: PathSpec, q: SearchQuery, index?: IndexCacheStore) =>
              vfs.search(p, q, index),
            ),
            ...(has('searchMany')
              ? {
                  searchMany: withoutAccessor(
                    (ps: PathSpec[], q: SearchQuery, index?: IndexCacheStore) =>
                      vfs.searchMany(ps, q, index),
                  ),
                }
              : {}),
            meta: vfs.searchMeta,
          },
        }
      : {}),
    ...(has('narrowPaths')
      ? {
          contentSearch: {
            narrowPaths: withoutAccessor((q: string, ps: PathSpec[]) => vfs.narrowPaths(q, ps)),
            enabled: () => vfs.contentSearchEnabled(),
          },
        }
      : {}),
  }
}

/** A command's whole or ranged read of the stored bytes, at the door. */
async function doorBytes(
  dispatch: DispatchFn,
  path: PathSpec,
  offset = 0,
  size: number | null = null,
): Promise<Uint8Array> {
  const [data] = await dispatch('read', path, [], { filetype: null, offset, size })
  return materialize(data as ByteSource)
}

/** A command's streamed read of the stored bytes, at the door, opened at
 * the first pull as a backend stream is. */
async function* doorStream(dispatch: DispatchFn, path: PathSpec): AsyncIterable<Uint8Array> {
  const [data] = await dispatch('read', path, [], { stream: true, filetype: null })
  yield* ensureStream(data as ByteSource)
}

/**
 * Return `ops` whose content reads go through the dispatcher.
 *
 * The door checks hides, the command's path rule, the mount's mode and
 * policy, serves a warm copy and fills a cold one, so a command's read
 * answers what the same read through `ws.vfs` or FUSE answers. Mirrors
 * Python's `with_door_reads`.
 */
export function withDoorReads(ops: CommandIO, dispatch: DispatchFn): CommandIO {
  return {
    ...ops,
    readBytes: (_accessor, path) => doorBytes(dispatch, path),
    readStream: (_accessor, path) => doorStream(dispatch, path),
    ...(ops.readRange === undefined
      ? {}
      : {
          readRange: (
            _accessor: Accessor,
            path: PathSpec,
            _index: IndexCacheStore | undefined,
            offset: number,
            size: number | null,
          ) => doorBytes(dispatch, path, offset, size),
        }),
  }
}

export function resolveGlobOf<A extends Accessor = Accessor>(ops: CommandIO<A>): ResolveGlobOp<A> {
  return makeResolveGlob(
    ops.readdir,
    ops.maxGlobMatches,
    ops.globChildren,
    ops.stat,
    ops.globTargetStat,
  )
}

// Whether a path that failed with ENOENT is an implicit directory. Keyed
// backends (RAM/Redis/S3) have no directory entries: stat/read of a prefix
// that only exists through deeper keys raises ENOENT. The operand's own
// readdir cannot serve as the probe: synthetic hierarchies fabricate
// children for any name (postgres answers tables/views for a missing
// schema) and database backends raise driver errors for missing tables.
// The parent listing is authoritative instead: the operand is an implicit
// directory only if its parent's readdir lists it. When the operand is the
// mount root there is no parent to list, so its own readdir decides (root
// listings are real in every backend). Any probe failure is a negative
// probe (the original ENOENT stands), never an error to surface.
async function isImplicitDir<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<boolean> {
  const target = norm(path.virtual)
  const key = stripSlash(path.vfsPath)
  if (!key) {
    try {
      const entries = await ops.readdir(accessor, path, index)
      return entries.length > 0
    } catch {
      return false
    }
  }
  const parentKey = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
  const parentVirtual = parent(target)
  const parentPath = new PathSpec({
    virtual: parentVirtual,
    directory: parentVirtual,
    vfsPath: parentKey,
  })
  try {
    const entries = await ops.readdir(accessor, parentPath, index)
    return entries.some((entry) => norm(entry) === target)
  } catch {
    return false
  }
}

// Whether a path no backend knows is a directory the namespace owns: the
// third way a read operand can be a directory, after the explicit stat row
// and the implicit keyed-backend prefix. A directory that exists only
// because a mount or a link sits under it (`/repos` when `/repos/alpha` is
// mounted) belongs to no backend at all, so the mount this command is bound
// to can neither stat it nor list it, and every read command reported it
// missing while stat, file, ls, du, find and tree all called it a directory.
//
// The names the namespace owes the path, not a dispatched stat. Both answer
// for a mount parent, but a dispatched stat also answers from a backend's own
// listing, and a backend that answers a path it does not hold with entries
// rather than a miss turns every such path into a directory: postgres reads
// any first segment as a schema and lists `tables` and `views` under it, so
// `cat /pg/nope.txt` refused a directory that is not there. The namespace
// cannot over-claim that way, because it derives a segment only from a mount
// prefix or a link path it actually holds, and it is the same authority
// `namespaceListing` gates on, so the listing and this refusal cannot
// disagree. It is hide-filtered for free, which is what keeps the parent of a
// mount the session may not be told about reading as absence.
function isNamespaceDir(opts: CommandOpts, p: PathSpec): boolean {
  const children = opts.ns?.childMounts
  if (children === undefined) return false
  return children(p.virtual).length > 0
}

// The one place the read family decides what a directory is, shared by the
// stat and the stream chokepoints so the two cannot drift.
async function statRefusingDirs<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  opts: CommandOpts,
  p: PathSpec,
): Promise<FileStat> {
  const index = opts.index ?? undefined
  let st: FileStat
  try {
    st = await ops.stat(accessor, p, index)
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT' || isDotWalkError(e)) throw e
    if (await isImplicitDir(ops, accessor, p, index)) throw eisdir(p)
    if (isNamespaceDir(opts, p)) throw eisdir(p)
    throw e
  }
  if (st.type === FileType.DIRECTORY) throw eisdir(p)
  return st
}

// Stat for the read-family chokepoint (`splitReadable`): a directory operand
// fails with EISDIR instead of succeeding (explicit, via the stat type) or
// failing with ENOENT (implicit keyed-backend directory via a readdir probe,
// or a namespace-only mount parent via the name plane), so cat/head/tail
// report GNU's `Is a directory` and keep the remaining operands (#457).
//
// Takes the whole `opts` rather than its index because this is where every
// read command decides what a directory is, and the facts that answer that
// question arrive on the bag: threading them one at a time would mean
// editing every one of the two dozen builders again for the next one.
export function dirAwareStat<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  opts: CommandOpts,
): (p: PathSpec) => Promise<FileStat> {
  return (p) => statRefusingDirs(ops, accessor, opts, p)
}

// Stat through the backend, then merge the namespace attr overlay, so the
// stat-rendering commands (ls -l, stat -c) show the chmod/chown/touch state a
// backend without an attribute slot cannot hold itself. Returns the plain stat
// unchanged when the executor injected no overlay. Mirrors the Python
// `overlaid_stat`; every stat-rendering command binds through here so no
// backend can quietly skip the merge and disagree with `ws.vfs`.
export function overlaidStat(
  stat: (p: PathSpec) => Promise<FileStat>,
  overlay: StatOverlay | undefined,
): (p: PathSpec) => Promise<FileStat> {
  // Guarded itself, as Python's overlaid_stat is: a caller may bind a raw
  // backend stat (the object-store family's core) rather than a slot.
  return async (p) => {
    if (p.walkError !== null) throw walkRefusal(p)
    const row = await stat(p)
    return overlay === undefined ? row : overlay(p.virtual, row)
  }
}

/**
 * Whether a failed or empty read was a read of a directory.
 *
 * Asked after failure or EOF without bytes: some drivers return an empty
 * stream for directories. Nonempty reads need no extra probe. One that knows says so (gdrive, box,
 * dropbox and disk throw EISDIR), a keyed store answers ENOENT because a
 * directory there is a set of keys rather than an object, and sftp
 * answers with an error carrying no errno at all.
 *
 * Four ways the answer can be yes, in probe-cost order. The code itself
 * costs nothing. The stat is one call, and a stat that ANSWERS ends the
 * cascade either way: a file is a file, and the later probes only make
 * sense for a path stat could not see. Reaching past a successful stat
 * read a rule-refused file as a directory, because its parent's listing
 * names it. The parent listing is one call and is the only thing that can
 * tell a missing key from a prefix that exists only through deeper keys.
 * The namespace's child names cost nothing and are the only authority for
 * a directory that exists because a mount or a link sits under it, which
 * no backend can see because those keys live in another VFS.
 *
 * A no leaves the original error untouched, so nothing is swallowed: the
 * caller rethrows what the backend said. Both probes are broad for that
 * same reason, which is the one `isImplicitDir` states for its own
 * catches: a probe that fails is a negative probe, never an error to
 * surface. Surfacing one would replace the read's error with one from a
 * call the user never made, and it is the read that failed.
 */
async function readHitADir<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  err: unknown,
): Promise<boolean> {
  if ((err as { code?: string } | null)?.code === 'EISDIR') return true
  // The path did not resolve at all, which no reading turns into a
  // directory; its parent may well list the name it simplifies to.
  if (isDotWalkError(err)) return false
  let st: FileStat | null = null
  try {
    st = await ops.stat(accessor, path, index)
  } catch {
    st = null
  }
  if (st !== null) return st.type === FileType.DIRECTORY
  try {
    if (await isImplicitDir(ops, accessor, path, index)) return true
  } catch {
    // negative probe, see above
  }
  // The same fact isNamespaceDir reads, reached from the adapter rather
  // than from the bag: this guard wraps a slot and never sees a
  // CommandOpts, and the factory stamps the very callable
  // opts.ns.childMounts would hand over.
  return ops.globChildren !== undefined && ops.globChildren(path.virtual).length > 0
}

async function* drainRefusingDirs<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  let empty = true
  try {
    for await (const chunk of source) {
      empty = empty && chunk.byteLength === 0
      yield chunk
    }
  } catch (err) {
    if (await readHitADir(ops, accessor, path, index, err)) throw eisdir(path)
    throw err
  }
  if (empty && (await readHitADir(ops, accessor, path, index, null))) throw eisdir(path)
}

/**
 * Return `ops` whose reads refuse a directory with GNU's EISDIR.
 *
 * The read family's counterpart of `withCommandGuards` and
 * `withSlashGuard`: reading a directory is never a legitimate call, so
 * the refusal belongs to the slot rather than to each builder's wiring.
 * It used to belong to the wiring, and 23 of the read builders passed the
 * raw `ops.readStream` instead, so a directory on a keyed backend
 * reported ENOENT.
 *
 * Refined after failure or an empty read: some drivers return EOF for
 * directories. Nonempty successful reads need no extra probe. The refusal is built from the operand's own
 * PathSpec, so it carries the virtual path: a raw disk error names the
 * host path, which is the mount's own business and must not reach a
 * user-facing line.
 *
 * Mirrors the Python `with_dir_guard`.
 */
export function withDirGuard<A extends Accessor = Accessor>(ops: CommandIO<A>): CommandIO<A> {
  const guarded: CommandIO<A> = {
    ...ops,
    readBytes: async (accessor, path, index) => {
      try {
        const data = await ops.readBytes(accessor, path, index)
        if (data.byteLength === 0 && (await readHitADir(ops, accessor, path, index, null))) {
          throw eisdir(path)
        }
        return data
      } catch (err) {
        if (await readHitADir(ops, accessor, path, index, err)) throw eisdir(path)
        throw err
      }
    },
    // The wrapped op is called HERE, not inside the generator: the
    // read-through cache reads the active CacheManager when the slot is
    // called, and deferring that to drain time loses the mount's
    // cache-manager scope, so every warm read missed.
    readStream: (accessor, path, index) =>
      drainRefusingDirs(ops, accessor, path, index, ops.readStream(accessor, path, index)),
  }
  const readRange = ops.readRange
  if (readRange !== undefined) {
    guarded.readRange = async (accessor, path, index, offset, size) => {
      try {
        const data = await readRange(accessor, path, index, offset, size)
        if (data.byteLength === 0 && (await readHitADir(ops, accessor, path, index, null))) {
          throw eisdir(path)
        }
        return data
      } catch (err) {
        if (await readHitADir(ops, accessor, path, index, err)) throw eisdir(path)
        throw err
      }
    }
  }
  return guarded
}

async function* streamRefusingDirs<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  opts: CommandOpts,
  p: PathSpec,
): AsyncIterable<Uint8Array> {
  await statRefusingDirs(ops, accessor, opts, p)
  yield* ops.readStream(accessor, p, opts.index ?? undefined)
}

// Read stream for the read-family per-operand chokepoint (`readOperands`):
// the operand is stat'ed first so a directory fails with EISDIR before any
// backend read runs (sftp reads of a directory raise an opaque `Failure`,
// not ENOENT), and an ENOENT for an implicit keyed-backend directory or a
// namespace-only mount parent is refined the same way `dirAwareStat` does,
// before the generic formats the stderr line (#457). Mirrors the Python
// `dir_aware_stream`.
export function dirAwareStream<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  opts: CommandOpts,
): (p: PathSpec) => AsyncIterable<Uint8Array> {
  return (p) => streamRefusingDirs(ops, accessor, opts, p)
}

export type GenericCommandFn<A extends Accessor = Accessor> = (
  ops: CommandIO<A>,
  accessor: A,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
) => Promise<CommandFnResult> | CommandFnResult

export interface GenericCommand<A extends Accessor = Accessor> {
  name: string
  fn: GenericCommandFn<A>
  write?: boolean
  aggregate?: AggregateFn
  read?: boolean
}

/** Refuse a hidden path the way nonexistence would: ENOENT for anything
 * acting on the path; a create answers as `hiddenRefusal` says, EACCES
 * only when the directory it lands in is visible. Raised at the op
 * boundary so each command renders the refusal through its own
 * missing-file wording, indistinguishable from a real miss. */
export function refuseHidden(path: PathSpec, create: boolean): void {
  const vis = sessionVisibility()
  if (pathVisible(vis, path.virtual)) return
  throw hiddenRefusal(vis, path.virtual, create)
}

function visibleChildren(entries: string[], parent: PathSpec): string[] {
  const base = rstripSlash(parent.virtual)
  const vis = sessionVisibility()
  return entries.filter((e) => {
    const trimmed = rstripSlash(e)
    return pathVisible(vis, `${base}/${trimmed.slice(trimmed.lastIndexOf('/') + 1)}`)
  })
}

/** Whether the bound session's hides make this relocation a reveal. */
function moveWouldReveal(src: PathSpec, dst: PathSpec): boolean {
  return moveReveals(sessionVisibility(), src.virtual, dst.virtual)
}

/** Refuse a relocation that would surface a hidden path.
 *
 * A rename or a native directory copy re-anchors everything below its
 * source, and a hide's coverage does not move with the content, so
 * hidden bytes would land at paths the session can see. EACCES on the
 * source, which mv and cp render in GNU's permission-denied voice.
 * Only a directory has anything below it to re-anchor, so callers
 * check this for a source they know is a directory and skip it for a
 * file. */
export function refuseReveal(src: PathSpec, dst: PathSpec): void {
  if (moveWouldReveal(src, dst)) throw eacces(src.virtual)
}

/** Whether a pair op's source stats as a directory, probed only when
 * the reveal check trips: an absent source moves nothing (the op
 * itself reports it), and an unanswerable one fails toward refusal. */
async function pairSrcIsDir<A extends Accessor>(
  stat: StatOp<A>,
  accessor: A,
  src: PathSpec,
): Promise<boolean> {
  let row: FileStat
  try {
    row = await stat(accessor, src, undefined)
  } catch (err) {
    if (isMissError(err)) return false
    return true
  }
  return row.type === FileType.DIRECTORY
}

/**
 * Return `ops` whose slots refuse hidden paths like missing ones.
 *
 * The commands factory hands this copy to every generic command, the
 * same shape as `withReadCache`, so hidden-path enforcement lands once
 * for the whole command tier (resolveGlobOf derives from the wrapped
 * readdir). The backends' own IO constants stay raw: the ops tables
 * built from them serve the dispatcher, which enforces hiding itself
 * at the door. The guards read the current session at call time, so
 * one wrapped copy is shared across sessions.
 */
function namespaceOps<A extends Accessor = Accessor>(ops: CommandIO<A>): CommandIO<A> {
  const guarded: CommandIO<A> = {
    ...ops,
    readdir: async (accessor, path, index) => {
      refuseHidden(path, false)
      return visibleChildren(await ops.readdir(accessor, path, index), path)
    },
  }
  const ex = ops.exists
  if (ex !== undefined) {
    guarded.exists = async (accessor, path) => {
      if (!pathVisible(sessionVisibility(), path.virtual)) return false
      return ex(accessor, path)
    }
  }
  const rd = ops.rmdir
  if (rd !== undefined) {
    // The backend refuses a directory still holding entries, but when
    // every remaining entry is hidden the refusal would leak that
    // something invisible exists, so the remnants go with the
    // directory: a session's mutation may destroy what it cannot see,
    // never learn of it. Any visible child keeps the refusal, and a
    // backend with no unlink keeps it too, having no way to take the
    // remnants. The removal is the shared removeRemnants walk over the
    // sibling slots, which revalidates visibility before every
    // deletion and keeps the mode guard on each one; any cascade
    // failure answers with the backend's original refusal, exactly as
    // the ops plane does.
    const rawReaddir = ops.readdir
    const rawStat = ops.stat
    const rawUnlink = ops.unlink
    // Captured at wrap time, which holds the invocation's fact because
    // the factory applies this guard per invocation, after stamping it.
    const children = ops.globChildren
    guarded.rmdir = async (accessor, path, index) => {
      refuseHidden(path, false)
      try {
        await rd(accessor, path, index)
        return
      } catch (exc) {
        const code = (exc as { code?: string }).code
        const vis = sessionVisibility()
        if (
          rawUnlink === undefined ||
          (code !== 'ENOTEMPTY' && code !== 'EEXIST') ||
          !hiddenUnder(vis, path.virtual)
        ) {
          throw exc
        }
        // The fallback listing folds into the refusal exactly as the
        // cascade below does: a backend that cannot list the remnants
        // keeps the original refusal, whatever error type it failed
        // with, because a raw backend failure here would reveal
        // exactly what the refusal exists to hide.
        let entries: string[]
        try {
          entries = await rawReaddir(accessor, path, index)
        } catch {
          throw exc
        }
        // The namespace children join the emptiness judgment, never
        // the walk: a visible mounted child keeps the refusal exactly
        // as the ops plane's merged listing does, while the cascade
        // itself only ever removes what the backend holds.
        const merged = children === undefined ? entries : [...entries, ...children(path.virtual)]
        const visible = (virtual: string): boolean => pathVisible(vis, virtual)
        if (entries.length === 0 || visibleBelow(path.virtual, merged, visible)) {
          throw exc
        }
        const channel: RemnantChannel = {
          readdir: (at) => rawReaddir(accessor, at, index),
          stat: (at) => rawStat(accessor, at, index),
          unlink: async (at) => {
            checkCommandPaths([at], 'unlink', false)
            await rawUnlink(accessor, at)
          },
          rmdir: async (at) => {
            checkCommandPaths([at], 'rmdir', false)
            await rd(accessor, at, index)
          },
        }
        try {
          await removeRemnants(channel, visible, path)
        } catch {
          throw exc
        }
      }
    }
  }
  const rn = ops.rename
  if (rn !== undefined) {
    // Only a directory source can carry hidden content into view, so a
    // rename whose source stats as a file passes the reveal check.
    guarded.rename = async (accessor, src, dst) => {
      refuseHidden(src, false)
      refuseHidden(dst, true)
      if (moveWouldReveal(src, dst) && (await pairSrcIsDir(ops.stat, accessor, src))) {
        throw eacces(src.virtual)
      }
      return rn(accessor, src, dst)
    }
  }
  const dc = ops.dirCopy
  if (dc !== undefined) {
    guarded.dirCopy = (accessor, src, dst) => {
      refuseHidden(src, false)
      refuseHidden(dst, true)
      refuseReveal(src, dst)
      return dc(accessor, src, dst)
    }
  }
  return guarded
}

interface Mutation {
  create?: boolean
  firstSource?: boolean
  subtree?: boolean
}

const MUTATIONS = {
  write: { create: true },
  mkdir: { create: true },
  append: { create: true },
  pwrite: { create: true },
  create: { create: true },
  truncate: { create: true },
  unlink: {},
  rmdir: {},
  setAttrs: {},
  rmR: { subtree: true },
  rename: { subtree: true },
  copy: { firstSource: true },
  dirCopy: { firstSource: true, subtree: true },
} satisfies Partial<Record<keyof CommandIO, Mutation>>

type MutationSlot = keyof typeof MUTATIONS
const mutationSlots = Object.keys(MUTATIONS) as MutationSlot[]
type GuardedSlot =
  | 'du'
  | 'search'
  | MutationSlot
  | 'readBytes'
  | 'readRange'
  | 'readStream'
  | 'readdir'
  | 'stat'
  | 'exists'
  | 'find'

function mutationOf(slot: string): Mutation | undefined {
  return Object.hasOwn(MUTATIONS, slot) ? MUTATIONS[slot as MutationSlot] : undefined
}

function pathsOf(args: readonly unknown[]): PathSpec[] {
  return args
    .flatMap<unknown>((arg): readonly unknown[] => (Array.isArray(arg) ? arg : [arg]))
    .filter((arg): arg is PathSpec => arg instanceof PathSpec)
}

/**
 * Answer a mkdir on a read-only region the way the filesystem would. A
 * read-only filesystem refuses only a create it would really make, so the
 * answer is whatever the create runs into first, walking the components from
 * the mount root: a missing one is refused with EROFS, a file in the chain is
 * ENOTDIR, an existing leaf is EEXIST, and `mkdir -p` of a directory that is
 * already there succeeds. The blamed path is the first component that would
 * have been made, as GNU's `mkdir -p` names it (`'/ro/n'` for `/ro/n/m`).
 * Pinned against GNU coreutils 9.7 on a read-only tmpfs. Mirrors Python's
 * `_mkdir_on_read_only`.
 */
async function mkdirOnReadOnly<A extends Accessor>(
  stat: StatOp<A>,
  gate: readonly [string, MountMode],
  accessor: A,
  path: PathSpec,
  parents: boolean,
): Promise<void> {
  const [prefix, mode] = gate
  const base = rstripSlash(prefix)
  const leaf = rstripSlash(path.virtual) || '/'
  if (leaf !== base && !leaf.startsWith(base + '/')) {
    throw erofs(path.virtual, `mount ${prefix} is read-only`)
  }
  // Each component's backend key keeps the leaf's own key prefix, recovered
  // from its (virtual, vfsPath) pair as PathSpec.dir does.
  const cut = leaf.length - stripSlash(path.vfsPath).length
  const parts = leaf
    .slice(base.length)
    .split('/')
    .filter((part) => part !== '')
  const chain = parts.map((_, index) => {
    const virtual = `${base}/${parts.slice(0, index + 1).join('/')}`
    return PathSpec.fromStrPath(virtual, stripSlash(virtual.slice(cut)))
  })
  for (const [index, component] of chain.entries()) {
    let row: FileStat
    try {
      row = await stat(accessor, component)
    } catch (err) {
      if (!isEnoent(err)) throw err
      if (!parents && index < chain.length - 1) throw enoent(path.virtual)
      const blame =
        chain
          .slice(index)
          .find((spec) => effectivePathMode(spec.virtual, prefix, mode) === MountMode.READ) ?? path
      throw erofs(blame.virtual, `mount ${prefix} is read-only`)
    }
    if (row.type !== FileType.DIRECTORY) {
      if (index === chain.length - 1) throw eexist(path.virtual)
      throw enotdir(parents ? component.virtual : path.virtual)
    }
  }
  if (!parents) throw eexist(path.virtual)
}

/**
 * mkdir on a writable region: a taken name is refused before the create, as
 * mkdir(2) does (`refuseTaken`). Mirrors Python's `_mkdir_on_writable`.
 */
async function mkdirOnWritable<A extends Accessor>(
  mkdir: MkdirOp<A>,
  stat: StatOp<A>,
  accessor: A,
  path: PathSpec,
  parents: boolean,
): Promise<void> {
  await refuseTaken((p) => stat(accessor, p), path, parents)
  await mkdir(accessor, path, parents)
}

/** Raise what the first unwalkable operand's dots answer; `creates` when
 * the op creates the name it is handed (mkdir). Mirrors Python's
 * _walk_admit. */
async function walkAdmit(
  probe: WalkProbe,
  specs: readonly PathSpec[],
  creates = false,
): Promise<void> {
  for (const spec of specs) {
    const refusal = await dotRefusal(probe.stat, spec, probe.follow, creates)
    if (refusal !== null) throw refusal
  }
}

/** The probe a slot call's dotted operands walk with, null when none is
 * dotted or no command bound one. */
function walkProbeOf(
  bound: WalkProbe | null,
  args: readonly unknown[],
): [WalkProbe, PathSpec[]] | null {
  const specs = args.filter((a): a is PathSpec => a instanceof PathSpec && a.dotted !== null)
  const first = specs[0]
  if (first === undefined) return null
  const probe = bound ?? walkProbeFor(first.virtual)
  return probe === null ? null : [probe, specs]
}

/** Throw the walk's verdict on the first PathSpec positional it refused
 * before the command ran (the empty name, a link loop), before anything
 * else reads it. Mirrors the walk_error arm of Python's _walked_call. */
function refuseUnwalked(args: readonly unknown[]): void {
  for (const arg of args) {
    if (arg instanceof PathSpec && arg.walkError !== null) throw walkRefusal(arg)
  }
}

/** Call one slot once the dots of its PathSpec positionals walk. */
function walkedCall<Args extends unknown[], R>(
  bound: WalkProbe | null,
  fn: (...args: Args) => Promise<R>,
  creates = false,
): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    refuseUnwalked(args)
    const walk = walkProbeOf(bound, args)
    if (walk !== null) await walkAdmit(walk[0], walk[1], creates)
    return fn(...args)
  }
}

/** Drain a read stream once its operand walks, before any byte is pulled. */
async function* walkedStream(
  probe: WalkProbe | null,
  specs: readonly PathSpec[],
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  refuseUnwalked(specs)
  if (probe !== null) await walkAdmit(probe, specs)
  yield* source
}

/** `fn`, refused with the line's abort instead of started once `signal` has fired. */
function refusedAfterAbort<T extends unknown[], R>(
  signal: AbortSignal,
  fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  return (...args) => (hasAborted(signal) ? Promise.reject(makeAbortError(signal)) : fn(...args))
}

/**
 * Return `ops` whose backend slots refuse to start once the invocation's
 * signal has fired.
 *
 * The twin of the dispatch door's guard for mount commands: a handler
 * that loops over operands (`rm a b`, `cp -r`, `mkdir -p`) awaits a slot
 * once per operand, and a JS promise cannot be cancelled, so after the
 * caller was released the handler resumes on the await that was in
 * flight and would begin the next read or write. Refusing at the slot,
 * the one seam every generic-bound handler's I/O goes through, stops it
 * there without each handler reading the signal. A slot already in
 * flight settles on its own, and `readStream` is left alone because the
 * reader it returns is guarded as it is drained (`guardInput`). The
 * presence facts (stat, exists, find, du) are refused too. They cost no
 * write, which is why the policy guard leaves them, but each one is a
 * request on an API-backed mount: `stat a b` whose first call outlives
 * the grace would start the second after the caller was released. The
 * promise is no further read *or* write between operands, so a read
 * that happens to answer a question rather than return bytes is still
 * a read. Python needs nothing here: its cancelled task never reaches
 * the next operand.
 */
export function withAbortGuard<A extends Accessor = Accessor>(
  ops: CommandIO<A>,
  signal: AbortSignal | undefined,
): CommandIO<A> {
  if (signal === undefined) return ops
  const guarded: CommandIO<A> = {
    ...ops,
    readdir: refusedAfterAbort(signal, ops.readdir),
    readBytes: refusedAfterAbort(signal, ops.readBytes),
    stat: refusedAfterAbort(signal, ops.stat),
  }
  if (ops.readRange !== undefined) guarded.readRange = refusedAfterAbort(signal, ops.readRange)
  if (ops.exists !== undefined) guarded.exists = refusedAfterAbort(signal, ops.exists)
  if (ops.find !== undefined) guarded.find = refusedAfterAbort(signal, ops.find)
  if (ops.du !== undefined) {
    guarded.du = {
      size: refusedAfterAbort(signal, ops.du.size),
      entries: refusedAfterAbort(signal, ops.du.entries),
    }
  }
  if (ops.write !== undefined) guarded.write = refusedAfterAbort(signal, ops.write)
  if (ops.mkdir !== undefined) guarded.mkdir = refusedAfterAbort(signal, ops.mkdir)
  if (ops.append !== undefined) guarded.append = refusedAfterAbort(signal, ops.append)
  if (ops.pwrite !== undefined) guarded.pwrite = refusedAfterAbort(signal, ops.pwrite)
  if (ops.create !== undefined) guarded.create = refusedAfterAbort(signal, ops.create)
  if (ops.unlink !== undefined) guarded.unlink = refusedAfterAbort(signal, ops.unlink)
  if (ops.rmdir !== undefined) guarded.rmdir = refusedAfterAbort(signal, ops.rmdir)
  if (ops.rmR !== undefined) guarded.rmR = refusedAfterAbort(signal, ops.rmR)
  if (ops.truncate !== undefined) guarded.truncate = refusedAfterAbort(signal, ops.truncate)
  if (ops.rename !== undefined) guarded.rename = refusedAfterAbort(signal, ops.rename)
  if (ops.copy !== undefined) guarded.copy = refusedAfterAbort(signal, ops.copy)
  if (ops.dirCopy !== undefined) guarded.dirCopy = refusedAfterAbort(signal, ops.dirCopy)
  const sa = ops.setAttrs
  if (sa !== undefined) {
    guarded.setAttrs = (accessor: A, path: PathSpec, ...rest: unknown[]) => {
      if (hasAborted(signal)) throw makeAbortError(signal)
      return sa(accessor, path, ...rest)
    }
  }
  return guarded
}

/**
 * Guard one bare backend write the way the adapter guards a slot.
 *
 * For a bespoke command wired from loose functions rather than a
 * `CommandIO` (the google `rm` family binds an index-threaded unlink):
 * the same chain in the same order, judging the written path. A hidden
 * path answers ENOENT, the flavor of the flat mutation slots. The
 * command path guard applies without firing POSIX policy hooks.
 */
export function withWriteGuards<A extends Accessor, R>(
  fn: (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<R> | R,
): (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<R> {
  return guardOperation(fn, 'unlink')
}

/** Require a capability at call time, after the same guards as an available op. */
export function requireOp<T extends (...args: never[]) => Promise<unknown>>(
  op: T | undefined,
  name: MutationSlot | 'exists',
): T {
  if (op !== undefined) return op
  const refuse = (...args: never[]): Promise<never> => {
    const specs = pathsOf(args)
    const named = mutationOf(name)?.firstSource ? specs[1] : specs[0]
    return Promise.reject(
      enotsup(
        'backend',
        name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        named ?? '',
      ),
    )
  }
  return guardOperation(refuse, name) as unknown as T
}

function checkCommandPaths(
  paths: readonly PathSpec[],
  slot: GuardedSlot,
  checkHidden = true,
  checkMode = true,
): void {
  const access = mutationOf(slot)
  const admission = getAdmission()
  for (const [position, path] of paths.entries()) {
    if (checkHidden) refuseHidden(path, position > 0 || access?.create === true)
    if (slot !== 'stat' && slot !== 'exists') admission?.check(path.virtual)
  }
  if (access !== undefined && checkMode) {
    for (const path of access.firstSource ? paths.slice(1) : paths) {
      const gate = mountGateFor(path.virtual)
      if (gate !== null) requirePathsWritable([path], ...gate, access.subtree)
    }
  }
}

function commandCall<T extends (...args: never[]) => unknown>(
  fn: T,
  slot: GuardedSlot,
  checkMode = true,
): T {
  return ((...args: never[]) => {
    checkCommandPaths(pathsOf(args), slot, true, checkMode)
    return fn(...args)
  }) as T
}

export function withCommandGuards<A extends Accessor>(
  ops: CommandIO<A>,
  prefix?: string,
): CommandIO<A> {
  const probe = prefix === undefined ? null : walkProbeFor(prefix)
  const prepared = namespaceOps(ops)
  const mk = ops.mkdir
  if (mk !== undefined) {
    prepared.mkdir = (accessor, path, parents) => {
      const gate = mountGateFor(path.virtual)
      if (gate !== null && effectivePathMode(path.virtual, gate[0], gate[1]) === MountMode.READ) {
        return mkdirOnReadOnly(ops.stat, gate, accessor, path, parents ?? false)
      }
      return mkdirOnWritable(mk, ops.stat, accessor, path, parents ?? false)
    }
  }
  const guarded = { ...prepared }
  for (const slot of [
    'readBytes',
    'readRange',
    'stat',
    'exists',
    'readdir',
    'find',
    ...mutationSlots,
  ] as const) {
    const fn = prepared[slot]
    if (fn === undefined) continue
    // Hides and the path rule on a content read are the door's.
    const call =
      slot === 'readBytes' || slot === 'readRange' ? fn : commandCall(fn, slot, slot !== 'mkdir')
    Object.assign(guarded, {
      [slot]: walkedCall(probe, call as (...args: unknown[]) => Promise<unknown>, slot === 'mkdir'),
    })
  }
  guarded.readStream = (accessor, path, index) => {
    const source = prepared.readStream(accessor, path, index)
    const walk = walkProbeOf(probe, [path])
    return walkedStream(walk?.[0] ?? null, [path], source)
  }
  if (guarded.exists !== undefined) {
    const exists = guarded.exists
    guarded.exists = (accessor, path) =>
      pathVisible(sessionVisibility(), path.virtual)
        ? exists(accessor, path)
        : Promise.resolve(false)
  }
  if (ops.du !== undefined) {
    guarded.du = {
      size: commandCall(ops.du.size, 'du'),
      entries: commandCall(ops.du.entries, 'du'),
    }
  }
  if (ops.search !== undefined)
    guarded.search = { ...ops.search, search: commandCall(ops.search.search, 'search') }
  return guarded
}

/**
 * Return `dispatch` marking each op with the admitted command's gate as
 * `ruleGate`, which the door judges on the paths the op reaches: the
 * command's dispatcher skips its guarded slots, and the door cannot tell
 * which command issued an op. A metadata op passes unmarked, as
 * `withCommandGuards` lets `stat` pass.
 */
export function withDispatchRuleGuard(dispatch: DispatchFn): DispatchFn {
  return async (op, path, args, options, report) => {
    const gate = getAdmission()
    if (gate === null || METADATA_OPS.has(op)) return dispatch(op, path, args, options, report)
    return dispatch(op, path, args, { ...options, ruleGate: gate }, report)
  }
}

/** The policies to consult for one slot call, with the mount prefix
 * and session identity the call belongs to. */
interface OpPolicyScope {
  policies: Policies
  /** The wrap site's mount prefix; null resolves per path at admit
   * time (a registration-time wrap has no one mount). */
  prefix: string | null
  sessionId: string
}

/**
 * The scope to consult for this op call: null is the fast path (no
 * dispatched command bound policies, or none of them override preVfs).
 */
function opPolicyScope(prefix: string | null): OpPolicyScope | null {
  const policies = getOpPolicies()
  if (!policies?.wants('preVfs')) return null
  return { policies, prefix, sessionId: getCurrentSession()?.sessionId ?? '' }
}

/**
 * The wrap-time scope when it caught a bound command, else the
 * call-time context.
 *
 * The factory applies the guard inside the command's window, so its
 * wrap-time capture also covers a slot called after dispatch has reset
 * the context, with the prefix and session identity the op belongs to;
 * a registration-time wrap (the object-store overrides,
 * the loose-write chain) has no window when applied and reads the
 * live context instead, which its eager handlers are inside.
 */
function livePolicyScope(scope: OpPolicyScope | null): OpPolicyScope | null {
  return scope ?? opPolicyScope(null)
}

/** Fire preVfs for one PathSpec of one slot call; the op is the slot
 * name in its shared snake spelling, so a policy portable across the
 * languages and tiers sees one vocabulary. The hides are not judged
 * here: the command guards wrapped around this one answer them first,
 * and the remnant cascade reaches below them on purpose to remove what
 * the session cannot see. */
async function policyAdmit(
  scope: OpPolicyScope,
  op: string,
  path: PathSpec,
  write: boolean,
): Promise<void> {
  const owner = scope.prefix ?? mountGateFor(path.virtual)?.[0] ?? null
  // The mount prefix as the op door reports it, with its slash.
  const prefix = owner === null ? '' : `${rstripSlash(owner)}/`
  await preVfsGate(scope.policies, op, path, write, prefix, scope.sessionId, undefined, {
    checkHidden: false,
  })
}

/**
 * Return `ops` whose mutation slots and readdir admit each PathSpec
 * through the workspace's coded preVfs hooks.
 *
 * The coded-policy arm of the guard chain. The surface is every mutation
 * slot and the directory a readdir lists; content reads go through the
 * dispatcher, which admits them itself (`withDoorReads`). stat/exists
 * stay unguarded as presence
 * facts, the mode-000 shape the path rules already take, so a denied
 * entry still lists and stats while the read of it is what fails;
 * `scopedIo` drops the native find/du slots, so the walk meets the
 * guarded readdir. Inert unless a dispatched command bound
 * policies overriding preVfs (`opPolicyScope`, with the mount prefix
 * and session identity captured at wrap time so a lazily drained
 * reader still answers as the command that bound it, see
 * `livePolicyScope`; `prefix` arrives from the wrap site because the
 * fallback mount-gate storage resolves by path, which a drained
 * reader no longer has a live gate for).
 */
export function withPolicyGuard<A extends Accessor = Accessor>(
  ops: CommandIO<A>,
  prefix?: string,
): CommandIO<A> {
  const scope = opPolicyScope(prefix ?? null)
  const guarded: CommandIO<A> = { ...ops }
  for (const slot of ['readdir', ...mutationSlots] as const) {
    const fn = ops[slot]
    if (fn !== undefined) {
      // All slots in this set return promises.
      Object.assign(guarded, { [slot]: policyCall(scope, fn, slot) })
    }
  }
  return guarded
}

function policyCall<T extends (...args: never[]) => unknown>(
  scope: OpPolicyScope | null,
  fn: T,
  slot: GuardedSlot,
): T {
  return (async (...args: never[]) => {
    const p = livePolicyScope(scope)
    if (p !== null) {
      const access = mutationOf(slot)
      const paths = pathsOf(args)
      const name = slot.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
      for (const [i, path] of paths.entries()) {
        await policyAdmit(p, name, path, access !== undefined && !(i === 0 && access.firstSource))
      }
    }
    return fn(...args)
  }) as T
}

function guardOperation<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R> | R,
  name: MutationSlot | 'exists',
): (...args: Args) => Promise<R> {
  return walkedCall(null, commandCall(fn, name) as (...args: Args) => Promise<R>)
}

/**
 * Drop the native walks when a hide, a path rule or a coded preVfs
 * policy judges the command's paths, as the command's namespace view
 * (`ns`) answers.
 */
export function scopedIo<A extends Accessor>(
  ops: CommandIO<A>,
  ns: NamespaceView | undefined,
  paths: readonly PathSpec[],
  prefix: string,
): CommandIO<A> {
  if (!pathsScoped(ns, paths, prefix)) return ops
  const result = { ...ops }
  delete result.find
  delete result.du
  delete result.search
  delete result.contentSearch
  delete result.copy
  delete result.dirCopy
  return result
}
