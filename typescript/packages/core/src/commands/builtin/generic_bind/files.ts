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

import { callsAs, currentCaller, sessionVisibility } from '../../../context/session_context.ts'
import { eacces, eisdir, enoent, isDotWalkError, isEnoent } from '../../../errors/fs.ts'
import { ensureStream } from '../../../io/stream.ts'
import type { ByteSource } from '../../../io/types.ts'
import { revisionFor } from '../../../observe/context.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { FileStat, FileType, PathSpec, type SetAttrFields } from '../../../types.ts'
import { hasAborted, makeAbortError } from '../../../utils/abort.ts'
import { makeResolveGlob, type ResolveGlobFn } from '../../../utils/glob_walk.ts'
import { moveReveals } from '../../../utils/hidden.ts'
import { CycleError } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import type { MountView, SessionAccess } from '../../../view/types.ts'
import type { Context } from '../../config.ts'
import { chunks } from '../../../io/cooperative.ts'
import {
  crossesMounts,
  followOf,
  linkLocation,
  linksOf,
  mountRoot,
  mountView,
  mountsOf,
  owedNames,
} from '../utils/links.ts'
import { isImplicitDir } from '../utils/paths.ts'
import type { ReadTree } from '../utils/tree.ts'
import { callerStream } from './dispatch.ts'

/**
 * A command's files, path-first, every call sent to the dispatcher through
 * the session's files (`ctx.vfs`).
 *
 * The dispatcher checks hides, the command's path rule, the mount's mode and
 * policy, refuses a read of a directory and a write to a slash-terminated
 * name, serves a warm copy and fills a cold one, fills a stat's unknown size
 * from the read cache, gives way to the read for a file the read cache holds
 * where a call stands in for one, settles a write's caches and receipt under
 * its name's hold, and declines a one-call walk (a subtree read, search, a
 * tree copy or removal) whose subtree the caller's view restricts, so a
 * command's call answers what the same call through `ws.vfs` or FUSE
 * answers. A function the mount's VFS does not answer is the
 * dispatcher's ENOTSUP; a command asks `answers` before it takes a shortcut.
 * Mirrors Python's `CommandFiles`.
 */
export interface CommandFiles {
  /** The line's abort and the command's deadline, for a walk `treeWalk` answers. */
  readonly signal?: AbortSignal
  /** The entry at `path` itself, as lstat answers. */
  readonly stat: (path: PathSpec) => Promise<FileStat>
  readonly exists: (path: PathSpec) => Promise<boolean>
  readonly readdir: (path: PathSpec, nofollow?: boolean, limit?: number) => Promise<string[]>
  /**
   * `read(path, offset?, size?)`: the stored bytes or a window of them,
   * opened at the first pull; `materialize` collects them.
   */
  readonly read: (
    path: PathSpec,
    offset?: number,
    size?: number | null,
  ) => AsyncIterable<Uint8Array>
  /**
   * Whether the read cache holds a copy a read would be served from; it
   * fetches neither the copy nor anything from the backend.
   */
  readonly isWarm: (path: PathSpec) => Promise<boolean>
  readonly write: (path: PathSpec, data: ByteSource) => Promise<void>
  readonly append: (path: PathSpec, data: ByteSource) => Promise<void>
  readonly pwrite: (path: PathSpec, data: ByteSource, offset: number) => Promise<void>
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
  readonly readTree: ReadTree
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
 * producer's chunks), and what streams an operand in place of the dispatched
 * read (null keeps it).
 */
export interface Reading {
  readonly split: boolean
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
// serves the path; of the other functions it takes only `readTree`'s
// shortcut, where no mount sits below the subtree.
const CROSSING_CALLS: ReadonlySet<string> = new Set([
  'write',
  'pwrite',
  'unlink',
  'mkdir',
  'truncate',
])

// How many files a whole read warms ahead of itself (`ReadAhead`).
const READ_AHEAD = 8

// How many of a command's latest listings its reads are matched against.
const LISTINGS = 16

// Files a command reads in turn: its operands, or the files of one directory
// as a listing or subtree answer named them. `sent` is where the next batch
// starts and `last` where the latest read was. Mirrors Python's `_Run`.
class Run {
  sent = 0
  last: number | null = null
  order: Map<string, number> | null = null
  readonly warming = new Map<string, Promise<boolean>>()

