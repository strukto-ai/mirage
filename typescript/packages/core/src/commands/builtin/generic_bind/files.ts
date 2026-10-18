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

import { activeCacheManager } from '../../../cache/context.ts'
import { currentCaller, sessionVisibility } from '../../../context/session_context.ts'
import {
  eacces,
  eisdir,
  enoent,
  isDotWalkError,
  isEnoent,
  isMissError,
  isMissingPath,
} from '../../../errors/fs.ts'
import { ensureStream } from '../../../io/stream.ts'
import { materialize, type ByteSource } from '../../../io/types.ts'
import { revisionFor } from '../../../observe/context.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { FileStat, FileType, PathSpec, type SetAttrFields } from '../../../types.ts'
import { hasAborted, makeAbortError } from '../../../utils/abort.ts'
import {
  DEFAULT_MAX_GLOB_MATCHES,
  makeResolveGlob,
  type ResolveGlobFn,
} from '../../../utils/glob_walk.ts'
import { moveReveals } from '../../../utils/hidden.ts'
import { norm, parent } from '../../../utils/path.ts'
import { stripSlash } from '../../../utils/slash.ts'
import type { SessionAccess } from '../../../view/types.ts'
import type { Context } from '../../config.ts'
import { guardInput } from '../utils/limit.ts'
import { crossesMounts, followOf, linksOf, mountRoot, mountsOf, owedNames } from '../utils/links.ts'
import { callerStream } from './dispatch.ts'

/**
 * A command's files, path-first, every call sent to the dispatcher through
 * the session's files (`ctx.vfs`).
 *
 * The dispatcher checks hides, the command's path rule, the mount's mode and
 * policy, serves a warm copy and fills a cold one, settles a write's caches
 * and receipt under its name's hold, and declines a one-call walk (a subtree
 * read, search, a tree copy or removal) whose subtree the caller's view
 * restricts, so a command's call answers what the same call through `ws.vfs`
 * or FUSE answers. A function the mount's VFS does not answer is the
 * dispatcher's ENOTSUP; a command asks `answers` before it takes a shortcut.
 * Mirrors Python's `CommandFiles`.
 */
export interface CommandFiles {
  /** The entry at `path` itself, as lstat answers. */
  readonly stat: (path: PathSpec) => Promise<FileStat>
  readonly exists: (path: PathSpec) => Promise<boolean>
  readonly readdir: (path: PathSpec, nofollow?: boolean) => Promise<string[]>
  /** The stored bytes, whole. */
  readonly readBytes: (path: PathSpec) => Promise<Uint8Array>
  readonly readRange: (path: PathSpec, offset: number, size: number | null) => Promise<Uint8Array>
  /** The stored bytes, opened at the first pull. */
  readonly readStream: (path: PathSpec) => AsyncIterable<Uint8Array>
  readonly write: (path: PathSpec, data: ByteSource) => Promise<void>
  readonly append: (path: PathSpec, data: ByteSource) => Promise<void>
  readonly pwrite: (path: PathSpec, data: Uint8Array, offset: number) => Promise<void>
  readonly create: (path: PathSpec) => Promise<void>
  readonly mkdir: (path: PathSpec, parents?: boolean) => Promise<void>
  readonly unlink: (path: PathSpec) => Promise<void>
  readonly rmdir: (path: PathSpec) => Promise<void>
  readonly rmR: (path: PathSpec) => Promise<void>
  readonly rename: (src: PathSpec, dst: PathSpec) => Promise<void>
  readonly copy: (src: PathSpec, dst: PathSpec) => Promise<void>
  readonly dirCopy: (src: PathSpec, dst: PathSpec) => Promise<void>
  /** noCreate requires an atomic existence precondition, or ENOTSUP before writing. */
  readonly truncate: (path: PathSpec, length: number, noCreate?: boolean) => Promise<void>
  readonly setAttrs: (
    path: PathSpec,
    fields: SetAttrFields,
  ) => Promise<Record<string, number | string>>
  /** The first `n` lines; null when the file is to be read, as it is when the read cache holds it. */
  readonly firstLines: (path: PathSpec, n: number) => Promise<Uint8Array | null>
  /** The last `n` lines; null when the file is to be read. */
  readonly lastLines: (path: PathSpec, n: number) => Promise<Uint8Array | null>
  /** How many lines the file holds; null when it is to be read. */
  readonly lineCount: (path: PathSpec) => Promise<number | null>
  /** The digest the backend keeps; null when the file is to be read and hashed. */
  readonly checksum: (path: PathSpec, algorithm: string) => Promise<string | null>
  /** The last `n` lines, then the lines added; null when the file is to be polled. */
  readonly follow: (
    path: PathSpec,
    n: number,
    interval: number,
  ) => Promise<AsyncIterable<Uint8Array> | null>
  /** Every entry under `path`, keyed below it; null when the directory is to be walked. */
  readonly readTree: (path: PathSpec) => Promise<Map<string, FileStat> | null>
  /** The files under `path` that may contain `text`; null when the search cannot answer for every file. */
  readonly filesContaining: (
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ) => Promise<PathSpec[] | null>
  /** The lines of `path` that may contain `text`; null when the search cannot answer for this file. */
  readonly linesContaining: (
    path: PathSpec,
    text: string,
    opts: { ignoreCase: boolean },
  ) => Promise<ByteSource | null>
  /** Expand glob operands, a typed word as bash would. */
  readonly resolveGlob: ResolveGlobFn
  /**
   * Whether the mount the command runs on, whatever routed it there (an
   * operand, an option, the working directory), answers `name` itself, as
   * the mount view says: where it does not, a shortcut is not taken.
   */
  readonly answers: (name: string) => boolean
}

