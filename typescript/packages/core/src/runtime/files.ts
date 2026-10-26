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

import { ConcurrencyLimiter } from '../concurrency/limiter.ts'
import { classify } from '../errors/index.ts'
import { ebadf, einval, eloop, isMissingOp, isMissingPath } from '../errors/fs.ts'
import {
  atimeMs,
  contentSize,
  DIR_MODE,
  deviceRdev,
  isCharDevice,
  isDir,
  isLink,
  mtimeMs,
  posixMode,
} from '../utils/stat_view.ts'
import { ABSENT_PATH, LISTING_ENTRY_CONCURRENCY } from './constants.ts'
import { CrossMountError } from './errors.ts'
import { normDir, rstripSlash } from '../utils/slash.ts'
import { CycleError, resolvePath } from '../utils/path.ts'
import { READ_CHUNK } from './handles/constants.ts'
import type { OpenMode } from './handles/index.ts'
import { MountCore } from '../mount/core.ts'
import { PrefixResolver, type MountResolver } from './resolver.ts'
import type { BridgeDispatchFn } from './types.ts'
import { CallerResolver, workspaceBridge, type WorkspaceBinding } from './binding.ts'
import { linkView } from '../commands/builtin/utils/links.ts'
import type { Context } from '../commands/config.ts'
import { awaitsAs, callsAs, currentCaller } from '../context/session_context.ts'
import { type FileStat, PathSpec, type SetAttrFields } from '../types.ts'
import { concat } from '../utils/bytes.ts'
import { entryName } from '../utils/remnants.ts'
import type { VFSEntry, VFSStat } from './types.ts'

/** Whether a failure is the mount saying the path is not there. */
function isAbsent(err: unknown): boolean {
  const condition = classify(err)
  return condition !== null && ABSENT_PATH.has(condition)
}

/**
 * Whether a listing row is one the file adapter did not classify.
 *
 * Its size-0 non-directory shape is a placeholder, not an answer: a
 * guest that needs the entry's kind, size or stamp must ask the mount
 * with a stat of its own, which also reports whatever failed. A
 * slash-marked directory and a link carry no mode either, but their
 * kind is known.
 */
export function isUnclassified(entry: VFSEntry | VFSStat): boolean {
  return entry.mode === undefined && !entry.isDir && entry.isLink !== true
}

/**
 * Translate one mirage stat row into the guest-facing struct.
 *
 * The projection lives in the file adapter rather than in each surface so both
 * languages build one struct in one tier: preview1 reads the type bits
 * out of `mode` and drops the rest, monty fills a `StatResult`,
 * Emscripten fills an `FSAttr`. Mirrors python's `stat_row`.
 */
function statRow(st: FileStat): VFSStat {
  const mtime = mtimeMs(st)
  const atime = atimeMs(st)
  return {
    size: contentSize(st),
    isDir: isDir(st),
    mode: posixMode(st),
    ...(mtime !== null ? { mtimeMs: mtime } : {}),
    ...(isLink(st) ? { isLink: true } : {}),
    ...(isCharDevice(st) ? { rdev: deviceRdev(st) } : {}),
    ...(atime !== null ? { atimeMs: atime } : {}),
    ...(typeof st.uid === 'number' ? { uid: st.uid } : {}),
    ...(typeof st.gid === 'number' ? { gid: st.gid } : {}),
    source: st,
  }
}

/**
 * One file a guest holds open: the run's core handle on it, the position
 * its reads and writes move, and what its open asked for. Nothing the guest
 * reads or writes stays here: the core holds it (`RuntimeFiles.open`), so
 * every entry point judges, lands and keeps an open file one way. A stream
 * and a descriptor over one open share this, and with it the position, as
 * POSIX shares an open file description. Mirrors Python's `Descriptor`.
 */
export class Descriptor {
  pos = 0

