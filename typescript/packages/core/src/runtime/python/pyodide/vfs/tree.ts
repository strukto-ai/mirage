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

import { DIR_MODE, FILE_MODE, LINK_MODE } from './constants.ts'
import { fsError } from './errors.ts'
import type { MirageFsSeed } from './seed.ts'
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
export class NodeTree {
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
   * Populate the tree from a collected seed.
   *
   * Must run after `FS.mount`, never inside it: `FSNode` copies `mount`
   * from its parent, and Emscripten assigns the root's only once
   * `type.mount()` has returned. Seeding early leaves every nested node
   * with an undefined mount, and two undefined mounts compare equal,
   * which silently defeats the kernel's cross-mount rename check.
   *
   * Args:
   *   seed: tree collected from the bridge before the run.
   */
  seed(seed: MirageFsSeed): void {
    for (const dir of seed.dirs) {
      const rel = this.relative(dir)
      if (rel !== null) this.stamp(seed, dir, this.ensureDir(rel))
    }
    for (const path of seed.unreadable) {
      const node = this.placeFile(path)
      if (node !== null) {
        node.unreadable = true
        this.stamp(seed, path, node)
      }
    }
    for (const path of seed.unclassified) {
      const node = this.placeFile(path)
      if (node !== null) {
        node.unreadable = true
        node.unclassified = true
      }
    }
    for (const [path, bytes] of seed.files) {
      const node = this.placeFile(path)
      if (node === null) continue
      node.contents = bytes
      node.usedBytes = bytes.length
      this.stamp(seed, path, node)
    }
    for (const [path, device] of seed.devices) {
      const node = this.placeFile(path, device.mode, device.rdev)
      if (node !== null) this.stamp(seed, path, node)
    }
    for (const [path, target] of seed.links) {
      const node = this.placeFile(path, LINK_MODE)
      if (node !== null) node.link = target
    }
  }

  /**
   * Put the mount's own mode and stamp on a node the seed just placed.
   *
   * Without it a seeded node carries `makeNode`'s defaults: 0o644
   * whatever the mount holds, and the moment the node was built, so a
   * chmod the shell made was invisible and every file the guest stats
   * looked modified this second. Only seeded nodes are restamped: a
   * file the guest creates during the run really was modified now.
   *
   * Args:
   *   seed: the collected tree, holding what the rows reported.
   *   path: guest-absolute path of the node.
   *   node: the node just placed for it.
   */
  private stamp(seed: MirageFsSeed, path: string, node: FSNode): void {
    const mode = seed.modes.get(path)
    // Permission bits only: the kind is the tree's own decision, and a
    // row that disagreed would otherwise turn a file into a directory.
    if (mode !== undefined) node.mode = (node.mode & ~0o7777) | (mode & 0o7777)
    const at = seed.stamps.get(path)
    if (at !== undefined) {
      node.atime = at.atimeMs
      node.mtime = node.ctime = at.mtimeMs
    }
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

  private rootNode(): FSNode {
    // Only reachable from seed(), which the host calls: a guest syscall
    // always arrives on a node, and no node exists before mount().
    if (this.root === null) throw fsError('EIO', 'mirage fs: seeded before it was mounted')
    return this.root
  }

  private relative(path: string): string | null {
    if (path === this.prefix) return ''
    if (!path.startsWith(this.prefix + '/')) return null
    return path.slice(this.prefix.length + 1).replace(/\/+$/, '')
  }

  private ensureDir(rel: string): FSNode {
    let cur = this.rootNode()
    if (rel === '') return cur
    for (const part of rel.split('/')) {
      if (part === '') continue
      const next = cur.children?.get(part)
      cur = next ?? this.makeNode(cur, part, DIR_MODE)
    }
    return cur
  }

  /**
   * Create a leaf node at `path`, building the directories above it.
   *
   * Args:
   *   path: guest-absolute path of the leaf.
   *   mode: type and permission bits, a regular file by default.
   */
  private placeFile(path: string, mode: number = FILE_MODE, rdev = 0): FSNode | null {
    const rel = this.relative(path)
    if (rel === null) return null
    const cut = rel.lastIndexOf('/')
    const name = cut < 0 ? rel : rel.slice(cut + 1)
    if (name === '') return null
    const parent = cut <= 0 ? this.rootNode() : this.ensureDir(rel.slice(0, cut))
    return this.makeNode(parent, name, mode, rdev)
  }
}