/**
 * What the factory says of one invocation of a generic builder: whether an
 * operand's read is cut into pieces (a pass-through builder keeps the
 * producer's chunks), whether a stat's unknown size is filled from the read
 * cache (a builder that only writes takes the backend's), and what streams an
 * operand in place of the dispatched read (null keeps it).
 */
export interface Reading {
  readonly split: boolean
  readonly cachedSizes: boolean
  readonly stream: ((ctx: Context, path: PathSpec) => AsyncIterable<Uint8Array> | null) | null
}

const READINGS = new WeakMap<Context, Reading>()

/**
 * `ctx` as the factory hands it to a builder, its files read as `reading`
 * says and under the command tier's guards. Mirrors Python's `with_reading`.
 */
export function withReading(ctx: Context, reading: Reading): Context {
  const bound = { ...ctx }
  READINGS.set(bound, reading)
  return bound
}

// The writes a run across mounts makes at the dispatcher, whichever mount
// serves the path; it takes no other function's shortcut.
const CROSSING_CALLS: ReadonlySet<string> = new Set([
  'write',
  'pwrite',
  'unlink',
  'mkdir',
  'truncate',
])

// How many operands a whole read warms ahead of itself (`readAhead`).
const READ_AHEAD = 8

/**
 * What a command's whole read of an operand awaits first, and what learns the
 * operands its globs resolve to.
 *
 * A command reads its operands in turn, each whole once the one before is
 * done. On a whole read of one, the next READ_AHEAD go to the dispatcher as
 * one `read_many`, which keeps the small files among them in the read cache
 * (one request where the store reads a batch), and the batch after goes once
 * half of that one is read. A read whose file is still being warmed waits for
 * it, so it is served warm instead of fetching the file again. No bytes are
 * held here: a write in between drops the cached copy as it drops any. A
 * path that is not an operand warms nothing. Mirrors Python's `read_ahead`.
 */