  /**
   * @param files the adapter whose core the handle is on.
   * @param fd the core's handle.
   * @param mode what the open asked for.
   * @param opened the path it was opened at, the name a file object reports.
   * @param directory it names a directory, which it may not read.
   * @param inode where the links on `opened` led as it opened, which names
   *   its inode however the file is renamed or the link changed since.
   */
  constructor(
    readonly files: RuntimeFiles,
    readonly fd: number,
    readonly mode: OpenMode,
    readonly opened: string,
    readonly directory = false,
    readonly inode = opened,
  ) {}

  /** The path its file has now; a rename moves it. */
  get path(): string {
    return this.files.pathOf(this.fd)
  }

  /** The file's length as the handle holds it, its writes counted. */
  async size(): Promise<number> {
    return (await this.files.fstat(this.fd)).size
  }

  /** Read at an explicit offset without moving the position. */
  async pread(offset: number, size: number): Promise<Uint8Array> {
    if (size <= 0) return new Uint8Array()
    return this.files.pread(this.fd, offset, size)
  }

  /**
   * Read from the position, advancing it by what was read; a negative or
   * null size reads to the end, a chunk at a time.
   */
  async read(size: number | null = null): Promise<Uint8Array> {
    if (size !== null && size >= 0) {
      const chunk = await this.pread(this.pos, size)
      this.pos += chunk.byteLength
      return chunk
    }
    const parts: Uint8Array[] = []
    for (;;) {
      const chunk = await this.pread(this.pos, READ_CHUNK)
      if (chunk.byteLength === 0) return concat(parts)
      parts.push(chunk)
      this.pos += chunk.byteLength
    }
  }

  /**
   * One line from the position, its newline included, advancing past it;
   * null at the end of the file. It reads ahead 4 KiB at a time, so a
   * short line costs one read.
   */
  async readLine(): Promise<Uint8Array | null> {
    const parts: Uint8Array[] = []
    let at = this.pos
    for (;;) {
      const chunk = await this.pread(at, 4096)
      const newline = chunk.indexOf(0x0a)
      if (newline >= 0) {
        parts.push(chunk.subarray(0, newline + 1))
        this.pos = at + newline + 1
        return concat(parts)
      }
      if (chunk.byteLength === 0) {
        this.pos = at
        return parts.length === 0 ? null : concat(parts)
      }
      parts.push(chunk)
      at += chunk.byteLength
    }
  }

  /** Write at an explicit offset without moving the position; an appending handle writes at its end. */
  async pwrite(offset: number, data: Uint8Array): Promise<void> {
    if (data.byteLength > 0) await this.files.pwrite(this.fd, offset, data)
  }

  /**
   * Write at the position, advancing it past what was written; an appending
   * handle first moves the position to its end, as O_APPEND does, so a
   * write that fails to find the end leaves nothing written.
   */
  async write(data: Uint8Array): Promise<void> {
    if (this.mode.append && data.byteLength > 0) this.pos = await this.size()
    const at = this.pos
    this.pos += data.byteLength
    await this.pwrite(at, data)
  }

  /**
   * Move the position, POSIX whence numbering; null when the whence is
   * unknown or the target would be negative (the position is then
   * untouched).
   */
  async seek(offset: number, whence: number): Promise<number | null> {
    const base =
      whence === 0 ? 0 : whence === 1 ? this.pos : whence === 2 ? await this.size() : null
    if (base === null || base + offset < 0) return null
    this.pos = base + offset
    return this.pos
  }

  /** Set the file's length: a shrink drops bytes, growth reads zeros. */
  async truncate(size: number): Promise<void> {
    await this.files.ftruncate(this.fd, size)
  }

  /** Land what it wrote, as fsync(2) does. */
  async land(): Promise<void> {
    await this.files.fsync(this.fd)
  }

  /** Land what it wrote and let the core's handle go. */
  async close(): Promise<void> {
    await this.files.close(this.fd)
  }
}