  constructor(readonly names: string[]) {}

  at(virtual: string): number | undefined {
    this.order ??= new Map(this.names.map((name, i) => [name, i]))
    return this.order.get(virtual)
  }
}

// A subtree answer and, once a read lands below it, its files grouped by
// directory, each keyed by its path below `root`. Mirrors Python's `_Tree`.
interface Tree {
  root: string
  rows: Map<string, FileStat>
  groups: Map<string, string[]> | null
}

/**
 * What a command's whole reads warm ahead of themselves.
 *
 * A command reads files in turn: its operands, each whole once the one before
 * is done, or the files a walk lists, a directory at a time. On a whole read
 * of one, the files after it in its run go to the dispatcher as one
 * `read_many`, which keeps the small files among them in the read cache (one
 * request where the store reads a batch), and the batch after goes once half
 * of that one is read. Operands warm READ_AHEAD at a time. A walk warms as it
 * shows it reads what it lists: one file once it reads two in a row, twice as
 * many each time a read lands on a warmed file, up to READ_AHEAD, and none
 * once it passes over files it warmed, so a walk that reads few of the files
 * it lists (a name filter) fetches few it never reads; the pace carries into
 * the next directory. A read whose file is still being warmed waits for it,
 * so it is served warm instead of fetching the file again. No bytes are held
 * here: a write in between drops the cached copy as it drops any. A path in
 * neither the operands nor the latest LISTINGS listings and subtree answers
 * warms nothing.
 *
 * It sits in the command's dispatcher (`dispatch`), which every whole read,
 * listing and subtree read of the command goes through. Mirrors Python's
 * `ReadAhead`.
 */
export class ReadAhead {
  private readonly operands = new Run([])
  private readonly specs = new Map<string, PathSpec>()
  private readonly stats = new Map<string, FileStat>()
  private readonly runs = new Map<string, Run>()
  private readonly trees: Tree[] = []
  private width = 0
  private kept = true

  constructor(
    private readonly inner: DispatchFn,
    paths: readonly PathSpec[],
  ) {
    this.operands.sent = 1
    this.operands.order = new Map()
    this.noted(paths)
  }

  /** Learn the operands a glob resolved to, in order. */
  noted(found: readonly PathSpec[]): void {
    const run = this.operands
    for (const path of found) {
      if (path.pattern === null && !this.specs.has(path.virtual)) {
        this.specs.set(path.virtual, path)
        run.order?.set(path.virtual, run.names.length)
        run.names.push(path.virtual)
      }
    }
  }

  /**
   * The command's dispatcher: a whole read first warms what follows it, and a
   * listing or subtree read is learned as the order the command's walk reads
   * its files in.
   */
  readonly dispatch: DispatchFn = async (name, path, args, kwargs, report) => {
    const asked = (kwargs ?? {}) as { offset?: number; size?: number | null; warm?: boolean }
    if (
      name === 'read' &&
      (asked.offset ?? 0) === 0 &&
      (asked.size ?? null) === null &&
      asked.warm !== true
    ) {
      await this.warmed(path)
    }
    const answer = await this.inner(name, path, args, kwargs, report)
    const folder = rstripSlash(path.virtual) || '/'
    if (name === 'stat' && this.specs.has(path.virtual) && answer[0] instanceof FileStat) {
      this.stats.set(path.virtual, answer[0])
    } else if (name === 'readdir' && Array.isArray(answer[0])) {
      const files = (answer[0] as string[]).filter((n) => !n.endsWith('/'))
      this.keep(folder, new Run(files))
    } else if (name === 'read_tree' && answer[0] instanceof Map) {
      this.trees.push({ root: folder, rows: answer[0] as Map<string, FileStat>, groups: null })
      if (this.trees.length > LISTINGS) this.trees.shift()
    }
    return answer
  }

