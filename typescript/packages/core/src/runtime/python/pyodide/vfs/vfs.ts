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

import { planFlush } from '../../../handles/index.ts'
import { epochToIso } from '../../../../utils/dates.ts'
import type { SetAttrFields } from '../../../../types.ts'
import { BLKSIZE, LINK_MODE, SEEK_CUR, SEEK_END } from './constants.ts'
import { errnoError } from './errors.ts'
import { classify } from '../../../../errors/index.ts'
import { isUnclassified, type VFSEntry, type VFSStat } from '../../../vfs.ts'
import type { MutationJournal } from './journal.ts'
import type { MirageFsSeed } from './seed.ts'
import { NodeTree } from './tree.ts'
import type {
  ErrnoCodes,
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

/**
 * Whether the seed already places a node at this path, by any means.
 *
 * Args:
 *   seed: the tree collected from the mounts before the run.
 *   path: guest-absolute path to check.
 */
function seedHolds(seed: MirageFsSeed, path: string): boolean {
  return (
    seed.files.has(path) ||
    seed.devices.has(path) ||
    seed.links.has(path) ||
    seed.unreadable.has(path) ||
    seed.dirs.includes(path)
  )
}

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
 * chmod does lower a real mode; `MirageFs.fresh` is what suppresses
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
 * Callbacks are synchronous. In a worker, uncached lookups and reads wait
 * for the host through SyncVFS. Without a worker, reads use the complete
 * seed collected before execution. Writes enter the journal and flush
 * before a lazy backend read or after the run, preserving guest order.
 *
 * The node table lives in `NodeTree` and the flush decision in
 * `planFlush`; what is left here is one method per Emscripten callback,
 * plus the errno translation only this layer performs.
 */
export class MirageFs {
  readonly type: FSType
  private readonly host: FSHost
  private readonly errno: ErrnoCodes
  private readonly journal: MutationJournal
  private readonly tree: NodeTree
  private readonly mountOf: (path: string) => string | null
  private readonly prefix: string
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
   *   mountOf: the mirage mount owning a path (`RuntimeVFS.mountOf`).
   *     One mountpoint serves every mirage mount nested under its
   *     prefix, so this is the only boundary fact left to check ops
   *     against; Emscripten's own cross-mount checks cannot see it.
   */
  constructor(
    host: FSHost,
    errno: ErrnoCodes,
    journal: MutationJournal,
    prefix: string,
    mountOf: (path: string) => string | null,
    private readonly sync?: SyncVFS,
  ) {
    this.host = host
    this.prefix = prefix
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
      close: () => undefined,
      read: this.streamRead.bind(this),
      write: this.streamWrite.bind(this),
      llseek: this.llseek.bind(this),
    }
    this.tree = new NodeTree(host, prefix, nodeOps, streamOps)
    this.type = { mount: this.tree.mount.bind(this.tree) }
  }

  /**
   * Populate the tree. Must run after `FS.mount`; see `NodeTree.seed`.
   *
   * Args:
   *   seed: tree collected from the mounts before the run.
   */
  seed(seed: MirageFsSeed): void {
    // Only when this shim is what /dev resolves to. The mount's own listing
    // is untouched: these nodes live in this tree, which is what the
    // interpreter reads, not what `ls /dev` on the mount reports.
    if (this.prefix === '/dev' && this.sync === undefined) {
      for (const [name, rdev] of STD_STREAM_RDEV) {
        const path = `/dev/${name}`
        // Only where the mount itself has nothing by that name. `NodeTree.seed`
        // places devices after files, directories and links, so injecting one
        // blindly would overwrite a real entry the mount is serving and hand
        // the guest an empty device instead of its content.
        if (seedHolds(seed, path)) continue
        // A write is swallowed, as it is for every synthetic character device
        // here. The interpreter's real stderr rides its own capture, not this
        // node, so nothing that used to be reported is lost: before this the
        // path did not exist at all and the open raised.
        seed.charDevice(path, S_IFCHR | 0o666, rdev)
      }
    }
    this.tree.seed(seed)
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
      nlink: 1,
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
    if (attr.mode !== undefined) node.mode = attr.mode
    if (attr.atime !== undefined) node.atime = attr.atime
    if (attr.mtime !== undefined) node.mtime = attr.mtime
    if (attr.ctime !== undefined) node.ctime = attr.ctime
    if (fields !== null) {
      // A link's own attrs go to the link, since the tree resolved to
      // the link node itself and the target's row is not what changed.
      if (this.host.isLink(node.mode)) fields.nofollow = true
      this.journal.markSetattr(this.tree.pathOf(node), fields)
    }
    if (attr.size === undefined || isDevice) return
    if (attr.size > 0) this.loadContents(node)
    const old = node.contents ?? new Uint8Array(0)
    const next = new Uint8Array(attr.size)
    next.set(old.subarray(0, Math.min(old.length, attr.size)))
    node.contents = next
    node.usedBytes = attr.size
    node.loaded = true
    // A resize rewrites history, so it can only ship whole. Recording here
    // rather than at close is what makes a bare `os.truncate(path, n)`,
    // which opens no handle at all, reach the mount.
    this.journal.markWrite(this.tree.pathOf(node), next)
  }

  private lookup(parent: FSNode, name: string): FSNode {
    const sync = this.sync
    let found = this.tree.childOf(parent, name)
    if (found === undefined && sync !== undefined) {
      found = this.readThrough(() => {
        const path = this.tree.pathOf(parent) + '/' + name
        let stat: VFSStat
        try {
          stat = sync.stat(path)
        } catch (error) {
          const rdev = STD_STREAM_RDEV.get(name)
          if (
            this.tree.pathOf(parent) === '/dev' &&
            rdev !== undefined &&
            classify(error) === 'ENOENT'
          ) {
            return this.tree.makeNode(parent, name, S_IFCHR | 0o666, rdev)
          }
          throw error
        }
        return this.placeEntry(parent, name, stat)
      })
    }
    // The eager fallback has already collected every reachable entry;
    // lazy misses have just been checked against the workspace.
    if (found === undefined) throw errnoError(this.host, this.errno, 'ENOENT')
    return found
  }

  private mknod(parent: FSNode, name: string, mode: number, rdev: number): FSNode {
    const node = this.tree.makeNode(parent, name, mode)
    node.rdev = rdev
    // A character device is not mount content. pyodide makes one of its own
    // at runtime -- `API.capture_stderr` calls FS.createDevice, which lands
    // here as mknod -- and journaling it queued a write of /dev/capture_stderr
    // against the real mount, which then failed on replay. Devices live in
    // this tree only.
    if (isCharDevice(mode)) return node
    const path = this.tree.pathOf(node)
    if (this.host.isDir(mode)) this.journal.markMkdir(path)
    else {
      // An empty write is what carries a file that is created and never
      // written (`Path.touch()`, `open(p,'w').close()`) through to the
      // mount. A later write for the same path coalesces over it.
      this.journal.markWrite(path, new Uint8Array(0))
      // FS.open finalizes a new file with a chmod of its own, right
      // here and on this node. Only a file is marked: a directory gets
      // no such call, so a marker left on one would swallow the guest's
      // next chmod instead.
      this.fresh = node
    }
    return node
  }

  private rename(node: FSNode, newDir: FSNode, newName: string): void {
    const from = this.tree.pathOf(node)
    const to = this.tree.pathOf(newDir) + '/' + newName
    // A nested mirage mount is served through this same mountpoint, so
    // Emscripten's kernel cannot see the boundary; refuse the crossing
    // here, before the tree moves and the journal records a rename the
    // post-run replay would reject anyway.
    if (this.mountOf(from) !== this.mountOf(to)) {
      throw errnoError(this.host, this.errno, 'EXDEV')
    }
    this.tree.move(node, newDir, newName)
    this.journal.markRename(from, to)
  }

  private unlink(parent: FSNode, name: string): void {
    const path = this.tree.pathOf(parent) + '/' + name
    this.tree.detach(parent, name)
    this.journal.markUnlink(path)
  }

  private rmdir(parent: FSNode, name: string): void {
    if (this.sync !== undefined && this.readdir(this.lookup(parent, name)).length > 2) {
      throw errnoError(this.host, this.errno, 'ENOTEMPTY')
    }
    const path = this.tree.pathOf(parent) + '/' + name
    this.tree.detach(parent, name)
    this.journal.markRmdir(path)
  }

  private readdir(node: FSNode): string[] {
    const sync = this.sync
    if (sync !== undefined) {
      this.readThrough(() => {
        for (const entry of sync.readdir(this.tree.pathOf(node) + '/')) {
          const name = entry.path.replace(/\/$/, '').split('/').pop() ?? ''
          if (this.tree.childOf(node, name) === undefined) this.placeEntry(node, name, entry)
        }
      })
    }
    return ['.', '..', ...this.tree.childNames(node)]
  }

  private readThrough<T>(read: () => T): T {
    try {
      this.sync?.flush(this.journal.takeMutations())
      return read()
    } catch (error) {
      throw errnoError(this.host, this.errno, classify(error) ?? 'EIO')
    }
  }

  private placeEntry(parent: FSNode, name: string, stat: VFSStat | VFSEntry): FSNode {
    const target =
      stat.isLink && this.sync !== undefined
        ? this.sync.readlink(this.tree.pathOf(parent) + '/' + name)
        : undefined
    const mode = stat.isLink ? LINK_MODE : (stat.mode ?? (stat.isDir ? 0o40755 : 0o100644))
    const node = this.tree.makeNode(parent, name, mode, stat.rdev ?? 0)
    node.usedBytes = stat.size
    if (stat.mtimeMs !== undefined) node.atime = node.mtime = node.ctime = stat.mtimeMs
    if (target !== undefined) node.link = target
    else if (this.host.isFile(mode)) node.loaded = false
    // Emscripten's getdents looks up every name it lists, so a row the
    // door could not classify still needs a node; it goes in as a
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
   * keeps its own length. Without a worker there is no mount to ask
   * mid-run, and the preload already asked twice, so the answer is EIO.
   *
   * Args:
   *   node: the node to classify.
   */
  private classifyNode(node: FSNode): void {
    const sync = this.sync
    if (sync === undefined) throw errnoError(this.host, this.errno, 'EIO')
    const stat = this.readThrough(() => sync.stat(this.tree.pathOf(node)))
    node.unclassified = false
    this.tree.retype(node, stat.mode)
    node.rdev = stat.rdev ?? 0
    node.atime = node.mtime = node.ctime = stat.mtimeMs
    if (this.host.isFile(stat.mode) && node.loaded === false) node.usedBytes = stat.size
  }

  private loadContents(node: FSNode): void {
    const sync = this.sync
    if (node.loaded !== false || sync === undefined) return
    const bytes = this.readThrough(() => sync.read(this.tree.pathOf(node)))
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
    const node = this.tree.makeNode(parent, name, LINK_MODE)
    node.link = target
    this.journal.markSymlink(this.tree.pathOf(node), target)
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
    // The mount listed this file but would not serve it, so its real
    // length and content are unknown. Any handle at all is refused,
    // because a write through one could only guess at what it replaces.
    if (stream.node.unreadable === true) throw errnoError(this.host, this.errno, 'EIO')
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
    const baseLen = node.usedBytes ?? 0
    const need = position + length
    let contents = node.contents ?? new Uint8Array(0)
    if (contents.length < need) {
      const grown = new Uint8Array(need)
      grown.set(contents)
      contents = grown
      node.contents = grown
    }
    contents.set(buffer.subarray(offset, offset + length), position)
    node.usedBytes = Math.max(node.usedBytes ?? 0, need)
    node.mtime = node.ctime = Date.now()
    const [kind, bytes] = planFlush(baseLen, position, contents.subarray(0, node.usedBytes))
    const path = this.tree.pathOf(node)
    if (kind === 'append') this.journal.markAppend(path, bytes)
    else this.journal.markWrite(path, bytes)
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