/**
 * The mount-facing op vocabulary a sandboxed runtime encodes into.
 *
 * One instruction set (read/write/append/stat/readdir/create/truncate/
 * unlink/mkdir/rmdir/rename/symlink/readlink/setattr), one routing
 * table, one place that knows an append may have to become a
 * whole-file write. The last three reach the name plane rather than a
 * backend, which is what lets a guest create a link or stamp a time on
 * a mount whose store has neither. Encoders hold one of these; they
 * never inherit it, because a monty encoder is the binding's own `os`
 * callback and a quickjs encoder is a table of host functions.
 *
 * The surface is async, unlike Python's: a JS guest either suspends at
 * the call (quickjs asyncify) or records the mutation and replays it
 * after the run (pyodide), so nothing here has to block a worker
 * thread the way the Python runtimes do.
 *
 * A file the guest opens is a handle on the run's `MountCore` (`open`,
 * `pread`, `pwrite`, `fstat`, `ftruncate`, `fsync`, `close`), the
 * open-file layer every entry point shares: it holds what the guest read,
 * keeps what it wrote until a close or a sync, lands it in the order the
 * writes were made, and keeps a file whose name went for the handles open
 * on it. The guest's own table keeps only the descriptor number, its
 * position and its flags. A removal, a rename, a truncate and a change of
 * times by path go through the core too, so the files open on that path
 * follow them. Mirrors Python's `RuntimeFiles`.
 */
export class RuntimeFiles {
  private readonly dispatch: BridgeDispatchFn
  private readonly resolver: MountResolver
  private readonly noAppend = new Set<string>()

  /**
   * @param bridge the bridge every op rides, over the run's files; it also
   *   answers the raw calls a guest makes past the typed methods (the
   *   Pyodide worker's xattr and alias checks).
   * @param resolver the workspace mount routing table; the default answers
   *   no mounts, so routing questions answer null.
   * @param resolve where the namespace's links lead a path; null while the
   *   workspace keeps no links.
   * @param core the open-file core the run's files open on; null opens
   *   nothing.
   * @param signal the run's, which stops a core op once it aborts.
   * @param live the signals of the guest calls on the core now, which its
   *   every dispatch checks; a call with none (a run's end landing what it
   *   wrote) passes, however the run ended.
   */
  constructor(
    readonly bridge: BridgeDispatchFn,
    resolver: MountResolver = new PrefixResolver(() => []),
    private readonly resolve: ((path: string) => string) | null = null,
    private readonly core: MountCore | null = null,
    private readonly signal: AbortSignal | null = null,
    private readonly live: AbortSignal[] = [],
  ) {
    // One cap on every request the file adapter sends, held for that request
    // alone, so the stats of listings that run together (a guest
    // walking a tree) share it with the walk's own reads.
    const limiter = new ConcurrencyLimiter(LISTING_ENTRY_CONCURRENCY)
    this.dispatch = async (...args) => {
      const release = await limiter.acquire()
      try {
        return await bridge(...args)
      } finally {
        release()
      }
    }
    this.resolver = resolver
  }

  /**
   * The file adapter every engine builds for one run.
   *
   * Over the run's files (`ctx.vfs`, whose calls are the program's own),
   * the binding's routing table and the namespace's links, each replaying
   * the run's context, which `Runtime.execute` set up, for a guest that
   * calls back from elsewhere. A run with no files rides the binding's
   * guest bridge (`WorkspaceBinding.overBridge`, the Pyodide worker's).
   *
   * @param ctx the run's context.
   * @param binding the runtime's binding; null outside a workspace, which
   *   has no adapter.
   */
  static of(ctx: Context, binding: WorkspaceBinding | null): RuntimeFiles | null {
    if (binding === null) return null
    const vfs = ctx.vfs
    const bridge =
      vfs === undefined
        ? binding.bridge
        : workspaceBridge(
            async (name, path, args, kwargs) =>
              (await vfs.dispatch(name, PathSpec.fromStrPath(path), args, kwargs))[0],
          )
    if (bridge === null) return null
    const caller = currentCaller()
    const links = linkView(vfs)
    const live: AbortSignal[] = []
    return new RuntimeFiles(
      awaitsAs(caller, bridge),
      new CallerResolver(binding.resolver, caller),
      links === undefined ? null : callsAs(caller, links.resolve.bind(links)),
      vfs === undefined
        ? null
        : new MountCore(
            vfs.over(
              // A cancelled guest call sends nothing more, whichever op of
              // the core's was under way.
              awaitsAs(caller, async (name, path, args, kwargs, report) => {
                for (const signal of live) signal.throwIfAborted()
                const out = await vfs.dispatch(name, path, args, kwargs, report)
                for (const signal of live) signal.throwIfAborted()
                return out
              }),
            ),
          ),
      null,
      live,
    )
  }

