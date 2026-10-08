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
import { isMissingOp, isMissingPath } from '../errors/fs.ts'
import {
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
import type { FlushStep } from './handles/index.ts'
import { PrefixResolver, type MountResolver } from './resolver.ts'
import type { BridgeDispatchFn } from './types.ts'
import type { RuntimeContext } from './binding.ts'
import type { FileStat, SetAttrFields } from '../types.ts'
import { concat } from '../io/cachable_iterator.ts'
import type { VFSEntry, VFSStat } from './types.ts'

/** Whether a failure is the mount saying the path is not there. */
function isAbsent(err: unknown): boolean {
  const condition = classify(err)
  return condition !== null && ABSENT_PATH.has(condition)
}

/**
 * Whether a listing row is one the door did not classify.
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
 * The projection lives at the door rather than in each surface so both
 * languages build one struct in one tier: preview1 reads the type bits
 * out of `mode` and drops the rest, monty fills a `StatResult`,
 * Emscripten fills an `FSAttr`. Mirrors python's `RuntimeVFS._row`.
 */
function statRow(st: FileStat): VFSStat {
  const ms = mtimeMs(st)
  return {
    size: contentSize(st),
    isDir: isDir(st),
    // A guest wire has no validity channel for a timestamp, so an
    // unknown mtime and epoch zero both encode as 0 from here on.
    mtimeMs: ms ?? 0,
    mode: posixMode(st),
    ...(isLink(st) ? { isLink: true } : {}),
    ...(isCharDevice(st) ? { rdev: deviceRdev(st) } : {}),
  }
}

/**
 * An entry's final path segment.
 *
 * What a link mark is compared on, because backends disagree on entry
 * shape (bare names, trailing-slash names, full paths) and the name is
 * the part they agree on. The same normalization `mergeReaddir`
 * dedupes on.
 */
function baseName(entry: string): string {
  const trimmed = rstripSlash(entry)
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
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
 * Args:
 *   dispatch: the workspace op dispatch this runtime was attached to.
 *   resolver: the workspace mount routing table; the default answers
 *     no mounts, so routing questions answer null.
 */
export class RuntimeVFS {
  private readonly dispatch: BridgeDispatchFn
  private readonly resolver: MountResolver
  private readonly noAppend = new Set<string>()

  constructor(dispatch: BridgeDispatchFn, resolver: MountResolver = new PrefixResolver(() => [])) {
    // One cap on every request this door sends, held for that request
    // alone, so the stats of listings that run together (a preload
    // walking a tree) share it with the walk's own reads.
    const limiter = new ConcurrencyLimiter(LISTING_ENTRY_CONCURRENCY)
    this.dispatch = async (...args) => {
      const release = await limiter.acquire()
      try {
        return await dispatch(...args)
      } finally {
        release()
      }
    }
    this.resolver = resolver
  }

  /** The file door every engine builds from its execution context. */
  static of(context: RuntimeContext): RuntimeVFS {
    return new RuntimeVFS(context.dispatch, context.resolver)
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
   * written back must start from. Mirrors Python's `RuntimeVFS.read`.
   */
  async read(
    path: string,
    options: { offset?: number; size?: number; raw?: boolean } = {},
  ): Promise<Uint8Array> {
    const out = await this.dispatch('read', path, undefined, undefined, options)
    if (!(out instanceof Uint8Array)) {
      throw new TypeError(`runtime vfs: read ${path} expected Uint8Array, got ${typeof out}`)
    }
    return out
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const out = await this.dispatch('write', path, bytes)
    if (out !== undefined) {
      throw new TypeError(`runtime vfs: write ${path} expected void, got ${typeof out}`)
    }
  }

  /**
   * Write bytes at an offset, leaving the rest of the file as it is; past
   * the end, the gap reads as zeros.
   */
  async pwrite(path: string, offset: number, bytes: Uint8Array): Promise<void> {
    await this.dispatch('pwrite', path, bytes, undefined, { offset })
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
    const out = await this.dispatch(
      'stat',
      path,
      undefined,
      undefined,
      nofollow ? { nofollow: true } : undefined,
    )
    if (out === null || typeof out !== 'object' || typeof (out as FileStat).name !== 'string') {
      throw new TypeError(`runtime vfs: stat ${path} bad shape`)
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
      if (isAbsent(err)) return null
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
   * descends into it. 0 is the door's spelling of an unknown mtime.
   */
  async viewStat(path: string): Promise<VFSStat | null> {
    const row = await this.statOrNull(path)
    if (this.serves(path)) {
      if (row !== null) return row
    } else if (row !== null && !row.isDir) {
      return null
    }
    if ((await this.listingOrNull(path)) === null) return null
    return { size: 0, isDir: true, mode: DIR_MODE, mtimeMs: 0 }
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
   * everything this door serves, so a large directory on an unindexed
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
   * struct is already in hand: a guest that seeds a whole tree from
   * one listing (Emscripten does) then needs no second stat per file.
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
      throw new TypeError(`runtime vfs: readdir ${path} expected array`)
    }
    // After the listing, not before: a directory that will not list
    // (ENOENT, or a link cycle the namespace refuses to resolve) must
    // fail as readdir, not as the mark read.
    const links = this.resolver.linkChildren(path)
    const rows = out.map((raw): VFSEntry => {
      if (typeof raw !== 'string') {
        throw new TypeError(`runtime vfs: readdir ${path} bad entry shape`)
      }
      // Backends that mark directories with a trailing slash skip the
      // stat; unmarked entries (e.g. RAM) need one to learn dir-ness.
      const mark = links.has(baseName(raw)) ? { isLink: true } : {}
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
      return { path: row.path, ...(await this.stat(row.path, row.isLink === true)), ...mark }
    } catch (err) {
      if (!isMissingPath(err)) {
        console.warn(`runtime vfs: readdir ${directory}: stat ${row.path}: ${String(err)}`)
      }
      return row
    }
  }

  /**
   * Establish an empty file at `path` through the mount, so write
   * modes and a missing parent answer at open time and the ledger
   * records the op a create is.
   */
  async create(path: string): Promise<void> {
    await this.dispatch('create', path)
  }

  /** Set `path`'s length: a shrink drops bytes, growth reads zeros. */
  async truncate(path: string, length = 0): Promise<void> {
    await this.dispatch('truncate', path, undefined, undefined, { length })
  }

  async unlink(path: string): Promise<void> {
    await this.dispatch('unlink', path)
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
    await this.dispatch('rename', src, undefined, dst)
  }

  /**
   * Create a namespace symlink at `path` pointing at `target`.
   *
   * A link is namespace state, so no backend stores one and the target
   * is kept verbatim as the guest typed it. The dispatcher answers this
   * op from the node table itself, which is why a runtime can serve
   * `os.symlink` at all: the door a surface already holds reaches the
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
      throw new TypeError(`runtime vfs: readlink ${path} expected string, got ${typeof out}`)
    }
    return out
  }

  /**
   * Write metadata fields, natively where the backend can hold them.
   *
   * The door reads the whole set and stores in the namespace overlay
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
    await this.dispatch('setattr', path, undefined, undefined, attrs)
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
    if (await this.appendDelta(path, tail)) return
    let base: Uint8Array = new Uint8Array()
    try {
      base = await this.read(path, { raw: true })
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

  /**
   * Send a closing handle's buffer as a delta when it can be one.
   *
   * Args:
   *   path: guest-absolute virtual path.
   *   baseLen: length the file had when the handle opened.
   *   lowWrite: lowest offset this handle wrote at.
   *   buf: the handle's whole buffer.
   */
  /** Send what a closing handle owes the mount, in order (its `flushPlan()`). */
  async flush(path: string, steps: readonly FlushStep[]): Promise<void> {
    for (const step of steps) {
      const data = step.data ?? new Uint8Array()
      if (step.kind === 'write') await this.write(path, data)
      else if (step.kind === 'append') await this.append(path, data)
      else if (step.kind === 'pwrite') await this.pwrite(path, step.offset ?? 0, data)
      else await this.truncate(path, step.length ?? 0)
    }
  }
}