export function readAhead(
  dispatch: DispatchFn,
  paths: readonly PathSpec[],
): [(path: PathSpec) => Promise<void>, (found: PathSpec[]) => void] {
  const operands: PathSpec[] = []
  const order = new Map<string, number>()
  const warming = new Map<string, Promise<void>>()
  let sent = 1
  const noted = (found: readonly PathSpec[]): void => {
    for (const path of found) {
      if (path.pattern === null && !order.has(path.virtual)) {
        order.set(path.virtual, operands.length)
        operands.push(path)
      }
    }
  }
  const warmed = async (path: PathSpec): Promise<void> => {
    const at = order.get(path.virtual)
    if (at === undefined) return
    const start = Math.max(sent, at + 1)
    if (start < operands.length && start <= at + READ_AHEAD / 2) {
      const batch = operands.slice(start, start + READ_AHEAD)
      sent = start + batch.length
      const task = warm(dispatch, batch)
      for (const p of batch) warming.set(p.virtual, task)
    }
    await warming.get(path.virtual)
  }
  noted(paths)
  return [warmed, noted]
}

/**
 * Ask the dispatcher to keep `paths` in the read cache. A failure is logged
 * and dropped: each read that follows meets it. Mirrors Python's `_warm`.
 */
async function warm(dispatch: DispatchFn, paths: readonly PathSpec[]): Promise<void> {
  const [first, ...rest] = paths
  if (first === undefined) return
  try {
    await dispatch('read_many', first, [], { paths: rest })
  } catch (err) {
    console.debug(`read-ahead from ${first.virtual} failed: ${String(err)}`)
  }
}

/**
 * Send one call to the dispatcher and hand back its answer: the one way a
 * command's file call, a cross-mount run and a relayed command reach a mount.
 * Mirrors Python's `dispatched_call`.
 */
export async function dispatchedCall(
  dispatch: DispatchFn,
  name: string,
  path: PathSpec,
  args: readonly unknown[] = [],
  kwargs: Record<string, unknown> = {},
): Promise<unknown> {
  const [result] = await dispatch(name, path, args, kwargs)
  return result
}

/** A command's whole or ranged read of the stored bytes, at the dispatcher. */
async function dispatchedBytes(
  dispatch: DispatchFn,
  path: PathSpec,
  offset = 0,
  size: number | null = null,
  ahead?: (path: PathSpec) => Promise<void>,
): Promise<Uint8Array> {
  if (ahead !== undefined && offset === 0 && size === null) await ahead(path)
  const [data] = await dispatch('read', path, [], { filetype: null, offset, size })
  return materialize(data as ByteSource)
}

/** A command's streamed read of the stored bytes, at the dispatcher, opened at
 * the first pull as a backend stream is. */
async function* dispatchedStream(
  dispatch: DispatchFn,
  path: PathSpec,
  ahead?: (path: PathSpec) => Promise<void>,
): AsyncIterable<Uint8Array> {
  if (ahead !== undefined) await ahead(path)
  const [data] = await dispatch('read', path, [], { stream: true, filetype: null })
  yield* ensureStream(data as ByteSource)
}

/**
 * A command's stat of the entry at `path`, at the dispatcher: the entry
 * itself, as lstat answers, so a link at the final name is the link and a
 * trailing slash reaches what it names. The dispatcher merges the
 * namespace's overlay into the row. Mirrors Python's `_dispatched_stat`.
 */
async function dispatchedStat(dispatch: DispatchFn, path: PathSpec): Promise<FileStat> {
  const [found] = await dispatch('stat', path, [], { nofollow: true })
  if (!(found instanceof FileStat)) throw enoent(path)
  return found
}

/**
 * Whether an entry is at `path`, as `dispatchedStat` answers. Mirrors
 * Python's `_dispatched_exists`.
 */
async function dispatchedExists(dispatch: DispatchFn, path: PathSpec): Promise<boolean> {
  try {
    await dispatchedStat(dispatch, path)
  } catch (err) {
    if (!isEnoent(err)) throw err
    console.debug(`nothing at ${path.virtual}: ${String(err)}`)
    return false
  }
  return true
}

/**
 * The stat a command lists by, with the size the backend does not know read
 * out of the read cache where it holds the file: metadata commands (ls,
 * stat, du) read no content, and for a render-dependent backend the cached
 * rendering is the only place that size exists. The length alone, ungated:
 * this runs only where the backend named no size, the API mounts, so
 * revalidating here would turn a stat into a backend stat. Mirrors Python's
 * `_cached_stat`.
 */
