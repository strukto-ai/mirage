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

import { posix } from 'node:path'

import type { Ops } from '@struktoai/mirage-core/ops/ops'
import { MountCore } from '../mount/core.ts'
import { EISDIR, ENOENT, classifyErrno, errnoError } from '../mount/errors.ts'
import type { MountAttrs, SetAttrs } from '../mount/types.ts'

import { NFSConfig } from './config.ts'
import { StaleHandleError } from './errors.ts'
import { IdTable, ROOT_PATH } from './ids.ts'
import type { DirEntry, NFSAttrs } from './types.ts'
import { WriteBuffer } from '../mount/writebuf.ts'

// The core treats an unknown handle as "no handle", which is what a
// handle-free protocol wants: read and write apply straight through.
const NO_HANDLE = -1
// S_IFMT masks the type out of a mode; the core answers in POSIX modes
// and NFSv3 wants the type as two booleans.
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

function isDirMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFDIR
}

function isLinkMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFLNK
}

/**
 * Refuse a name that is not a single path component.
 *
 * `filename3` is one component by definition, and nfsserve does not
 * filter it, so the delegate is the only guard there is. A `/` here is
 * a protocol violation; that it does not escape the mount today is luck
 * -- nothing below this point normalizes `..` -- rather than a check.
 * `.` and `..` are refused for the mutating ops because neither names
 * an entry to create or remove; `lookup` resolves them before calling
 * this.
 */
function component(name: string): string {
  if (name === '' || name === '.' || name === '..' || name.includes('/')) {
    throw errnoError('EINVAL', `not a single path component: ${name}`)
  }
  return name
}

function joinPath(parent: string, name: string): string {
  return parent === ROOT_PATH ? ROOT_PATH + name : posix.join(parent, name)
}

/**
 * The NFSv3 filesystem the server crate calls back into.
 *
 * One method per trait callback, each one async so it runs on the
 * event loop and reaches the op door the same way a shell command
 * does: mount grants, admission policies, cache and namespace all
 * fire once, at that door. The adapter itself owns only what the
 * protocol needs and mirage does not have -- which file id names
 * which path, and the writes a client has sent but not yet had
 * stored.
 *
 * Paths crossing this boundary are mount-relative; the mount prefix
 * is applied by the op facade this is constructed with.
 */
export class MirageNFS {
  private readonly ops: Ops
  private readonly config: NFSConfig
  /**
   * The shared mount core. Every filesystem semantic the two kernel
   * tiers agree on -- link display, macOS metadata, entry naming, stat
   * shaping, the size-unknown rules -- is decided there and nowhere
   * here, so the adapters cannot drift. What stays this adapter's own
   * is what NFSv3 alone needs: the id table, the write buffer, and the
   * wire attribute shape.
   */
  private readonly core: MountCore
  private readonly ids = new IdTable()
  private readonly writes = new WriteBuffer()
  // One chain per file that has been written, cleared with the buffer it
  // guards, so the map tracks live files rather than every id minted.
  private readonly flushChains = new Map<number, Promise<void>>()
  private readonly root: number

  constructor(ops: Ops, config: NFSConfig = new NFSConfig()) {
    this.core = new MountCore(ops)
    this.ops = ops
    this.config = config
    this.root = this.ids.alloc(ROOT_PATH)
  }

  /** The file id of the export root. */
  rootDir(): number {
    return this.root
  }

  /** Resolve a name inside a directory to a file id. */
  async lookup(dirid: number, name: string): Promise<number> {
    const parent = this.ids.resolve(dirid)
    // '.' and '..' are the server's job over NFSv3: the kernel resolves
    // them above the filesystem for FUSE, which is why MountCore never
    // had to, and answering ENOENT for them here is a cold-cache hole
    // rather than a curiosity.
    if (name === '.') return dirid
    if (name === '..') {
      if (parent === ROOT_PATH) return dirid
      return this.ids.alloc(parent.slice(0, parent.lastIndexOf('/')) || ROOT_PATH)
    }
    const path = joinPath(parent, component(name))
    // getattr refuses macOS metadata names and reports a link as a link
    // rather than following it, both of which this used to repeat.
    await this.core.getattr(path)
    return this.ids.alloc(path)
  }

