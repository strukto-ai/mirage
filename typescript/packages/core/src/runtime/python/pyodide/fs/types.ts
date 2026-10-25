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

import type { BridgeOpAttrs } from '../../../types.ts'
import type { VFSEntry, VFSStat } from '../../../types.ts'
import type { FsCondition } from '../../../../errors/types.ts'
import type { OpenMode } from '../../../handles/mode.ts'
import type { MirageMutation } from './journal.ts'

/** An inline flush stops at its first failure; skipped excludes that entry. */
export interface FlushFailure {
  message: string
  skipped: number
  /** The failed entry's errno name, which the guest call it fails raises. */
  code?: FsCondition
}

export interface SyncVFS {
  /** Check a requested alias against command rules without issuing a backend op. */
  checkPath(path: string, follow: boolean): void
  process?(payload: string): string
  /**
   * Open a file on the run's open-file core (`RuntimeFiles.open`), which
   * holds what the handle reads and writes, and answer the handle.
   */
  open(path: string, mode: OpenMode): number
  pread(fh: number, offset: number, size: number): Uint8Array
  pwrite(fh: number, offset: number, bytes: Uint8Array): void
  /** The row an open handle stats by, what it wrote and has not landed counted. */
  fstat(fh: number): VFSStat
  ftruncate(fh: number, length: number): void
  /** Land what a handle wrote and let it go; a landing that fails throws. */
  close(fh: number): void
  /** A path's own row, never its link's target; what open handles wrote counts. */
  stat(path: string): VFSStat
  readdir(path: string, classify?: boolean): VFSEntry[]
  readlink(path: string): string
  flush(mutations: MirageMutation[]): FlushFailure | undefined
  /**
   * One extended-attribute op, answered by the dispatcher before it
   * returns: the value for getxattr, the names for listxattr.
   */
  xattr(
    op: XattrOp,
    path: string,
    name: string | undefined,
    value: Uint8Array | undefined,
    attrs: BridgeOpAttrs,
  ): unknown
}

export type XattrOp = 'getxattr' | 'listxattr' | 'setxattr' | 'removexattr'

/**
 * Emscripten's errno numbering, which is musl's and not Linux's: EXDEV
 * is 75 here and 18 is EDOM. Always read the numbers off the running
 * interpreter (`pyodide.ERRNO_CODES`) rather than writing literals.
 * The five required keys are what this filesystem raises itself; the
 * rest of the vocabulary's names are optional because Emscripten
 * builds differ on the tail (ENODATA), and `errnoError` guards a
 * missing one with EIO instead of ErrnoError(undefined).
 */
export interface ErrnoCodes {
  readonly ENOENT: number
  readonly EPERM: number
  readonly EINVAL: number
  readonly EIO: number
  readonly EXDEV: number
  readonly EBADF?: number
  readonly ENOTDIR?: number
  readonly EISDIR?: number
  readonly EEXIST?: number
  readonly EACCES?: number
  readonly ENOTEMPTY?: number
  readonly ENOTSUP?: number
  readonly ELOOP?: number
  readonly EBUSY?: number
  readonly EROFS?: number
  readonly EFBIG?: number
  readonly EPIPE?: number
  readonly ENODATA?: number
  readonly ESTALE?: number
  readonly ENETUNREACH?: number
  readonly ENETDOWN?: number
}

export interface FSNode {
  id: number
  name: string
  mode: number
  rdev: number
  parent: FSNode
  mount: unknown
  atime: number
  mtime: number
  ctime: number
  node_ops: NodeOps
  stream_ops: StreamOps
  /**
   * A Map, never a plain object: filenames come from the mount, so a
   * child called `__proto__` or `constructor` would never become an own
   * property and would resolve to something off Object.prototype.
   */
  children?: Map<string, FSNode>
  source?: VFSStat['source']
  /** Placed from an unclassified listing row; `getattr` asks the mount first. */
  unclassified?: boolean
  /** A directory whose children came from a listing of the mount. */
  listed?: boolean
  /** The owner the mount reported; absent reads as 0. */
  uid?: number
  gid?: number
  /** How many streams have the node open. */
  opens?: number
  /** Its name went while a stream had it open (`PyodideFs.orphan`). */
  unlinked?: boolean
  /**
   * A symlink's target, verbatim as it was typed. Emscripten's own
   * MEMFS keeps it under this name and `FS.readlink` reads it, so the
   * spelling is the interpreter's, not ours.
   */
  link?: string
}

export interface FSStream {
  node: FSNode
  position: number
  flags: number
  /**
   * The path it was opened under, which names its inode for `fstat`: a
   * rename keeps it, as a host descriptor keeps the path it was opened
   * under, while a stat by path names the current one.
   */
  opened?: string
  /**
   * The core handle a file's stream reads and writes through, which holds
   * its bytes; absent for a directory or a device, and once the run that
   * opened it ended (`PyodideFs.handleOf` opens it again).
   */
  fh?: number
}

export interface FSAttr {
  dev: number
  ino: number
  mode: number
  nlink: number
  uid: number
  gid: number
  rdev: number
  size: number
  atime: Date
  mtime: Date
  ctime: Date
  blksize: number
  blocks: number
}

export interface SetAttr {
  mode?: number
  atime?: number
  mtime?: number
  ctime?: number
  size?: number
}

export interface NodeOps {
  getattr(node: FSNode): FSAttr
  setattr(node: FSNode, attr: SetAttr): void
  lookup(parent: FSNode, name: string): FSNode
  mknod(parent: FSNode, name: string, mode: number, rdev: number): FSNode
  rename(node: FSNode, newDir: FSNode, newName: string): void
  unlink(parent: FSNode, name: string): void
  rmdir(parent: FSNode, name: string): void
  readdir(node: FSNode): string[]
  symlink(parent: FSNode, name: string, target: string): FSNode
  readlink(node: FSNode): string
}

export interface StreamOps {
  open(stream: FSStream): void
  close(stream: FSStream): void
  read(
    stream: FSStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number
  write(
    stream: FSStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number
  llseek(stream: FSStream, offset: number, whence: number): number
  /** What `fstat` answers; Emscripten asks the node when it is absent. */
  getattr?(stream: FSStream): FSAttr
}

/** The node-building slice of the Emscripten FS namespace. */
export interface NodeHost {
  destroyNode?(node: FSNode): void
  createNode(parent: FSNode | null, name: string, mode: number, rdev: number): FSNode
  isDir(mode: number): boolean
  isFile(mode: number): boolean
  isLink(mode: number): boolean
}

/**
 * `NodeHost` plus the error constructor. Only the adapter takes this
 * one: the node table below it cannot reach `ErrnoError`, so it cannot
 * accidentally answer in an interpreter's private numbering.
 */
export interface FSHost extends NodeHost {
  ErrnoError: new (errno: number) => Error
}

export interface FSType {
  mount(mount: unknown): FSNode
}