  // Warm what follows `path` in its run, then wait for `path` itself while a
  // batch is fetching it; a batch whose mount keeps no reads (one holding its
  // data locally) ends the command's warming.
  private async warmed(path: PathSpec): Promise<void> {
    const run = this.run(path.virtual)
    const at = run?.at(path.virtual)
    if (run === undefined || at === undefined) return
    const pending = run.warming.get(path.virtual)
    run.warming.delete(path.virtual)
    const width = run === this.operands ? READ_AHEAD : this.paced(run, at, pending !== undefined)
    const start = Math.max(run.sent, at + 1)
    if (
      this.kept &&
      width > 0 &&
      start < run.names.length &&
      start - at <= Math.max(1, width >> 1)
    ) {
      const batch = run.names.slice(start, start + width)
      run.sent = start + batch.length
      const specs = batch.map((n) => this.specs.get(n) ?? PathSpec.fromStrPath(n))
      const stats = new Map<string, FileStat>()
      for (const name of batch) {
        const known = this.stats.get(name)
        if (known !== undefined) stats.set(name, known)
      }
      const task = warm(this.inner, specs, stats)
      for (const name of batch) run.warming.set(name, task)
    }
    if (pending !== undefined && !(await pending)) this.kept = false
  }

  // How many files a walk's read at `at` warms: twice the pace on a warmed
  // file, none past warmed files it passed over, one once two reads in a row
  // are neighbours, else the pace it had.
  private paced(run: Run, at: number, hit: boolean): number {
    const last = run.last
    run.last = at
    const passed = [...run.warming.keys()].filter((n) => (run.at(n) ?? at) < at)
    for (const name of passed) run.warming.delete(name)
    if (hit) this.width = Math.min(READ_AHEAD, Math.max(1, this.width) * 2)
    else if (passed.length > 0) this.width = 0
    else if (last !== null && at === last + 1) this.width = Math.max(1, this.width)
    return this.width
  }

  private keep(folder: string, run: Run): Run {
    this.runs.delete(folder)
    this.runs.set(folder, run)
    if (this.runs.size > LISTINGS) {
      const oldest = this.runs.keys().next().value
      if (oldest !== undefined) this.runs.delete(oldest)
    }
    return run
  }