  /** A live guest view that stops issuing operations once its run is cancelled. */
  withSignal(signal: AbortSignal): RuntimeFiles {
    return new RuntimeFiles(
      async (...args) => {
        signal.throwIfAborted()
        const out = await this.bridge(...args)
        signal.throwIfAborted()
        return out
      },
      this.resolver,
      this.resolve,
      this.core,
      signal,
      this.live,
    )
  }

  /**
   * Run one op on the run's open-file core; EBADF when this adapter opens
   * nothing. An op that only lands what the guest already wrote (`lands`)
   * runs however the run ended, as the run's end would land it anyway.
   */
  private async onCore<T>(op: (core: MountCore) => Promise<T>, lands = false): Promise<T> {
    if (this.core === null) throw ebadf('/')
    const signal = lands ? null : this.signal
    if (signal === null) return op(this.core)
    signal.throwIfAborted()
    this.live.push(signal)
    try {
      const out = await op(this.core)
      signal.throwIfAborted()
      return out
    } finally {
      this.live.splice(this.live.indexOf(signal), 1)
    }
  }

  /** The path the core's handle `fd` is on now; EBADF for any other number. */
  pathOf(fd: number): string {
    const held = this.core?.handles.get(fd)
    if (held === undefined) throw ebadf(String(fd))
    return held.path
  }

  /**
   * Open a file, the open's effect landing before any byte moves
   * (`MountCore.open`), and answer the core's handle for it. `perm` is the
   * mode bits a create gives the file; null takes the mount's default.
   */
  async open(path: string, mode: OpenMode, perm: number | null = null): Promise<number> {
    return this.onCore((core) => core.open(path, mode, perm))
  }

  /**
   * Read through an open handle: what it holds, judged as a read of its
   * path now, with what it wrote and has not landed laid over.
   */
  async pread(fd: number, offset: number, size: number): Promise<Uint8Array> {
    const path = this.pathOf(fd)
    return this.onCore((core) => core.read(path, fd, offset, size))
  }

  /**
   * Write through an open handle, which keeps the bytes until a close or a
   * sync lands them; one that appends writes at its end.
   */
  async pwrite(fd: number, offset: number, data: Uint8Array): Promise<void> {
    const path = this.pathOf(fd)
    await this.onCore((core) => core.write(path, fd, data, offset))
  }

  /** The row an open handle stats by, the size it holds counted. */
  async fstat(fd: number): Promise<VFSStat> {
    return statRow(await this.onCore((core) => core.fstat(fd)))
  }

  /** Whether the name an open handle's file had went, so the file has no link left. */
  unlinked(fd: number): boolean {
    return this.core?.handles.get(fd)?.detached !== undefined
  }

  /** Set the length of the file an open handle is on. */
  async ftruncate(fd: number, length: number): Promise<void> {
    await this.onCore((core) => core.ftruncate(fd, length))
  }

  /** Land what an open handle wrote, as fsync(2) does. */
  async fsync(fd: number): Promise<void> {
    const path = this.pathOf(fd)
    await this.onCore((core) => core.flush(path, fd), true)
  }

  /**
   * Land what an open handle wrote and let it go; a landing that fails
   * still lets it go, and is thrown.
   */
  async close(fd: number): Promise<void> {
    await this.onCore((core) => core.release(fd), true)
  }

