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

import { DIR_MODE } from './constants.ts'
import type { FSNode, NodeHost, NodeOps, StreamOps } from './types.ts'

/**
 * The node table for one mount prefix.
 *
 * Everything about *which* nodes exist and what they are called lives
 * here: creating them, naming them, moving them, and translating between
 * the guest's absolute paths and positions in this tree. It records no
 * mutations and reports no errno, so the filesystem above it is left with
 * only the semantics of each call.
 */
export class NodeTable {
  private readonly host: NodeHost
  private readonly nodeOps: NodeOps
  private readonly streamOps: StreamOps
  private readonly prefix: string
  private root: FSNode | null = null

  /**
   * Args:
   *   host: the Emscripten FS namespace, for `createNode` and the mode
   *     predicates.
   *   prefix: the mount prefix this tree serves, trailing slash optional.
   *   nodeOps: op table every node created here must carry.
   *   streamOps: stream op table every node created here must carry.
   */
  constructor(host: NodeHost, prefix: string, nodeOps: NodeOps, streamOps: StreamOps) {
    this.host = host
    this.prefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
    this.nodeOps = nodeOps
    this.streamOps = streamOps
  }

  /** Build the root. Emscripten calls this through `FSType.mount`. */
  mount(): FSNode {
    this.root = this.makeNode(null, '/', DIR_MODE)
    return this.root
  }

  /**
   * Create a node and file it under its parent.
   *
   * Args:
   *   parent: directory to file it under, null only for the root.
   *   name: the child's name.
   *   mode: type and permission bits.
   */
  makeNode(parent: FSNode | null, name: string, mode: number, rdev = 0): FSNode {
    const node = this.host.createNode(parent, name, mode, rdev)
    node.node_ops = this.nodeOps
    node.stream_ops = this.streamOps
    if (this.host.isDir(mode)) node.children = new Map()
    else if (this.host.isLink(mode)) node.link = ''
    else {
      node.contents = new Uint8Array(0)
      node.usedBytes = 0
    }
    node.atime = node.mtime = node.ctime = Date.now()
    if (parent !== null) {
      parent.children ??= new Map()
      parent.children.set(name, node)
    }
    return node
  }

  /**
   * Give a placed node the kind a mount reported for it afterwards.
   *
   * Only a node placed from an unclassified listing row is ever built on
   * a guess, and the guess is a regular file. When the mount says it is
   * a directory, the node trades its content for a child table, which is
   * what `makeNode` would have built for one.
   *
   * Args:
   *   node: the node to retype.
   *   mode: the mode the mount reported, type bits included.
   */
  retype(node: FSNode, mode: number): void {
    const becomesDir = this.host.isDir(mode) && !this.host.isDir(node.mode)
    node.mode = mode
    if (!becomesDir) return
    node.children = new Map()
    delete node.contents
    delete node.usedBytes
    delete node.loaded
  }

  childOf(parent: FSNode, name: string): FSNode | undefined {
    return parent.children?.get(name)
  }

  /**
   * Forget every node below the root, so the next lookup asks the mount.
   *
   * A child process may have changed anything the tree served. A node an
   * open handle still holds keeps its bytes, as a descriptor keeps its
   * inode: emptying it would hand a later read stale lengths over no
   * content, and a later write would ship that empty buffer whole.
   */
  invalidate(): void {
    if (this.root === null) return
    const pending = [...(this.root.children?.values() ?? [])]
    while (pending.length > 0) {
      const node = pending.pop()
      if (node === undefined) break
      pending.push(...(node.children?.values() ?? []))
      this.host.destroyNode?.(node)
    }
    this.root.children?.clear()
    delete this.root.listed
  }

  childNames(node: FSNode): string[] {
    return [...(node.children?.keys() ?? [])]
  }

  detach(parent: FSNode, name: string): void {
    parent.children?.delete(name)
  }

  /**
   * Move a node to a new parent and name.
   *
   * Args:
   *   node: the node being moved.
   *   newDir: its new parent directory.
   *   newName: its new name.
   */
  move(node: FSNode, newDir: FSNode, newName: string): void {
    node.parent.children?.delete(node.name)
    newDir.children ??= new Map()
    newDir.children.set(newName, node)
    node.parent = newDir
    node.name = newName
  }

  /** The guest-absolute path of a node, which is what the journal names. */
  pathOf(node: FSNode): string {
    const parts: string[] = []
    let cur = node
    while (cur.parent !== cur) {
      parts.unshift(cur.name)
      cur = cur.parent
    }
    return parts.length === 0 ? this.prefix : this.prefix + '/' + parts.join('/')
  }
}