  /** Attributes for a file id, counting writes not yet stored. */
  async getattr(fileid: number): Promise<NFSAttrs> {
    return this.entryAttrs(fileid, this.ids.resolve(fileid))
  }

  /** Read through any writes still buffered for this file. */
  async read(fileid: number, offset: number, count: number): Promise<Buffer> {
    const path = this.ids.resolve(fileid)
    const base = await this.readBase(path)
    return this.writes.overlay(fileid, base, offset, count)
  }

  /**
   * Buffer a write and answer with the size the client expects.
   *
   * The bytes are stored on flush, not here: this server answers
   * every write as durable and never forwards a COMMIT, so the
   * adapter batches and bounds the window itself.
   */
  async write(fileid: number, offset: number, data: Buffer): Promise<NFSAttrs> {
    const path = this.ids.resolve(fileid)
    const full = this.writes.append(fileid, offset, data, this.config.maxBufferedBytes)
    if (full) await this.flushOne(fileid, path)
    await this.drainToCeiling()
    return this.entryAttrs(fileid, path)
  }

  /**
   * Flush the biggest buffers until the total is under the cap.
   *
   * `maxBufferedBytes` bounds one handle, so N files written at once
   * cost N times it and nothing bounded the sum: a `cp -r` of many
   * large files grew the process without limit, and the idle sweep only
   * ran on its timer. Biggest first, so the fewest stores get back
   * under.
   */
  /** Bytes buffered across every file; the ceiling's own measure. */
  bufferedBytes(): number {
    return this.writes.totalBytes()
  }

  private async drainToCeiling(): Promise<void> {
    const ceiling = this.config.maxTotalBufferedBytes
    if (this.writes.totalBytes() <= ceiling) return
    for (const fileid of this.writes.heaviestIds()) {
      if (this.writes.totalBytes() <= ceiling) return
      await this.flushOrDrop(fileid)
    }
  }

  /** Create an empty file and return its id. */
  async create(dirid: number, name: string): Promise<number> {
    const path = joinPath(this.ids.resolve(dirid), component(name))
    const fd = await this.core.create(path)
    // NFSv3 is handle-free; the core's handle would leak otherwise.
    await this.core.release(fd)
    return this.ids.alloc(path)
  }

  /**
   * Create a file, refusing a path that already holds one.
   *
   * NFSv3's EXCLUSIVE create is what `O_CREAT|O_EXCL` becomes on the
   * wire, so it is every lockfile idiom there is -- pip, a git
   * index.lock, any flock-style sentinel. Routed to the plain create,
   * whose core truncates, "refuse to touch it" became "empty it", and
   * the caller was told it had won the race.
   *
   * Mirage has no create-verifier to store and replay, so this
   * implements the half of the semantics that carries the data loss:
   * an existing path is refused, never opened.
   */
  async createExclusive(dirid: number, name: string): Promise<number> {
    const path = joinPath(this.ids.resolve(dirid), component(name))
    let taken = true
    try {
      await this.core.attrsFor(path)
    } catch (err) {
      if (classifyErrno(err) !== ENOENT) throw err
      taken = false
    }
    if (taken) throw errnoError('EEXIST', `File exists: ${path}`)
    return this.create(dirid, name)
  }

  /** Create a directory and return its id. */
  async mkdir(dirid: number, name: string): Promise<number> {
    const path = joinPath(this.ids.resolve(dirid), component(name))
    await this.core.mkdir(path)
    return this.ids.alloc(path)
  }

