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

import { epochToIso } from '../../../../utils/dates.ts'
import type { SetAttrFields } from '../../../../types.ts'
import { BLKSIZE, GROW_FLOOR, LINK_MODE, O_APPEND, SEEK_CUR, SEEK_END } from './constants.ts'
import { errnoError } from './errors.ts'
import { classify } from '../../../../errors/index.ts'
import { isMissingPath } from '../../../../errors/fs.ts'
import { isUnclassified } from '../../../files.ts'
import type { VFSEntry, VFSStat } from '../../../types.ts'
import type { MirageMutation, MutationJournal } from './journal.ts'
import { NodeTable } from './nodes.ts'
import type {
  ErrnoCodes,
  FlushFailure,
  FSAttr,
  FSHost,
  FSNode,
  FSStream,
  FSType,
  NodeOps,
  SetAttr,
  StreamOps,
  SyncVFS,
} from './types.ts'

const ENC = new TextEncoder()
const S_IFMT = 0o170000
const S_IFCHR = 0o020000

// Emscripten's MEMFS makes these three at startup and its own stderr capture
// reopens /dev/stderr when a run ends (`API.restore_stderr`). Mounting mirage's
// /dev on top hid them, so that reopen raised ENOENT out of a filesystem
// callback nobody catches, and the unhandled rejection took the process down
// with it. Recreated here so the interpreter still finds them. rdev matches
// MEMFS's own numbering.
const STD_STREAM_RDEV: ReadonlyMap<string, number> = new Map([
  ['stdin', 6],
  ['stdout', 7],
  ['stderr', 8],
])

// /dev/null's device number. It and the three streams above answer a read with
// EOF; only /dev/zero hands back an endless run of zeroes, and a stream that
// did the same would hang `open('/dev/stdin').read()` forever.
const NULL_RDEV = 0x103

const EOF_ON_READ_RDEV: ReadonlySet<number> = new Set([NULL_RDEV, ...STD_STREAM_RDEV.values()])

function isCharDevice(mode: number): boolean {
  return (mode & S_IFMT) === S_IFCHR
}

/**
 * The metadata a `setattr` actually changes, or null when it changes
 * none of it.
 *
 * Emscripten hands this callback more than a guest's chmod and utime:
 * a stamp arrives beside a resize and beside a mode, and a write that
 * moved no field would still journal an op. Sending one costs a
 * dispatch and, worse, splits two writes the journal would otherwise
 * coalesce. Comparing against the node costs one read.
 *
 * The one case comparing cannot catch is a create, whose finalizing
 * chmod does lower a real mode; `PyodideFs.fresh` is what suppresses
 * that one.
 *
 * `ctime` is never included: no POSIX call sets it directly, so a mount
 * has nothing to write it to. `size` is not metadata here either, it is
 * the resize branch's bytes.
 *
 * Args:
 *   node: the node as it stands before the write.
 *   attr: the fields Emscripten passed, times as epoch ms.
 */
export function changedAttrs(node: FSNode, attr: SetAttr): SetAttrFields | null {
  const fields: SetAttrFields = {}
  if (attr.mode !== undefined && (attr.mode & 0o7777) !== (node.mode & 0o7777)) {
    fields.mode = attr.mode & 0o7777
  }
  if (attr.atime !== undefined && attr.atime !== node.atime) {
    fields.atime = epochToIso(attr.atime / 1000)
  }
  if (attr.mtime !== undefined && attr.mtime !== node.mtime) {
    fields.mtime = epochToIso(attr.mtime / 1000)
  }
  return Object.keys(fields).length === 0 ? null : fields
}

/**
 * An Emscripten filesystem backed by a mirage mount.
 *
 * This is the pyodide runtime's interception layer. Mounting it at a mount
 * prefix puts mirage below the guest's syscall boundary, where every
 * spelling of an operation (`open`, `os.open`, `pathlib`, `shutil`'s
 * fd-relative walk) arrives as the same callback. Nothing is patched
 * inside the interpreter.
 *
 * Callbacks are synchronous: uncached lookups and reads wait for the host
 * through SyncVFS, which needs the worker. Writes enter the journal and
 * flush before a lazy backend read or after the run, preserving guest
 * order.
 *
 * The node table lives in `NodeTable` and the flush decision in
 * `planFlush`; what is left here is one method per Emscripten callback,
 * plus the errno translation only this layer performs.
 */