  /**
   * The path an op on `path` lands on once the namespace's links are
   * followed: the final name too when `follow`, else only the directories
   * above it, since a rename or a removal acts on the name itself. One file
   * reads as one path whichever spelling reached it, which is how a removal
   * finds the files open on it. Mirrors Python's RuntimeFiles.walked.
   */
  walked(path: string, follow = true): string {
    const resolve = this.resolve
    if (resolve === null) return path
    try {
      if (follow) return resolvePath(resolve(path), '/')
      const cut = path.lastIndexOf('/')
      const above = resolvePath(resolve(path.slice(0, cut) || '/'), '/')
      return `${rstripSlash(above)}/${path.slice(cut + 1)}`
    } catch (err) {
      if (err instanceof CycleError) throw eloop(path)
      throw err
    }
  }

  /**
   * The workspace mount prefixes, longest first, trailing-slash
   * normalized. Longest first is what makes mountOf's first match the
   * right one when one mount nests inside another.
   */
  prefixes(): string[] {
    const out = this.resolver.prefixes().map((p) => normDir(p))
    return out.sort((a, b) => b.length - a.length)
  }

  /**
   * The mount prefix serving `path`, longest match first, or null. The
   * resolver answers in the mount table's own spelling; this surface
   * re-spells to its trailing-slash convention, the form `prefixes`
   * reports.
   */
  mountOf(path: string): string | null {
    const owner = this.resolver.ownerOf(path)
    return owner === null ? null : normDir(owner)
  }

  /**
   * Whether the workspace answers for `path`.
   *
   * A guest's content calls gate on this: monty and quickjs refuse a
   * path the workspace does not serve, so they read and write only the
   * view. A mount serves what is under it, and a namespace link serves
   * what is reached through it wherever it lives, because the
   * dispatcher follows a link outside every mount the same way. With no
   * mounts wired there is no scoping, and every path routes here.
   */
  serves(path: string): boolean {
    if (this.prefixes().length === 0 || this.mountOf(path) !== null) return true
    let directory = '/'
    for (const name of path.replace(/^\/+|\/+$/g, '').split('/')) {
      if (this.resolver.linkChildren(directory).has(name)) return true
      directory = directory.replace(/\/$/, '') + '/' + name
    }
    return false
  }

  /**
   * A file's bytes, or the range of them a handle asked for. `raw` reads
   * the stored bytes rather than a rendering, which is what an edit that is
   * written back must start from; `direct` reads what the backend holds
   * now, past the file cache. Mirrors Python's `RuntimeFiles.read`.
   */
  async read(
    path: string,
    options: { offset?: number; size?: number; raw?: boolean; direct?: boolean } = {},
  ): Promise<Uint8Array> {
    const out = await this.dispatch('read', path, undefined, undefined, options)
    if (!(out instanceof Uint8Array)) {
      throw new TypeError(`runtime files: read ${path} expected Uint8Array, got ${typeof out}`)
    }
    return out
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const out = await this.dispatch('write', path, bytes)
    if (out !== undefined) {
      throw new TypeError(`runtime files: write ${path} expected void, got ${typeof out}`)
    }
    this.core?.restat(path)
  }

  /**
   * One path's metadata, projected for a guest encoder.
   *
   * @param path guest-absolute virtual path.
   * @param nofollow report a trailing symlink itself rather than its
   *   target (a guest's lstat). The row is then the node table's own,
   *   so it carries the target string's length as the size, the link's
   *   mtime, and whatever a `chown -h` wrote; the dispatcher consumes
   *   the flag and gates that read exactly as it gates `readlink`.
   */
  async stat(path: string, nofollow = false): Promise<VFSStat> {
    // One file is one inode whichever spelling reached it, so a copy
    // through a link onto the file itself is told apart (samefile).
    return { ...(await this.mountRow(path, nofollow)), name: this.walked(path, !nofollow) }
  }