  /**
   * Remove a file or directory.
   *
   * The server routes both REMOVE and RMDIR here, so the entry is
   * stat-ed first to pick the right op. A link is unlinked whatever
   * it points at: stat would follow it, and following a link to a
   * directory would rmdir the target instead of the link. Buffered
   * writes are dropped rather than flushed -- storing them would
   * bring the file back.
   */
  async remove(dirid: number, name: string): Promise<void> {
    const path = joinPath(this.ids.resolve(dirid), component(name))
    const fileid = this.ids.idFor(path)
    if (fileid === undefined) {
      await this.removeEntry(path)
      return
    }
    // Chained behind any in-flight flush, and dropping only afterwards.
    // Dropping first lost acknowledged writes whenever the removal then
    // failed (a denied unlink, ENOTEMPTY on the rmdir arm): the file
    // survived, with its pre-write bytes. Doing it off the chain
    // instead lets an idle flush land between the unlink and the drop
    // and recreate what was just removed.
    const previous = this.flushChains.get(fileid) ?? Promise.resolve()
    const mine = previous
      .catch(() => undefined)
      .then(async () => {
        await this.removeEntry(path)
        this.writes.drop(fileid)
        this.ids.invalidate(fileid)
      })
    this.flushChains.set(fileid, mine)
    try {
      await mine
    } finally {
      if (this.flushChains.get(fileid) === mine) this.flushChains.delete(fileid)
    }
  }

  /**
   * Remove one entry, picking the op from what it is.
   *
   * The core's unlink unlinks a link rather than following it, so the
   * branch here is only file-or-directory. attrsFor, not getattr: the
   * id was minted by a lookup that already applied the name policy,
   * and re-applying it here would refuse to remove an entry the client
   * was allowed to create (python's twin has always used attrsFor).
   */
  private async removeEntry(path: string): Promise<void> {
    const attrs = await this.core.attrsFor(path)
    if (isDirMode(attrs.mode)) {
      await this.core.rmdir(path)
    } else {
      await this.core.unlink(path)
    }
  }

  /**
   * Move an entry, carrying its id and pending writes with it.
   *
   * Pending writes are flushed to the old path first: they were
   * acknowledged against it, and flushing after the move would merge
   * them onto whatever now lives at the destination.
   */
  async rename(
    fromDirid: number,
    fromName: string,
    toDirid: number,
    toName: string,
  ): Promise<void> {
    const src = joinPath(this.ids.resolve(fromDirid), component(fromName))
    const dst = joinPath(this.ids.resolve(toDirid), component(toName))
    this.ids.guardRename(src, dst)
    const fileid = this.ids.idFor(src)
    if (fileid !== undefined && this.writes.hasPending(fileid)) {
      await this.flushOne(fileid, src)
    }
    await this.core.rename(src, dst)
    this.ids.rename(src, dst)
  }

  /**
   * Apply the one settable attribute: size.
   *
   * mode, uid, gid and the timestamps are accepted and discarded,
   * exactly as the FUSE adapter does -- a mirage backend has nowhere
   * to persist them, and refusing would fail ordinary tools.
   */
  async setattr(fileid: number, attrs: SetAttrs): Promise<NFSAttrs> {
    const path = this.ids.resolve(fileid)
    const size = attrs.size
    if (size !== null) {
      // Truncate first, clip on success, both chained behind any
      // in-flight flush. Clipping first discarded the pending writes
      // past `size` before knowing the truncate would land, so a denied
      // or transient failure lost bytes the client had been told were
      // durable while the file kept its old length -- the same shape as
      // the drop-before-remove bug. The chain is what stops a flush
      // landing in between and re-extending the file with the buffer
      // this is about to clip.
      const previous = this.flushChains.get(fileid) ?? Promise.resolve()
      const mine = previous
        .catch(() => undefined)
        .then(async () => {
          await this.core.truncate(path, size)
          this.writes.clip(fileid, size)
        })
      this.flushChains.set(fileid, mine)
      try {
        await mine
      } finally {
        if (this.flushChains.get(fileid) === mine) this.flushChains.delete(fileid)
      }
    }
    return this.entryAttrs(fileid, path)
  }

  /**
   * The wire layer's SETATTR entry point, on primitives. The Rust
   * boundary crosses on primitives, so it calls this rather than
   * building a {@link SetAttrs}.
   */
  async setSize(fileid: number, size: number | null): Promise<NFSAttrs> {
    return this.setattr(fileid, { size })
  }

