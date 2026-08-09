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

import { NO_WRITE, planFlush } from '../../vfs.ts'
import { BLKSIZE, SEEK_CUR, SEEK_END } from './constants.ts'
import { errnoError } from './errors.ts'
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
} from './types.ts'

/**
 * An Emscripten filesystem backed by a mirage mount.
 *
 * This is the pyodide runtime's interception layer. Mounting it at a mount
 * prefix puts mirage below the guest's syscall boundary, where every
 * spelling of an operation (`open`, `os.open`, `pathlib`, `shutil`'s
 * fd-relative walk) arrives as the same callback. Nothing is patched
 * inside the interpreter.
 *
 * Callbacks are synchronous because Emscripten's are, so they never reach
 * the mounts inline: reads are served from the tree `seed` filled before
 * the run, and writes are recorded on the mutation journal for the runtime
 * to replay after it. That is the same contract the guest had before, and
 * the reason it needs no JSPI.
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

  /**
   * Args:
   *   host: the Emscripten FS namespace (`pyodide.FS`).
   *   errno: Emscripten's errno table (`pyodide.ERRNO_CODES`).
   *   journal: the write-ahead log guest mutations are recorded on.
   *   prefix: the mount prefix this filesystem serves.
   */
  constructor(host: FSHost, errno: ErrnoCodes, journal: MutationJournal, prefix: string) {
    this.host = host
    this.errno = errno
    this.journal = journal
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
    }
    const streamOps: StreamOps = {
      open: this.streamOpen.bind(this),
      close: this.streamClose.bind(this),
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
    this.tree.seed(seed)
  }

  private getattr(node: FSNode): FSAttr {
    const size = this.host.isDir(node.mode) ? BLKSIZE : (node.usedBytes ?? 0)
    return {
      dev: 1,
      ino: node.id,
      mode: node.mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size,
      atime: new Date(node.atime),
      mtime: new Date(node.mtime),
      ctime: new Date(node.ctime),
      blksize: BLKSIZE,
      blocks: Math.ceil(size / BLKSIZE),
    }
  }

  private setattr(node: FSNode, attr: SetAttr): void {
    if (attr.mode !== undefined) node.mode = attr.mode
    if (attr.atime !== undefined) node.atime = attr.atime
    if (attr.mtime !== undefined) node.mtime = attr.mtime
    if (attr.ctime !== undefined) node.ctime = attr.ctime
    if (attr.size === undefined) return
    const old = node.contents ?? new Uint8Array(0)
    const next = new Uint8Array(attr.size)
    next.set(old.subarray(0, Math.min(old.length, attr.size)))
    node.contents = next
    node.usedBytes = attr.size
    // A resize rewrites history, so it can only ship whole. Recording here
    // rather than at close is what makes a bare `os.truncate(path, n)`,
    // which opens no handle at all, reach the mount.
    this.journal.markWrite(this.tree.pathOf(node), next)
  }

  private lookup(parent: FSNode, name: string): FSNode {
    const found = this.tree.childOf(parent, name)
    // A miss is a genuine ENOENT: the seed is everything the host could
    // reach before the run, and a callback cannot await the mounts to go
    // looking for more.
    if (found === undefined) throw errnoError(this.host, this.errno, 'ENOENT')
    return found
  }

  private mknod(parent: FSNode, name: string, mode: number, rdev: number): FSNode {
    const node = this.tree.makeNode(parent, name, mode)
    node.rdev = rdev
    const path = this.tree.pathOf(node)
    if (this.host.isDir(mode)) this.journal.markMkdir(path)
    // An empty write is what carries a file that is created and never
    // written (`Path.touch()`, `open(p,'w').close()`) through to the
    // mount. A later close for the same path coalesces over it.
    else this.journal.markWrite(path, new Uint8Array(0))
    return node
  }

  private rename(node: FSNode, newDir: FSNode, newName: string): void {
    const from = this.tree.pathOf(node)
    this.tree.move(node, newDir, newName)
    this.journal.markRename(from, this.tree.pathOf(node))
  }

  private unlink(parent: FSNode, name: string): void {
    const path = this.tree.pathOf(parent) + '/' + name
    this.tree.detach(parent, name)
    this.journal.markUnlink(path)
  }

  private rmdir(parent: FSNode, name: string): void {
    const path = this.tree.pathOf(parent) + '/' + name
    this.tree.detach(parent, name)
    this.journal.markRmdir(path)
  }

  private readdir(node: FSNode): string[] {
    return ['.', '..', ...this.tree.childNames(node)]
  }

  private symlink(): FSNode {
    // Links are namespace state in mirage, not backend state, so no mount
    // op can express one. Refusing is honest; MEMFS would accept it and
    // the link would vanish at the end of the run.
    throw errnoError(this.host, this.errno, 'EPERM')
  }

  private streamOpen(stream: FSStream): void {
    // The mount listed this file but would not serve it, so its real
    // length and content are unknown. Any handle at all is refused,
    // because a write through one could only guess at what it replaces.
    if (stream.node.unreadable === true) throw errnoError(this.host, this.errno, 'EIO')
    stream.baseLen = stream.node.usedBytes ?? 0
    stream.lowWrite = NO_WRITE
  }

  private streamClose(stream: FSStream): void {
    const low = stream.lowWrite ?? NO_WRITE
    if (low === NO_WRITE) return
    const node = stream.node
    const buf = (node.contents ?? new Uint8Array(0)).subarray(0, node.usedBytes ?? 0)
    const [kind, bytes] = planFlush(stream.baseLen ?? 0, low, buf)
    stream.lowWrite = NO_WRITE
    const path = this.tree.pathOf(node)
    if (kind === 'append') this.journal.markAppend(path, bytes)
    else this.journal.markWrite(path, bytes)
  }

  private streamRead(
    stream: FSStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    const node = stream.node
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
    stream.lowWrite = Math.min(stream.lowWrite ?? NO_WRITE, position)
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