function cachedStat(
  stat: (path: PathSpec) => Promise<FileStat>,
): (path: PathSpec) => Promise<FileStat> {
  return async (path) => {
    const result = await stat(path)
    if (result.type !== FileType.FILE || result.size !== null) return result
    const manager = activeCacheManager()
    if (manager === null) return result
    const size = await manager.cachedSize(path)
    if (size === null) return result
    return result.with({ size })
  }
}

// open(2) with O_CREAT refuses a slash-terminated name outright, before
// looking anything up: `x/` can only ever be a directory, so there is
// nothing to create and nothing to truncate. GNU tee and truncate both
// answer `missing/` with "Is a directory" and touch nothing, and a plain
// file behind the slash gets the same answer. Deliberate divergence: under
// a parent that is itself absent GNU reports the parent first (ENOENT); the
// spelling is refused here without a round trip, so that corner reads
// EISDIR too. The read side is the walk guard's: a slashed operand carries a
// `dotted` spelling, so dotRefusal proves the name a directory there.
function slashChecked<T extends unknown[]>(
  write: (path: PathSpec, ...args: T) => Promise<void>,
): (path: PathSpec, ...args: T) => Promise<void> {
  return async (path, ...args) => {
    if (path.rawPath.endsWith('/')) throw eisdir(path)
    return write(path, ...args)
  }
}

/**
 * `fn`, answering null for a file the read cache holds: a call that stands
 * in for a read (`firstLines`, `lastLines`, `lineCount`, `checksum`) leaves
 * a cached file to be read from there, so a warm run sends nothing and
 * prints what the cached copy holds, as the read it replaces would.
 */
function uncached<T extends unknown[], R>(
  fn: (path: PathSpec, ...args: T) => Promise<R | null>,
): (path: PathSpec, ...args: T) => Promise<R | null> {
  return async (path, ...args) => {
    const manager = activeCacheManager()
    if (manager !== null && (await manager.isCached(path))) return null
    return fn(path, ...args)
  }
}