  /** Create a symlink and return its id. */
  async symlink(dirid: number, name: string, target: string): Promise<number> {
    const path = joinPath(this.ids.resolve(dirid), component(name))
    await this.core.symlink(target, path)
    return this.ids.alloc(path)
  }

  /**
   * The target a symlink holds, as the client should see it.
   *
   * Relative targets are returned verbatim; absolute ones name
   * virtual paths and are rewritten relative to the link's directory,
   * since a client would otherwise resolve them against its own root
   * and escape the mount.
   */
  // A link is namespace state, so this reads no backend; the callback
  // contract is still one async method per NFS procedure.
  // eslint-disable-next-line @typescript-eslint/require-await
  async readlink(fileid: number): Promise<string> {
    const path = this.ids.resolve(fileid)
    return this.core.readlink(path)
  }

  /**
   * List a directory, resuming after the entry `cookie` names.
   *
   * The cookie is the last-seen entry's fileid: the server crate
   * derives the wire cookie from each entry's id and hands it back as
   * `startAfter`. Resume keys on identity, never on comparing
   * magnitudes -- ids are minted in access order, so a later entry
   * may carry a smaller id than an earlier one.
   */
  async readdir(dirid: number, cookie = 0, maxEntries?: number): Promise<DirEntry[]> {
    const path = this.ids.resolve(dirid)
    // The core joins each child and describes it, so this loop adds
    // only what NFSv3 has and mirage does not: the file id, and the
    // cookie a client resumes from. '.' and '..' are absent from the
    // core's per-entry listing because NFSv3 carries them in the reply
    // header rather than as entries.
    // Resume by NAME, not by scanning for the cookie's fileid. That
    // scan only ever cleared itself on an exact match, so a cookie
    // whose entry had since been removed matched nothing, every
    // remaining entry was skipped, and the empty page read to the
    // client as end-of-directory: `ls` on a directory another writer
    // was touching silently lost its tail. A name comparison needs the
    // entry to have existed, not to still exist.
    let after: string | undefined
    if (cookie !== 0) {
      const resumePath = this.ids.cookiePath(cookie)
      if (resumePath === undefined) {
        throw new StaleHandleError(`unknown readdir cookie: ${String(cookie)}`)
      }
      after = resumePath.slice(resumePath.lastIndexOf('/') + 1)
    }
    const entries: DirEntry[] = []
    for (const entry of await this.core.readdirEntries(path)) {
      if (after !== undefined && entry.name <= after) continue
      const fileid = this.ids.alloc(entry.path)
      entries.push({
        name: entry.name,
        fileid,
        cookie: fileid,
        attrs: this.wireAttrs(fileid, entry.attrs),
      })
      if (maxEntries !== undefined && entries.length >= maxEntries) break
    }
    return entries
  }

  /** Store one file's buffered writes. */
  async flush(fileid: number): Promise<void> {
    if (this.writes.hasPending(fileid)) {
      await this.flushOne(fileid, this.ids.resolve(fileid))
    }
  }

  /**
   * Store every buffered write. Used at teardown. A file id that went
   * stale under a pending buffer is dropped rather than raised: one
   * dead entry must not stop the rest from being stored.
   */
  async flushAll(): Promise<void> {
    for (const fileid of this.writes.pendingIds()) await this.flushOrDrop(fileid)
  }

  /** Store writes untouched for longer than the idle window. */
  async flushIdle(): Promise<void> {
    for (const fileid of this.writes.idleIds(this.config.idleFlushSeconds)) {
      await this.flushOrDrop(fileid)
    }
  }

  private async flushOrDrop(fileid: number): Promise<void> {
    let path: string
    try {
      path = this.ids.resolve(fileid)
    } catch (err) {
      if (!(err instanceof StaleHandleError)) throw err
      this.writes.drop(fileid)
      this.flushChains.delete(fileid)
      return
    }
    await this.flushOne(fileid, path)
  }