  private async mountRow(path: string, nofollow: boolean): Promise<VFSStat> {
    // Through the core, so what the files open there wrote and have not
    // landed counts, as write(2) is seen at once.
    if (this.core !== null) return statRow(await this.onCore((core) => core.stat(path, !nofollow)))
    const out = await this.dispatch(
      'stat',
      path,
      undefined,
      undefined,
      nofollow ? { nofollow: true } : undefined,
    )
    if (out === null || typeof out !== 'object' || typeof (out as FileStat).name !== 'string') {
      throw new TypeError(`runtime files: stat ${path} bad shape`)
    }
    return statRow(out as FileStat)
  }

  /**
   * The path's row, or null when the mount says it is not there. Only an
   * absence (`ABSENT_PATH`) answers null; anything else throws, since a
   * refusal is not an answer about the path.
   */
  async statOrNull(path: string, nofollow = false): Promise<VFSStat | null> {
    try {
      return await this.stat(path, nofollow)
    } catch (err) {
      if (classify(err) === 'ENOENT') return null
      throw err
    }
  }

  /**
   * `path`'s row as a runtime may see it, or null.
   *
   * Structure is open and content is not. A path in the view (`serves`)
   * answers with its mount's own row; any path the workspace lists
   * answers as a directory, so the root above nested mounts and the
   * directories above a link are directories here as they are in a
   * shell, while a withheld surface's files (history, the program view)
   * stay unseen. A file's own row decides that, not its listing: the
   * history mount lists its one file as empty so a traversal never
   * descends into it. 0 is the file adapter's spelling of an unknown mtime.
   */
  async viewStat(path: string): Promise<VFSStat | null> {
    const row = await this.statOrNull(path)
    if (this.serves(path)) {
      if (row !== null) return row
    } else if (row !== null && !row.isDir) {
      return null
    }
    if ((await this.listingOrNull(path)) === null) return null
    return { size: 0, isDir: true, mode: DIR_MODE }
  }

  /**
   * The directory's unclassified rows, or null when it is not one: the
   * question a guest asks of a path with no row of its own, a directory
   * a mount only implies (the root above a nested mount), so nothing
   * per entry is stat'd. Asked in the directory form, so a prefix store
   * never answers `/s3/f` with the keys of `/s3/foo.txt`.
   */
  async listingOrNull(path: string): Promise<VFSEntry[] | null> {
    try {
      return await this.readdir(normDir(path), false)
    } catch (err) {
      if (isAbsent(err)) return null
      throw err
    }
  }

  /**
   * List a directory as resolved entries (Python's `readdir` shape).
   *
   * A backend that slash-marks directories skips the stat; every other
   * entry is classified by its own stat, which is RAM when the readdir
   * filled the index and a backend request when the mount keeps none.
   * At most `LISTING_ENTRY_CONCURRENCY` requests run at once across
   * everything this adapter serves, so a large directory on an unindexed
   * mount does not put every entry's request on the wire together.
   *
   * An entry whose stat fails, for any reason, rides unclassified: a
   * size-0 non-directory with no mode and no stamp, the row that says
   * "not known". One entry never fails the listing, the way a kernel
   * readdir never stats at all. What went wrong is not lost: the
   * guest's own stat or open of that entry asks the mount again and
   * reports it. Only the listing itself failing fails the call. Any
   * failure but a missing path (a dangling link, an entry gone since the
   * listing) also warns on the host, since the row the guest sees is
   * degraded.
   *
   * A row that did stat carries its mode and stamp too, since the
   * struct is already in hand: a guest that places a directory's nodes
   * from one listing (Emscripten does) then needs no second stat per
   * file.
   * The slash-marked and unclassified rows report neither, which is
   * the honest answer for a listing that never learned them.
   *
   * The link mark comes from the name plane, since no backend listing
   * reports a link. One table read per listing, and it only ever marks
   * a name the listing itself returned, so a link the session hides
   * stays hidden: the dispatcher filtered it out of the entries above
   * and an unmatched mark marks nothing. A marked row is the link's
   * own, as a guest's lstat reads it, since the node table answers that
   * stat and no backend is asked.
   *
   * @param path guest-absolute virtual path of the directory.
   * @param classify stat each entry to learn its kind. A guest that
   *   only needs names (monty's listdir, quickjs) passes false and
   *   every row comes back unclassified, one request for the listing
   *   and none per entry, as a POSIX readdir costs.
   */
  async readdir(path: string, classify = true): Promise<VFSEntry[]> {
    const out = await this.dispatch('readdir', path)
    if (!Array.isArray(out)) {
      throw new TypeError(`runtime files: readdir ${path} expected array`)
    }
    // After the listing, not before: a directory that will not list
    // (ENOENT, or a link cycle the namespace refuses to resolve) must
    // fail as readdir, not as the mark read.
    const links = this.resolver.linkChildren(path)
    const rows = out.map((raw): VFSEntry => {
      if (typeof raw !== 'string') {
        throw new TypeError(`runtime files: readdir ${path} bad entry shape`)
      }
      // Backends that mark directories with a trailing slash skip the
      // stat; unmarked entries (e.g. RAM) need one to learn dir-ness.
      const mark = links.has(entryName(raw)) ? { isLink: true } : {}
      return { path: raw, size: 0, isDir: raw.endsWith('/'), ...mark }
    })
    if (!classify) return rows
    // A fixed set of workers, not a promise per entry, so a wide directory
    // costs the cap's worth of pending work, never its width.
    const pending = rows.flatMap((row, index) => (row.isDir ? [] : [[index, row] as const]))
    const queue = pending.values()
    const work = async (): Promise<void> => {
      for (const [index, row] of queue) rows[index] = await this.classified(path, row)
    }
    const workers = Math.min(LISTING_ENTRY_CONCURRENCY, pending.length)
    await Promise.all(Array.from({ length: workers }, work))
    return rows
  }