/**
 * A name a repeat listing found, classified by its own stat as the
 * first listing's file adapter classifies it, or left as the listing's row
 * when that stat fails, the way the file adapter degrades one.
 */
function ownRow(sync: SyncVFS, path: string, entry: VFSEntry): VFSEntry | VFSStat {
  if (entry.isDir) return entry
  try {
    return sync.stat(path)
  } catch (error) {
    if (!isMissingPath(error)) console.warn(`mirage: cannot stat ${path}: ${String(error)}`)
    return entry
  }
}

export class PyodideFs {
  readonly type: FSType
  private readonly host: FSHost
  private readonly errno: ErrnoCodes
  private readonly journal: MutationJournal
  private readonly nodes: NodeTable
  private readonly mountOf: (path: string) => string | null
  // The file node FS.open just created, whose finalizing chmod is the
  // filesystem's own and not a guest metadata write. Cleared by the
  // first setattr, so it can never outlive the create it belongs to.
  private fresh: FSNode | null = null

  /**
   * Args:
   *   host: the Emscripten FS namespace (`pyodide.FS`).
   *   errno: Emscripten's errno table (`pyodide.ERRNO_CODES`).
   *   journal: the write-ahead log guest mutations are recorded on.
   *   prefix: the mount prefix this filesystem serves.
   *   mountOf: the mirage mount owning a path (`RuntimeFiles.mountOf`).
   *     One mountpoint serves every mirage mount nested under its
   *     prefix, so this is the only boundary fact left to check ops
   *     against; Emscripten's own cross-mount checks cannot see it.
   *   sync: the worker's blocking way to the mounts.
   *   deferred: the refusals the mount gave a path whose call has not
   *     come yet, shared by every mountpoint as the journal is.
   */
  constructor(
    host: FSHost,
    errno: ErrnoCodes,
    journal: MutationJournal,
    prefix: string,
    mountOf: (path: string) => string | null,
    private readonly sync: SyncVFS,
    private readonly deferred = new Map<string, FlushFailure>(),
  ) {
    this.host = host
    this.errno = errno
    this.journal = journal
    this.mountOf = mountOf
    const nodeOps: NodeOps = {
      getattr: this.getattr.bind(this),
      setattr: this.setattr.bind(this),
      lookup: this.lookup.bind(this),
      mknod: this.mknod.bind(this),
      rename: this.rename.bind(this),
      unlink: this.unlink.bind(this),
      rmdir: this.rmdir.bind(this),
      readdir: this.readdir.bind(this),
      symlink: this.symlink.bind(this),
      readlink: this.readlink.bind(this),
    }
    const streamOps: StreamOps = {
      open: this.streamOpen.bind(this),
      close: (stream) => {
        this.settle(this.nodes.pathOf(stream.node))
      },
      read: this.streamRead.bind(this),
      write: this.streamWrite.bind(this),
      llseek: this.llseek.bind(this),
    }
    this.nodes = new NodeTable(host, prefix, nodeOps, streamOps)
    this.type = { mount: this.nodes.mount.bind(this.nodes) }
  }

  private getattr(node: FSNode): FSAttr {
    if (node.unclassified === true) this.classifyNode(node)
    // A link sizes as its target string, which is what lstat reports on
    // every POSIX system and what MEMFS answers for its own links.
    const size = this.host.isLink(node.mode)
      ? ENC.encode(node.link ?? '').length
      : this.host.isDir(node.mode)
        ? BLKSIZE
        : (node.usedBytes ?? 0)
    return {
      dev: 1,
      ino: node.id,
      mode: node.mode,
      nlink: this.host.isDir(node.mode) ? 2 : 1,
      uid: 0,
      gid: 0,
      rdev: node.rdev,
      size,
      atime: new Date(node.atime),
      mtime: new Date(node.mtime),
      ctime: new Date(node.ctime),
      blksize: BLKSIZE,
      blocks: Math.ceil(size / BLKSIZE),
    }
  }