  /**
   * Store one file's buffered writes, one flush at a time.
   *
   * Read, take and store are one critical section. Without it two
   * flushes of the same file -- an idle timer against a size trigger,
   * or either against teardown -- each read the same stored base and
   * take different batches, and whichever store settles last drops the
   * other batch. The client was told those bytes were durable.
   *
   * Serialized by chaining rather than a lock, which JavaScript has no
   * need of: the chain is the queue, and a failed flush does not strand
   * the ones behind it.
   */
  /** Forget a file's pending writes and the chain that serialized them. */
  private dropBuffered(fileid: number): void {
    this.writes.drop(fileid)
    this.flushChains.delete(fileid)
  }

  private async flushOne(fileid: number, path: string): Promise<void> {
    const previous = this.flushChains.get(fileid) ?? Promise.resolve()
    const mine = previous.catch(() => undefined).then(() => this.storeOne(fileid, path))
    this.flushChains.set(fileid, mine)
    try {
      await mine
    } finally {
      // Only the tail clears itself: an earlier link finishing must not
      // drop a chain a later flush is still queued behind.
      if (this.flushChains.get(fileid) === mine) this.flushChains.delete(fileid)
    }
  }

  private async storeOne(fileid: number, path: string): Promise<void> {
    const base = await this.readBase(path)
    const pending = this.writes.take(fileid)
    if (pending.length === 0) return
    try {
      await this.core.store(path, WriteBuffer.merge(base, pending))
    } catch (err) {
      // Taken up front, this batch was gone the moment the store threw
      // -- and every one of its writes had been answered FILE_SYNC, so
      // the client believes they are durable and will never send them
      // again. Put them back and let the idle sweep retry; the throw
      // still reaches the caller.
      this.writes.requeue(fileid, pending)
      throw err
    }
  }

  private async readBase(path: string): Promise<Buffer> {
    try {
      return Buffer.from(await this.core.read(path, NO_HANDLE, 0, Number.MAX_SAFE_INTEGER))
    } catch (err) {
      // Only the two conditions a first write legitimately meets: the
      // file does not exist yet, or the path is a directory. A bare
      // catch read every transient backend, auth or policy failure as
      // "empty file", and the whole-object write that followed then
      // stored the pending ranges alone -- destroying content nobody
      // touched. Python's twin catches exactly this pair.
      const code = classifyErrno(err)
      if (code !== ENOENT && code !== EISDIR) throw err
      return Buffer.alloc(0)
    }
  }

  /** Attributes for one entry, seeing a link as itself. */
  /**
   * The wire attributes for one entry, over the core's POSIX ones.
   *
   * The core decides what the entry *is* -- a link reported as a link
   * rather than followed, a size-unknown file reported as 0, macOS
   * metadata refused outright -- and this converts that answer into the
   * three facts NFSv3 puts on the wire, plus the size a client should
   * see, which counts writes this adapter has buffered but not stored.
   */
  private async entryAttrs(fileid: number, path: string): Promise<NFSAttrs> {
    // attrsFor, not getattr: this id was minted by a lookup that
    // already applied the name policy, and re-applying it here would
    // disappear an entry the client created.
    return this.wireAttrs(fileid, await this.core.attrsFor(path))
  }

  /**
   * Convert one POSIX row into the facts NFSv3 puts on the wire.
   *
   * Split from {@link entryAttrs} so a listing, which already has every
   * row from the core, converts them without a second stat per name.
   * Sync, and therefore safe to call inside a listing loop.
   */
  private wireAttrs(fileid: number, attrs: MountAttrs): NFSAttrs {
    const isDir = isDirMode(attrs.mode)
    const out: NFSAttrs = {
      fileid,
      size: isDir ? 0 : this.writes.pendingSize(fileid, attrs.size),
      isDir,
      isSymlink: isLinkMode(attrs.mode),
      mode: attrs.mode & 0o7777,
    }
    // vfs.rs reads exactly this field; the core dates an entry it cannot
    // date at the epoch, and passing that through is honest where a
    // fabricated "now" would not be.
    const epoch = attrs.mtime.getTime() / 1000
    if (epoch > 0) out.mtimeEpoch = epoch
    return out
  }
}