  private async classified(directory: string, row: VFSEntry): Promise<VFSEntry> {
    const mark = row.isLink === true ? { isLink: true } : {}
    try {
      const st = await this.stat(row.path, row.isLink === true)
      return {
        path: row.path,
        size: st.size,
        isDir: st.isDir,
        mode: st.mode,
        mtimeMs: st.mtimeMs ?? 0,
        ...(st.atimeMs !== undefined ? { atimeMs: st.atimeMs } : {}),
        ...(st.uid !== undefined ? { uid: st.uid } : {}),
        ...(st.gid !== undefined ? { gid: st.gid } : {}),
        ...(st.isLink === true ? { isLink: true } : {}),
        ...(st.rdev !== undefined ? { rdev: st.rdev } : {}),
        ...mark,
      }
    } catch (err) {
      if (!isMissingPath(err)) {
        console.warn(`runtime files: readdir ${directory}: stat ${row.path}: ${String(err)}`)
      }
      return row
    }
  }

  /** Set `path`'s length: a shrink drops bytes, growth reads zeros. */
  async truncate(path: string, length = 0): Promise<void> {
    if (length < 0) throw einval(path)
    if (this.core === null) await this.dispatch('truncate', path, undefined, undefined, { length })
    else await this.onCore((core) => core.truncate(path, length))
  }

  /**
   * Remove the entry at `path`; a file open on it keeps what it held, as
   * POSIX keeps an open file on its inode.
   */
  async unlink(path: string): Promise<void> {
    if (this.core === null) await this.dispatch('unlink', path)
    else await this.onCore((core) => core.unlink(path))
  }

  /**
   * Create a directory; `parents` asks the mount to create missing
   * ancestors too (pathlib's mkdir(parents=True), which the backend op
   * takes as a flag on both hosts).
   */
  async mkdir(path: string, parents = false): Promise<void> {
    await this.dispatch(
      'mkdir',
      path,
      undefined,
      undefined,
      parents ? { parents: true } : undefined,
    )
  }

  async rmdir(path: string): Promise<void> {
    await this.dispatch('rmdir', path)
  }