  private setattr(node: FSNode, attr: SetAttr): void {
    // Read the changes before applying them, and only outside a create:
    // the same callback carries a guest's chmod and the chmod Emscripten
    // itself performs to finalize a new file, and the two are the same
    // shape. `fresh` is what tells them apart; the comparison then drops
    // a stamp write that changes nothing.
    const finalizing = this.fresh === node
    this.fresh = null
    // Read before the mode below is applied. A character device is not mount
    // content, so none of its metadata is a guest write: Emscripten chmods one
    // right after creating it, and journaling that queued a setattr against
    // the real mount for a node the mount does not have.
    const isDevice = isCharDevice(node.mode)
    const fields = finalizing || isDevice ? null : changedAttrs(node, attr)
    const size = isDevice ? undefined : attr.size
    if (size !== undefined && size > 0) this.loadContents(node)
    if (fields !== null) {
      // A link's own attrs go to the link, since the tree resolved to
      // the link node itself and the target's row is not what changed.
      if (this.host.isLink(node.mode)) fields.nofollow = true
      this.journal.markSetattr(this.nodes.pathOf(node), fields)
    }
    // A resize goes as a truncate to the new length. Recording here rather
    // than at close is what makes a bare `os.truncate(path, n)`, which
    // opens no handle at all, reach the mount.
    if (size !== undefined) this.journal.markTruncate(this.nodes.pathOf(node), size)
    this.settle(this.nodes.pathOf(node))
    if (attr.mode !== undefined) node.mode = attr.mode
    if (attr.atime !== undefined) node.atime = attr.atime
    if (attr.mtime !== undefined) node.mtime = attr.mtime
    if (attr.ctime !== undefined) node.ctime = attr.ctime
    if (size === undefined) return
    const old = node.contents ?? new Uint8Array(0)
    const next = new Uint8Array(size)
    next.set(old.subarray(0, Math.min(old.length, size)))
    node.contents = next
    node.usedBytes = size
    node.loaded = true
  }

  private lookup(parent: FSNode, name: string): FSNode {
    const sync = this.sync
    let found = this.nodes.childOf(parent, name)
    if (found === undefined) {
      const path = this.nodes.pathOf(parent) + '/' + name
      found = this.readThrough([path], () => {
        let stat: VFSStat
        try {
          stat = sync.stat(path)
        } catch (error) {
          const rdev = STD_STREAM_RDEV.get(name)
          if (
            this.nodes.pathOf(parent) === '/dev' &&
            rdev !== undefined &&
            classify(error) === 'ENOENT'
          ) {
            return this.nodes.makeNode(parent, name, S_IFCHR | 0o666, rdev)
          }
          throw error
        }
        return this.placeEntry(parent, name, stat)
      })
    }
    return found
  }

  private mknod(parent: FSNode, name: string, mode: number, rdev: number): FSNode {
    // A character device is not mount content. pyodide makes one of its own
    // at runtime -- `API.capture_stderr` calls FS.createDevice, which lands
    // here as mknod -- and journaling it queued a write of /dev/capture_stderr
    // against the real mount, which then failed on replay. Devices live in
    // this tree only.
    if (isCharDevice(mode)) {
      const device = this.nodes.makeNode(parent, name, mode)
      device.rdev = rdev
      return device
    }
    const path = this.nodes.pathOf(parent) + '/' + name
    if (this.host.isDir(mode)) this.journal.markMkdir(path)
    // The create is what carries a file that is made and never written
    // (`Path.touch()`, `open(p,'w').close()`) through to the mount.
    else this.journal.markCreate(path)
    this.settle(path)
    const node = this.nodes.makeNode(parent, name, mode)
    node.rdev = rdev
    // FS.open finalizes a new file with a chmod of its own, right here
    // and on this node. Only a file is marked: a directory gets no such
    // call, so a marker left on one would swallow the guest's next chmod
    // instead.
    if (!this.host.isDir(mode)) this.fresh = node
    return node
  }

  private rename(node: FSNode, newDir: FSNode, newName: string): void {
    const from = this.nodes.pathOf(node)
    const to = this.nodes.pathOf(newDir) + '/' + newName
    // A nested mirage mount is served through this same mountpoint, so
    // Emscripten's kernel cannot see the boundary; refuse the crossing
    // here, before the tree moves and the journal records a rename the
    // post-run replay would reject anyway.
    if (this.mountOf(from) !== this.mountOf(to)) {
      throw errnoError(this.host, this.errno, 'EXDEV')
    }
    this.journal.markRename(from, to)
    this.settle(from, to)
    this.nodes.move(node, newDir, newName)
  }

