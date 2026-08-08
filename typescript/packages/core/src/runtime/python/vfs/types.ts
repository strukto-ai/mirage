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

/**
 * Emscripten's errno numbering, which is musl's and not Linux's: EXDEV
 * is 75 here and 18 is EDOM. Always read the numbers off the running
 * interpreter (`pyodide.ERRNO_CODES`) rather than writing literals.
 */
export interface ErrnoCodes {
  readonly ENOENT: number
  readonly EPERM: number
  readonly EINVAL: number
  readonly EIO: number
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
  contents?: Uint8Array
  usedBytes?: number
  unreadable?: boolean
}

export interface FSStream {
  node: FSNode
  position: number
  baseLen?: number
  lowWrite?: number
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
}

/** The node-building slice of the Emscripten FS namespace. */
export interface NodeHost {
  createNode(parent: FSNode | null, name: string, mode: number, rdev: number): FSNode
  isDir(mode: number): boolean
  isFile(mode: number): boolean
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