  // The run a path is read in: the operands, its directory's listing, or that
  // directory's files as a subtree answer holds them.
  private run(virtual: string): Run | undefined {
    if (this.specs.has(virtual)) return this.operands
    const cut = virtual.lastIndexOf('/')
    const folder = cut > 0 ? virtual.slice(0, cut) : '/'
    const listed = this.runs.get(folder)
    if (listed !== undefined) return this.keep(folder, listed)
    for (const tree of [...this.trees].reverse()) {
      const base = `${rstripSlash(tree.root)}/`
      if (folder !== tree.root && !folder.startsWith(base)) continue
      if (tree.groups === null) {
        tree.groups = new Map()
        for (const [key, row] of tree.rows) {
          if (row.type === FileType.DIRECTORY) continue
          const above = key.slice(0, Math.max(0, key.lastIndexOf('/')))
          const group = tree.groups.get(above)
          if (group === undefined) tree.groups.set(above, [key])
          else group.push(key)
        }
      }
      const rel = folder === tree.root ? '' : folder.slice(base.length)
      const below = [...(tree.groups.get(rel) ?? [])].sort(compareCodePoints)
      return this.keep(folder, new Run(below.map((key) => base + key)))
    }
    return undefined
  }
}

/**
 * Ask the dispatcher to keep `paths` in the read cache, and answer whether
 * their mount keeps reads at all; `stats` are the stats the command made of
 * them, which size a file no listing holds. A failure is logged and dropped:
 * each read that follows meets it. Mirrors Python's `_warm`.
 */
async function warm(
  dispatch: DispatchFn,
  paths: readonly PathSpec[],
  stats: Map<string, FileStat>,
): Promise<boolean> {
  const [first, ...rest] = paths
  if (first === undefined) return true
  try {
    const [kept] = await dispatch('read_many', first, [], { paths: rest, stats })
    return kept !== false
  } catch (err) {
    console.debug(`read-ahead from ${first.virtual} failed: ${String(err)}`)
    return true
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

/**
 * The `readTree` a walk through the dispatcher takes, asked only where the
 * mount a subtree lands on answers one; elsewhere null, and the walk lists
 * instead.
 *
 * The serving mount's answer is no guide: a walk through the dispatcher also
 * reaches the mounts below it and those a link above the subtree leads to, so
 * a subtree on one that answers no read_tree (a disk mount under the root RAM)
 * is walked rather than refused with ENOTSUP. A walk across mounts
 * (`crossing`) asks only where no mount sits below the subtree either: the
 * serving backend's answer holds keys a mount there shadows, and lacks the
 * mount's own. A subtree read stops at a link at the final name (ENOTDIR), so
 * a walk that follows links lists them directory by directory instead. One
 * level (`level`) is the listing a `readdir` answers with each child's stat,
 * which every mount that keeps listings answers, asked only where no mount
 * sits below, whose root the listing would name.
 * `mounts` is the boundary view a walk that does not cross them sees
 * (`mountView(files)`), undefined to take no shortcut; `landing` where a path lands, every link above its
 * final name followed (`linkLocation`, `NamespaceLinks.followParent`), null
 * for a walk whose paths name their own place. Mirrors Python's
 * `dispatched_read_tree`.
 */
export function dispatchedReadTree(
  dispatch: DispatchFn,
  mounts: MountView | undefined,
  landing: ((virtual: string) => string) | null,
  crossing: boolean,
): ReadTree {
  return async (path, limit, level = false) => {
    let at: string
    try {
      at = landing === null ? path.virtual : landing(path.virtual)
    } catch (err) {
      if (!(err instanceof CycleError)) throw err
      console.debug(`following the links above ${path.virtual} failed: ${String(err)}`)
      return null
    }
    if (
      mounts === undefined ||
      (!level && !mounts.answers(at, 'read_tree')) ||
      ((crossing || level) && mounts.descendants(at).length > 0)
    )
      return null
    return (await dispatchedCall(dispatch, 'read_tree', path, [], {
      nofollow: true,
      ...(limit === undefined ? {} : { limit }),
      ...(level ? { level: true } : {}),
    })) as Map<string, FileStat> | null
  }
}

/** A command's streamed read of the stored bytes, or a window of them, at the
 * dispatcher, opened at the first pull as a backend stream is. */
async function* dispatchedStream(
  dispatch: DispatchFn,
  path: PathSpec,
  offset = 0,
  size: number | null = null,
): AsyncIterable<Uint8Array> {
  const [data] = await dispatch('read', path, [], { stream: true, filetype: null, offset, size })
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
    if (await isImplicitDir(files.readdir, p)) st = await landedOrDir(files, p)
    else if (isNamespaceDir(ctx, p)) throw eisdir(p)
    else throw e
  }
  if (st.type === FileType.DIRECTORY) throw eisdir(p)
  return st
}

// A file written between the stat that missed it and the listing that named
// it looks like a prefix of deeper keys, so `echo hi > f &` then `cat f` read
// the new file as a directory. A second stat tells the two apart: only a
// prefix misses again. Mirrors Python's `_landed_or_dir`.
async function landedOrDir(files: CommandFiles, p: PathSpec): Promise<FileStat> {
  try {
    return await files.stat(p)
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e
    throw eisdir(p)
  }
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
  opened = false,
): (p: PathSpec) => Promise<number | null> {
  return async (p) => {
    if (READINGS.get(ctx)?.stream != null || (opened && crossesMounts(ctx))) return null
    if (revisionFor(p.virtual) !== null) return null
    if (await files.isWarm(p)) return null
    const st = await statRefusingDirs(files, ctx, p)
    if (
      st.type !== FileType.FILE ||
      st.size === null ||
      (st.mode !== null && (!opened || st.size === 0))
    )
      return null
    if (ctx.vfs === undefined) return st.size
    const [now] = await ctx.vfs.dispatch('stat', p, [], { fresh: true })
    return now instanceof FileStat && now.size === st.size ? st.size : null
  }
}

async function* streamRefusingDirs(
  files: CommandFiles,
  ctx: Context,
  p: PathSpec,
): AsyncIterable<Uint8Array> {
  await statRefusingDirs(files, ctx, p)
  yield* files.read(p)
}

// The per-operand read stream, `read(path)`, the read family takes:
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
 * Every call goes to the dispatcher through `ctx.vfs`, which refuses a read
 * of a directory and a write to a slash-terminated name and fills a stat's
 * unknown size from the read cache. A command on one mount reads the stored
 * bytes (`filetype: null`), its whole reads warmed ahead of themselves
 * (`ReadAhead`), and, as the factory hands it on (`withReading`), under the
 * command tier's guards: no call started once the line's signal has fired,
 * each operand's read cut into pieces under its abort and deadline. A run
 * across mounts (`crossesMounts`) reads each operand as the
 * command that asked for it, through the path's renderer, after a stat that
 * refuses a directory, and lists with no boundary to stop at. Throws without
 * `ctx.vfs`: a builder outside a workspace has no files to read. Mirrors
 * Python's `command_files`.
 */
export function commandFiles(ctx: Context, paths: readonly PathSpec[] = []): CommandFiles {
  const vfs = ctx.vfs
  if (vfs === undefined) throw new TypeError(`${ctx.spec?.name ?? ''}: no workspace files`)
  const ahead = new ReadAhead(vfs.dispatch, paths)
  const dispatch = ahead.dispatch
  const crossing = crossesMounts(ctx)
  const reading = crossing ? undefined : READINGS.get(ctx)
  const signal = reading === undefined ? undefined : ctx.signal
  // What the mount can do is the serving mount's to say: an option can route
  // the command to it with no operand there (`shuf -i 1-1 -o /ram/out` typed
  // on another mount).
  const home = mountRoot(ctx)
  const anchor = `${home}/`
  const mounts = mountsOf(ctx)
  const call = (
    name: string,
    path: PathSpec,
    args: readonly unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ): Promise<unknown> => dispatchedCall(dispatch, name, path, args, kwargs)
  // `fn`, refused with the line's abort instead of started once `signal` has fired.
  const guard = <T extends unknown[], R>(
    fn: (...args: T) => Promise<R>,
  ): ((...args: T) => Promise<R>) =>
    signal === undefined
      ? fn
      : (...args) => (hasAborted(signal) ? Promise.reject(makeAbortError(signal)) : fn(...args))

  let rawStat: (path: PathSpec) => Promise<FileStat>
  let rawReaddir: (path: PathSpec, nofollow?: boolean, limit?: number) => Promise<string[]>
  let rawStream: (path: PathSpec) => AsyncIterable<Uint8Array>
  if (crossing) {
    // A run across mounts can hand its output on as it drains, after its
    // handler returned (`streams`): every call these files make opens as the
    // command that built them, whenever it is made.
    const caller = currentCaller()
    rawStat = callsAs(
      caller,
      async (path: PathSpec) =>
        (await dispatch('stat', path, [], { nofollow: true }))[0] as FileStat,
    )
    rawReaddir = callsAs(
      caller,
      async (path: PathSpec, _nofollow?: boolean, limit?: number) =>
        (await dispatch('readdir', path, [], limit === undefined ? {} : { limit }))[0] as string[],
    )
    rawStream = (path) => callerStream(dispatch, caller, path)
  } else {
    rawStat = (path) => dispatchedStat(dispatch, path)
    rawReaddir = async (path, nofollow, limit) =>
      (await call('readdir', path, [], {
        ...(nofollow === true ? { nofollow } : {}),
        ...(limit === undefined ? {} : { limit }),
      })) as string[]
    const stream = reading?.stream ?? null
    rawStream =
      stream === null
        ? (path) => dispatchedStream(dispatch, path)
        : (path) => stream(ctx, path) ?? dispatchedStream(dispatch, path)
  }
  const read = (
    path: PathSpec,
    offset = 0,
    size: number | null = null,
  ): AsyncIterable<Uint8Array> => {
    const source =
      offset === 0 && size === null
        ? rawStream(path)
        : dispatchedStream(dispatch, path, offset, size)
    return reading === undefined ? source : chunks(source, ctx.signal, reading.split)
  }
  // A run across mounts runs in no mount's cache scope: it takes an operand's
  // size from its stat, warm or not.
  const isWarm = async (path: PathSpec): Promise<boolean> =>
    crossing ? false : (await call('read', path, [], { filetype: null, warm: true })) === true
  const stat = guard(rawStat)
  const readdir = guard(rawReaddir)
  const table = linksOf(ctx)
  const links = crossing ? undefined : table
  const access = crossing ? undefined : ctx.session?.access()
  return {
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    stat,
    exists: guard((path: PathSpec) => dispatchedExists(dispatch, path)),
    readdir,
    read,
    isWarm: guard(isWarm),
    write: guard(async (path: PathSpec, data: ByteSource) => {
      await call('write', path, [data])
    }),
    append: guard(async (path: PathSpec, data: ByteSource) => {
      await call('append', path, [data])
    }),
    pwrite: guard(async (path: PathSpec, data: ByteSource, offset: number) => {
      await call('pwrite', path, [data, offset])
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
    truncate: guard(async (path: PathSpec, length: number, noCreate?: boolean) => {
      await call('truncate', path, [length], { no_create: noCreate ?? false })
    }),
    setAttrs: guard(
      async (path: PathSpec, fields: SetAttrFields) =>
        (await call('setattr', path, [], { ...fields })) as Record<string, number | string>,
    ),
    firstLines: guard(
      async (path: PathSpec, n: number) =>
        (await call('first_lines', path, [n])) as Uint8Array | null,
    ),
    lastLines: guard(
      async (path: PathSpec, n: number) =>
        (await call('last_lines', path, [n])) as Uint8Array | null,
    ),
    lineCount: guard(async (path: PathSpec) => (await call('line_count', path)) as number | null),
    checksum: guard(
      async (path: PathSpec, algorithm: string) =>
        (await call('checksum', path, [algorithm])) as string | null,
    ),
    follow: guard(
      async (path: PathSpec, n: number, interval: number) =>
        (await call('follow', path, [n, interval])) as AsyncIterable<Uint8Array> | null,
    ),
    readTree: guard(
      dispatchedReadTree(
        dispatch,
        mountView(vfs),
        table === undefined ? null : (virtual) => linkLocation(table, virtual),
        crossing,
      ),
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
      mounts?.walkLimit?.(anchor) ?? -1,
      stat,
      links === undefined ? undefined : (virtual: string) => links.targetStat(virtual),
      access,
      followOf(ctx),
      (found: PathSpec[]) => {
        ahead.noted(found)
      },
    ),
    answers: (name: string) =>
      name === 'read_range' && reading?.stream != null
        ? false
        : crossing
          ? CROSSING_CALLS.has(name) || name === 'read_tree'
          : (mounts?.answers(anchor, name) ?? false),
  }
}