  private unlink(parent: FSNode, name: string): void {
    const path = this.nodes.pathOf(parent) + '/' + name
    this.journal.markUnlink(path)
    this.settle(path)
    this.nodes.detach(parent, name)
  }

  private rmdir(parent: FSNode, name: string): void {
    if (this.readdir(this.lookup(parent, name)).length > 2) {
      throw errnoError(this.host, this.errno, 'ENOTEMPTY')
    }
    const path = this.nodes.pathOf(parent) + '/' + name
    this.journal.markRmdir(path)
    this.settle(path)
    this.nodes.detach(parent, name)
  }

  /**
   * The directory's names, asking the mount for any it has gained.
   *
   * The first listing is classified, since Emscripten's getdents reads
   * every name's kind off its node. A node is never re-asked about once
   * placed, so a later listing asks for names alone and stats only the
   * names the tree lacks, rather than classifying every entry again.
   */
  private readdir(node: FSNode): string[] {
    const sync = this.sync
    this.readThrough([], () => {
      const dir = this.nodes.pathOf(node) + '/'
      const again = node.listed === true
      for (const entry of sync.readdir(dir, !again)) {
        const name = entry.path.replace(/\/$/, '').split('/').pop() ?? ''
        if (this.nodes.childOf(node, name) !== undefined) continue
        this.placeEntry(node, name, again ? ownRow(sync, dir + name, entry) : entry)
      }
      node.listed = true
    })
    return ['.', '..', ...this.nodes.childNames(node)]
  }

  invalidate(): void {
    this.nodes.invalidate()
  }

  /**
   * Send the journal to the mount now, in guest order. An entry the mount
   * refuses fails the call that touched its path with the mount's errno,
   * this call or that file's next one (its close), as a deferred write
   * error does; until then nothing more for that path reaches the mount,
   * and every other file's entries still land. Without a worker there is
   * no mount to send to yet, and the journal waits for the run's end.
   *
   * Args:
   *   paths: the paths this call touched.
   */
  private settle(...paths: string[]): void {
    const sync = this.sync
    const sendable = (m: MirageMutation): boolean =>
      !this.deferred.has(m.path) && !(m.kind === 'rename' && this.deferred.has(m.dst))
    let pending = this.journal.takeMutations().filter(sendable)
    try {
      while (pending.length > 0) {
        const failure = sync.flush(pending)
        if (failure === undefined) break
        const rest = pending.length - failure.skipped
        const failed = pending[rest - 1]
        if (failed === undefined) break
        this.deferred.set(failed.path, failure)
        pending = pending.slice(rest).filter(sendable)
      }
    } catch (error) {
      throw errnoError(this.host, this.errno, classify(error) ?? 'EIO')
    }
    for (const path of paths) {
      const failure = this.deferred.get(path)
      if (failure === undefined) continue
      this.deferred.delete(path)
      throw errnoError(this.host, this.errno, failure.code ?? 'EIO')
    }
  }

  private readThrough<T>(paths: readonly string[], read: () => T): T {
    this.settle(...paths)
    try {
      return read()
    } catch (error) {
      throw errnoError(this.host, this.errno, classify(error) ?? 'EIO')
    }
  }

  private placeEntry(parent: FSNode, name: string, stat: VFSStat | VFSEntry): FSNode {
    const target = stat.isLink
      ? this.sync.readlink(this.nodes.pathOf(parent) + '/' + name)
      : undefined
    const mode = stat.isLink ? LINK_MODE : (stat.mode ?? (stat.isDir ? 0o40755 : 0o100644))
    const node = this.nodes.makeNode(parent, name, mode, stat.rdev ?? 0)
    node.usedBytes = stat.size
    if (stat.mtimeMs !== undefined) node.atime = node.mtime = node.ctime = stat.mtimeMs
    if (target !== undefined) node.link = target
    else if (this.host.isFile(mode)) node.loaded = false
    // Emscripten's getdents looks up every name it lists, so a row the
    // file adapter could not classify still needs a node; it goes in as a
    // regular file and is asked about before its first stat.
    if (isUnclassified(stat)) node.unclassified = true
    return node
  }