/** `fn`, refused with the line's abort instead of started once `signal` has fired. */
function refusedAfterAbort<T extends unknown[], R>(
  signal: AbortSignal | undefined,
  fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  if (signal === undefined) return fn
  return (...args) => (hasAborted(signal) ? Promise.reject(makeAbortError(signal)) : fn(...args))
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
// listings are real in every backend). A listing that misses is a negative
// probe (the original ENOENT stands); any other failure propagates, as
// Python's MISS_ERRORS catch lets it.
async function isImplicitDir(
  readdir: (path: PathSpec) => Promise<string[]>,
  path: PathSpec,
): Promise<boolean> {
  const target = norm(path.virtual)
  const key = stripSlash(path.vfsPath)
  if (!key) {
    try {
      const entries = await readdir(path)
      return entries.length > 0
    } catch (err) {
      if (!isMissError(err) && !isMissingPath(err)) throw err
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
    const entries = await readdir(parentPath)
    return entries.some((entry) => norm(entry) === target)
  } catch (err) {
    if (!isMissError(err) && !isMissingPath(err)) throw err
    return false
  }
}

// Whether a path no backend knows is a directory the namespace owns: the
// third way a read operand can be a directory, after the explicit stat row
// and the implicit keyed-backend prefix. A directory that exists only
// because a mount or a link sits under it (`/repos` when `/repos/alpha` is
// mounted) belongs to no backend at all, so the mount this command runs on
// can neither stat it nor list it, and every read command reported it
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
function isNamespaceDir(ctx: Context, p: PathSpec): boolean {
  return owedNames(ctx.vfs, p.virtual).length > 0
}

// The one place the read family decides what a directory is, shared by the
// stat and the stream chokepoints so the two cannot drift.
async function statRefusingDirs(files: CommandFiles, ctx: Context, p: PathSpec): Promise<FileStat> {
  let st: FileStat
  try {
    st = await files.stat(p)
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT' || isDotWalkError(e)) throw e
    if (await isImplicitDir(files.readdir, p)) throw eisdir(p)
    if (isNamespaceDir(ctx, p)) throw eisdir(p)
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
// Mirrors Python's `dir_aware_stat`.
export function dirAwareStat(
  files: CommandFiles,
  ctx: Context,
): (p: PathSpec) => Promise<FileStat> {
  return (p) => statRefusingDirs(files, ctx, p)
}

/**
 * A regular file's size from its stat, for a command whose answer is the size
 * alone (`wc -c`), as GNU takes it from `st_size`. Null reads the file
 * instead: for a file the read cache holds, which is read from there as the
 * read it replaces would be; for anything but a regular file (a device or a
 * pipe has no size to trust); for a size the stat does not know; for a path
 * pinned to an older revision, whose size the stat does not give; and for a
 * store that keeps permission bits (a disk, SFTP), where a file the stat sees
 * may still refuse its read, and a disk's named pipe stats as a file. A store
 * without them grants the read with the stat. A directory fails with EISDIR
 * as `dirAwareStat` has it. A listing the index holds can be up to its TTL
 * old, so the size is checked against a stat that asks the backend now
 * (`fresh`), and a file whose size moved since the listing is read: whether
 * that read serves the listed version (a GitHub blob the listing named) or the
 * current one, it is what the command counts. Mirrors Python's `file_size`.
 */
export function fileSize(
  files: CommandFiles,
  ctx: Context,
): (p: PathSpec) => Promise<number | null> {
  return async (p) => {
    const manager = activeCacheManager()
    if (manager !== null && (await manager.isCached(p))) return null
    if (revisionFor(p.virtual) !== null) return null
    const st = await statRefusingDirs(files, ctx, p)
    if (st.type !== FileType.FILE || st.mode !== null) return null
    if (ctx.vfs === undefined) return st.size
    const [now] = await ctx.vfs.dispatch('stat', p, [], { fresh: true })
    return now instanceof FileStat && now.size === st.size ? st.size : null
  }
}

/**
 * Whether a failed or empty read was a read of a directory.
 *
 * Asked after failure or EOF without bytes: some drivers return an empty
 * stream for directories. Nonempty reads need no extra probe. One that knows
 * says so (gdrive, box, dropbox and disk throw EISDIR), a keyed store answers
 * ENOENT because a directory there is a set of keys rather than an object,
 * and sftp answers with an error carrying no errno at all.
 *
 * Three ways the answer can be yes, in probe-cost order. The code itself
 * costs nothing. The stat is one call, and a stat that ANSWERS ends the
 * cascade either way: a file is a file, and the later probe only makes
 * sense for a path stat could not see. Reaching past a successful stat
 * read a rule-refused file as a directory, because its parent's listing
 * names it. The parent listing is one call and is the only thing that can
 * tell a missing key from a prefix that exists only through deeper keys.
 *
 * A no leaves the original error untouched, so nothing is swallowed: the
 * caller rethrows what the backend said. Both probes are broad for that
 * same reason: a probe that fails is a negative probe, never an error to
 * surface. Surfacing one would replace the read's error with one from a
 * call the user never made, and it is the read that failed.
 * `isImplicitDir` narrows to a miss because for its other caller the stat
 * IS the operation; here it is a probe, so the wider catch belongs on this
 * side of the call, and each failure it absorbs is logged.
 */
async function readHitADir(
  stat: (path: PathSpec) => Promise<FileStat>,
  readdir: (path: PathSpec) => Promise<string[]>,
  path: PathSpec,
  err: unknown,
): Promise<boolean> {
  if ((err as { code?: string } | null)?.code === 'EISDIR') return true
  // The path did not resolve at all, which no reading turns into a
  // directory; its parent may well list the name it simplifies to.
  if (isDotWalkError(err)) return false
  let st: FileStat | null = null
  try {
    st = await stat(path)
  } catch (probe) {
    console.debug(`read probe: stat ${path.virtual} failed: ${String(probe)}`)
    st = null
  }
  if (st !== null) return st.type === FileType.DIRECTORY
  try {
    if (await isImplicitDir(readdir, path)) return true
  } catch (probe) {
    console.debug(`read probe: listing ${path.virtual} failed: ${String(probe)}`)
  }
  return false
}

// A whole or ranged read that refuses a directory with GNU's EISDIR, refined
// after a failure or an empty read.
function bytesRefusingDirs<T extends unknown[]>(
  read: (path: PathSpec, ...args: T) => Promise<Uint8Array>,
  stat: (path: PathSpec) => Promise<FileStat>,
  readdir: (path: PathSpec) => Promise<string[]>,
): (path: PathSpec, ...args: T) => Promise<Uint8Array> {
  return async (path, ...args) => {
    try {
      const data = await read(path, ...args)
      if (data.byteLength === 0 && (await readHitADir(stat, readdir, path, null))) {
        throw eisdir(path)
      }
      return data
    } catch (err) {
      if (await readHitADir(stat, readdir, path, err)) throw eisdir(path)
      throw err
    }
  }
}

async function* drainRefusingDirs(
  stat: (path: PathSpec) => Promise<FileStat>,
  readdir: (path: PathSpec) => Promise<string[]>,
  path: PathSpec,
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  let empty = true
  try {
    for await (const chunk of source) {
      empty = empty && chunk.byteLength === 0
      yield chunk
    }
  } catch (err) {
    if (await readHitADir(stat, readdir, path, err)) throw eisdir(path)
    throw err
  }
  if (empty && (await readHitADir(stat, readdir, path, null))) throw eisdir(path)
}

async function* streamRefusingDirs(
  files: CommandFiles,
  ctx: Context,
  p: PathSpec,
): AsyncIterable<Uint8Array> {
  await statRefusingDirs(files, ctx, p)
  yield* files.readStream(p)
}

// Read stream for the read-family per-operand chokepoint (`readOperands`):
// the operand is stat'ed first so a directory fails with EISDIR before any
// backend read runs (sftp reads of a directory raise an opaque `Failure`,
// not ENOENT), and an ENOENT for an implicit keyed-backend directory or a
// namespace-only mount parent is refined the same way `dirAwareStat` does,
// before the generic formats the stderr line (#457). Mirrors Python's
// `dir_aware_stream`.
export function dirAwareStream(
  files: CommandFiles,
  ctx: Context,
): (p: PathSpec) => AsyncIterable<Uint8Array> {
  return (p) => streamRefusingDirs(files, ctx, p)
}

/**
 * Expand glob operands, or [] when there is nothing to resolve: no operand
 * resolves to no paths, which the generics read as stdin mode. Operand
 * semantics (report-and-continue, directory refusal) live in the generics
 * via `splitReadable`; this is wiring only. Mirrors Python's
 * `resolve_or_empty`.
 */
export async function resolveOrEmpty(
  files: CommandFiles,
  paths: readonly PathSpec[],
): Promise<PathSpec[]> {
  return paths.length > 0 ? files.resolveGlob(paths) : []
}

/** Refuse a relocation that would surface a hidden path.
 *
 * A rename or a native directory copy re-anchors everything below its
 * source, and a hide's coverage does not move with the content, so
 * hidden bytes would land at paths the session can see. EACCES on the
 * source, which mv and cp render in GNU's permission-denied voice.
 * Only a directory has anything below it to re-anchor, so callers
 * check this for a source they know is a directory and skip it for a
 * file. Mirrors Python's `refuse_reveal`. */
export function refuseReveal(src: PathSpec, dst: PathSpec, access?: SessionAccess): void {
  if (moveReveals(sessionVisibility(access), src.virtual, dst.virtual)) throw eacces(src.virtual)
}

/**
 * The files of the command `ctx` runs, its operands `paths`.
 *
 * Every call goes to the dispatcher through `ctx.vfs`. A command on one
 * mount reads the stored bytes (`filetype: null`), its whole reads warmed
 * ahead of themselves (`readAhead`), and, as the factory hands it on
 * (`withReading`), under the command tier's guards: a read of a directory
 * refused with EISDIR, a write to a slash-terminated name refused, a stat's
 * unknown size filled from the read cache, no call started once the line's
 * signal has fired, each operand's read cut into pieces under its abort and
 * deadline. A run across mounts (`crossesMounts`) reads each operand as the
 * command that asked for it, through the path's renderer, after a stat that
 * refuses a directory, and lists with no boundary to stop at. Throws without
 * `ctx.vfs`: a builder outside a workspace has no files to read. Mirrors
 * Python's `command_files`.
 */
export function commandFiles(ctx: Context, paths: readonly PathSpec[] = []): CommandFiles {
  const vfs = ctx.vfs
  if (vfs === undefined) throw new TypeError(`${ctx.spec?.name ?? ''}: no workspace files`)
  const dispatch = vfs.dispatch
  const crossing = crossesMounts(ctx)
  const reading = crossing ? undefined : READINGS.get(ctx)
  const signal = reading === undefined ? undefined : ctx.signal
  // What the mount can do is the serving mount's to say: an option can route
  // the command to it with no operand there (`shuf -i 1-1 -o /ram/out` typed
  // on another mount).
  const anchor = `${mountRoot(ctx)}/`
  const mounts = mountsOf(ctx)
  const [ahead, noted] = readAhead(dispatch, paths)
  const call = (
    name: string,
    path: PathSpec,
    args: readonly unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ): Promise<unknown> => dispatchedCall(dispatch, name, path, args, kwargs)
  const guard = <T extends unknown[], R>(fn: (...args: T) => Promise<R>) =>
    refusedAfterAbort(signal, fn)
  const writing = <T extends unknown[]>(fn: (path: PathSpec, ...args: T) => Promise<void>) =>
    guard(reading === undefined ? fn : slashChecked(fn))

  let rawStat: (path: PathSpec) => Promise<FileStat>
  let rawReaddir: (path: PathSpec, nofollow?: boolean) => Promise<string[]>
  let rawBytes: (path: PathSpec) => Promise<Uint8Array>
  let rawStream: (path: PathSpec) => AsyncIterable<Uint8Array>
  if (crossing) {
    rawStat = async (path) => (await dispatch('stat', path, [], { nofollow: true }))[0] as FileStat
    rawReaddir = async (path) => (await dispatch('readdir', path))[0] as string[]
    rawBytes = async (path) => {
      if (((await dispatch('stat', path))[0] as FileStat).type === FileType.DIRECTORY)
        throw eisdir(path)
      await ahead(path)
      return materialize((await dispatch('read', path))[0] as ByteSource)
    }
    rawStream = (path) => callerStream(dispatch, currentCaller(), path, ahead)
  } else {
    rawStat = (path) => dispatchedStat(dispatch, path)
    rawReaddir = async (path, nofollow) =>
      (await call('readdir', path, [], nofollow === true ? { nofollow } : {})) as string[]
    rawBytes = (path) => dispatchedBytes(dispatch, path, 0, null, ahead)
    const stream = reading?.stream ?? null
    rawStream =
      stream === null
        ? (path) => dispatchedStream(dispatch, path, ahead)
        : (path) => stream(ctx, path) ?? dispatchedStream(dispatch, path, ahead)
  }
  const rawRange = (path: PathSpec, offset: number, size: number | null): Promise<Uint8Array> =>
    dispatchedBytes(dispatch, path, offset, size)

  const listed = reading?.cachedSizes === true ? cachedStat(rawStat) : rawStat
  const readBytes =
    reading === undefined ? rawBytes : bytesRefusingDirs(rawBytes, listed, rawReaddir)
  const readRange =
    reading === undefined ? rawRange : bytesRefusingDirs(rawRange, listed, rawReaddir)
  // The wrapped stream is opened HERE, not inside the drain: the read-through
  // cache reads the active CacheManager when the stream is asked for, and
  // deferring that to drain time loses the mount's cache-manager scope, so
  // every warm read missed.
  const readStream =
    reading === undefined
      ? rawStream
      : (path: PathSpec) =>
          guardInput(
            drainRefusingDirs(listed, rawReaddir, path, rawStream(path)),
            ctx,
            reading.split,
          )
  const stat = guard(listed)
  const readdir = guard(rawReaddir)
  const links = crossing ? undefined : linksOf(ctx)
  const access = crossing ? undefined : ctx.session?.access()
  return {
    stat,
    exists: guard((path: PathSpec) => dispatchedExists(dispatch, path)),
    readdir,
    readBytes: guard(readBytes),
    readRange: guard(readRange),
    readStream,
    write: writing(async (path: PathSpec, data: ByteSource) => {
      await call('write', path, [data])
    }),
    append: writing(async (path: PathSpec, data: ByteSource) => {
      await call('append', path, [data])
    }),
    pwrite: writing(async (path: PathSpec, data: Uint8Array, offset: number) => {
      await call('pwrite', path, [data, offset])
    }),
    create: guard(async (path: PathSpec) => {
      await call('create', path)
    }),
    mkdir: guard(async (path: PathSpec, parents?: boolean) => {
      await call('mkdir', path, [], { parents: parents ?? false })
    }),
    unlink: guard(async (path: PathSpec) => {
      await call('unlink', path)
    }),
    rmdir: guard(async (path: PathSpec) => {
      await call('rmdir', path)
    }),
    rmR: guard(async (path: PathSpec) => {
      await call('rm_r', path)
    }),
    rename: guard(async (src: PathSpec, dst: PathSpec) => {
      await call('rename', src, [dst])
    }),
    copy: guard(async (src: PathSpec, dst: PathSpec) => {
      await call('copy', src, [dst])
    }),
    dirCopy: guard(async (src: PathSpec, dst: PathSpec) => {
      await call('dir_copy', src, [dst])
    }),
    truncate: writing(async (path: PathSpec, length: number, noCreate?: boolean) => {
      await call('truncate', path, [length], { no_create: noCreate ?? false })
    }),
    setAttrs: guard(
      async (path: PathSpec, fields: SetAttrFields) =>
        (await call('setattr', path, [], { ...fields })) as Record<string, number | string>,
    ),
    firstLines: uncached(
      guard(
        async (path: PathSpec, n: number) =>
          (await call('first_lines', path, [n])) as Uint8Array | null,
      ),
    ),
    lastLines: uncached(
      guard(
        async (path: PathSpec, n: number) =>
          (await call('last_lines', path, [n])) as Uint8Array | null,
      ),
    ),
    lineCount: uncached(
      guard(async (path: PathSpec) => (await call('line_count', path)) as number | null),
    ),
    checksum: uncached(
      guard(
        async (path: PathSpec, algorithm: string) =>
          (await call('checksum', path, [algorithm])) as string | null,
      ),
    ),
    follow: guard(
      async (path: PathSpec, n: number, interval: number) =>
        (await call('follow', path, [n, interval])) as AsyncIterable<Uint8Array> | null,
    ),
    // A subtree read stops at a link at the final name (ENOTDIR): it cannot
    // pass through one, so a walk that follows links lists them directory by
    // directory instead.
    readTree: guard(
      async (path: PathSpec) =>
        (await call('read_tree', path, [], { nofollow: true })) as Map<string, FileStat> | null,
    ),
    filesContaining: async (path, text, opts) =>
      (await call('files_containing', path, [text], {
        whole_word: opts.wholeWord,
        ignore_case: opts.ignoreCase,
      })) as PathSpec[] | null,
    linesContaining: async (path, text, opts) =>
      (await call('lines_containing', path, [text], {
        ignore_case: opts.ignoreCase,
      })) as ByteSource | null,
    resolveGlob: makeResolveGlob(
      readdir,
      mounts?.maxGlobMatches(anchor) ?? DEFAULT_MAX_GLOB_MATCHES,
      stat,
      links === undefined ? undefined : (virtual: string) => links.targetStat(virtual),
      access,
      followOf(ctx),
      noted,
    ),
    answers: (name: string) =>
      crossing ? CROSSING_CALLS.has(name) : (mounts?.answers(anchor, name) ?? false),
  }
}