  /**
   * Rename within one mount.
   *
   * Args:
   *   src: guest-absolute source path.
   *   dst: guest-absolute destination path.
   *
   * Throws:
   *   CrossMountError: the two ends resolve to different mounts.
   */
  async rename(src: string, dst: string): Promise<void> {
    if (this.mountOf(src) !== this.mountOf(dst)) throw new CrossMountError(src, dst)
    if (this.core === null) await this.dispatch('rename', src, undefined, dst)
    else await this.onCore((core) => core.rename(src, dst))
  }

  /**
   * Create a namespace symlink at `path` pointing at `target`.
   *
   * A link is namespace state, so no backend stores one and the target
   * is kept verbatim as the guest typed it. The dispatcher answers this
   * op from the node table itself, which is why a runtime can serve
   * `os.symlink` at all: the dispatcher a surface already holds reaches the
   * name plane, not just a mount.
   *
   * Args:
   *   path: guest-absolute path of the link to create.
   *   target: link target, stored as typed.
   */
  async symlink(path: string, target: string): Promise<void> {
    await this.dispatch('symlink', path, undefined, target)
  }

  /**
   * The target of the symlink at `path`.
   *
   * Throws EINVAL when `path` is not a link, which is what the node
   * table answers and what POSIX readlink says.
   */
  async readlink(path: string): Promise<string> {
    const out = await this.dispatch('readlink', path)
    if (typeof out !== 'string') {
      throw new TypeError(`runtime files: readlink ${path} expected string, got ${typeof out}`)
    }
    return out
  }

  /**
   * Write metadata fields, natively where the backend can hold them.
   *
   * The dispatcher reads the whole set and stores in the namespace overlay
   * whatever the backend cannot keep, so a mount with no setattr op
   * still answers: a utime on an s3 or dropbox mount lands in the name
   * plane and stat reports it back. Stored, not enforced; the mount
   * mode is the access control.
   *
   * Args:
   *   path: guest-absolute virtual path.
   *   attrs: the fields to write, unset ones omitted.
   */
  async setattr(path: string, attrs: SetAttrFields): Promise<void> {
    // A file still open there lands its writes first, or they would stamp
    // over the times.
    if (attrs.atime !== undefined || attrs.mtime !== undefined) {
      if (this.core !== null) await this.onCore((core) => core.land(path, attrs.nofollow !== true))
    }
    await this.dispatch('setattr', path, undefined, undefined, attrs)
    // The files open there stat it afresh: the change went past the core.
    this.core?.restat(path, attrs.nofollow !== true)
  }

  /**
   * Extend `path` by `tail`, falling back to a whole-file write.
   *
   * `append` is optional per backend (S3 registers `write` and
   * `rename` without it), so a mount that declines is remembered: the
   * fallback then costs one failed dispatch per mount rather than one
   * per call.
   *
   * The fallback reads the base fresh every time, never a copy from an
   * earlier append: an append lands after whatever the file holds now,
   * so a write another action made between two appends is kept, as
   * O_APPEND keeps it. It reads the stored bytes, not a rendering, since
   * it writes them back. Only a confirmed absence starts from an empty
   * base, since an append may create the file; every other read failure
   * propagates, because writing the tail alone over a file that exists
   * but is momentarily unreadable would replace content this run never
   * saw.
   *
   * Args:
   *   path: guest-absolute virtual path.
   *   tail: only the newly appended bytes.
   */
  async append(path: string, tail: Uint8Array): Promise<void> {
    if (await this.appendDelta(path, tail)) {
      this.core?.restat(path)
      return
    }
    let base: Uint8Array = new Uint8Array()
    try {
      base = await this.read(path, { raw: true, direct: true })
    } catch (err) {
      if (!isMissingPath(err)) throw err
    }
    await this.write(path, concat([base, tail]))
  }

  private async appendDelta(path: string, tail: Uint8Array): Promise<boolean> {
    const mount = this.mountOf(path) ?? path
    if (this.noAppend.has(mount)) return false
    try {
      await this.dispatch('append', path, tail)
    } catch (err) {
      if (!isMissingOp(err, 'append')) throw err
      this.noAppend.add(mount)
      return false
    }
    return true
  }
}