  /**
   * Ask the mount what a node placed from an unclassified row is.
   *
   * The listing that placed it swallowed a failed stat so the rest of
   * the directory could list; the guest's own stat is where that
   * failure belongs, so this one asks the mount rather than answering
   * from the guess. An answer restamps the node, turning it into a
   * directory if that is what it is; content already loaded or written
   * keeps its own length.
   *
   * Args:
   *   node: the node to classify.
   */
  private classifyNode(node: FSNode): void {
    const sync = this.sync
    const path = this.nodes.pathOf(node)
    const stat = this.readThrough([path], () => sync.stat(path))
    node.unclassified = false
    this.nodes.retype(node, stat.mode)
    node.rdev = stat.rdev ?? 0
    node.atime = node.mtime = node.ctime = stat.mtimeMs ?? 0
    if (this.host.isFile(stat.mode) && node.loaded === false) node.usedBytes = stat.size
  }

  private loadContents(node: FSNode): void {
    const sync = this.sync
    if (node.loaded !== false) return
    const path = this.nodes.pathOf(node)
    const bytes = this.readThrough([path], () => sync.read(path))
    node.contents = bytes
    node.usedBytes = bytes.length
    node.loaded = true
  }

  /**
   * Create a symlink node and record it for the mounts.
   *
   * A link is namespace state, which is exactly why this can be served:
   * the op reaches the node table rather than a backend, so a link lands
   * on an s3 or notion mount whose store has no such thing. The target
   * is stored as typed and never resolved here.
   *
   * Args:
   *   parent: directory the link is created in.
   *   name: the link's own name.
   *   target: what it points at, verbatim.
   */
  private symlink(parent: FSNode, name: string, target: string): FSNode {
    const path = this.nodes.pathOf(parent) + '/' + name
    this.journal.markSymlink(path, target)
    this.settle(path)
    const node = this.nodes.makeNode(parent, name, LINK_MODE)
    node.link = target
    return node
  }

  /**
   * The target of a symlink node.
   *
   * Args:
   *   node: the node to read.
   */
  private readlink(node: FSNode): string {
    if (!this.host.isLink(node.mode)) throw errnoError(this.host, this.errno, 'EINVAL')
    return node.link ?? ''
  }

  private streamOpen(stream: FSStream): void {
    this.loadContents(stream.node)
  }

  private streamRead(
    stream: FSStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    const node = stream.node
    if (isCharDevice(node.mode)) {
      if (EOF_ON_READ_RDEV.has(node.rdev)) return 0
      buffer.fill(0, offset, offset + length)
      return length
    }
    const used = node.usedBytes ?? 0
    if (position >= used) return 0
    const size = Math.min(used - position, length)
    buffer.set((node.contents ?? new Uint8Array(0)).subarray(position, position + size), offset)
    return size
  }

  private streamWrite(
    stream: FSStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    if (length === 0) return 0
    const node = stream.node
    if (isCharDevice(node.mode)) return length
    const used = node.usedBytes ?? 0
    const need = position + length
    let contents = node.contents ?? new Uint8Array(0)
    // Capacity doubles past what the file uses, so a loop of small writes
    // copies the file a logarithmic number of times, not once per write.
    if (contents.length < need) {
      const grown = new Uint8Array(Math.max(need, contents.length * 2, GROW_FLOOR))
      grown.set(contents.subarray(0, used))
      contents = grown
      node.contents = grown
    }
    if (position > used) contents.fill(0, used, position)
    const written = buffer.subarray(offset, offset + length)
    contents.set(written, position)
    node.usedBytes = Math.max(used, need)
    node.mtime = node.ctime = Date.now()
    // The rule the shared flush plan keeps: a write that starts where the
    // file ended goes as an append when the file had bytes or the stream
    // appends, and any other write as the bytes it changed, so another
    // writer's bytes elsewhere in the file survive.
    const path = this.nodes.pathOf(node)
    const appending = (stream.flags & O_APPEND) !== 0
    if (position === used && (used > 0 || appending)) this.journal.markAppend(path, used, written)
    else this.journal.markPwrite(path, position, written)
    return length
  }

  private llseek(stream: FSStream, offset: number, whence: number): number {
    let position = offset
    if (whence === SEEK_CUR) position += stream.position
    else if (whence === SEEK_END && this.host.isFile(stream.node.mode)) {
      position += stream.node.usedBytes ?? 0
    }
    if (position < 0) throw errnoError(this.host, this.errno, 'EINVAL')
    return position
  }
}
