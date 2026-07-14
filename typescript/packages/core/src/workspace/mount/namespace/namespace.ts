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

import type { Resource } from '../../../resource/base.ts'
import { DEFAULT_AGENT_ID, type MountMode, type PathSpec } from '../../../types.ts'
import { globPrefixMatch, resolveSymlinks } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { ResolveFn } from '../../dispatcher.ts'
import type { MountEntry } from '../mount.ts'
import { RAMNamespaceStore } from './ram.ts'
import type { NamespaceStore, NodeFields } from './store.ts'
import type { MountRegistry } from '../registry.ts'

// Per-path namespace metadata. Two roles, distinguished by `target`: a
// target-bearing entry is an authoritative symlink (the link exists only
// here; the target string is kept exactly as the user wrote it, so
// `readlink` is GNU-faithful); a target-less entry is a metadata overlay
// for a backend file whose backend has no native attribute slot.
// Attributes are stored, not enforced: mount mode does real access control.
export interface NodeMeta {
  target?: string
  mtime?: number
  mode?: number
  uid?: number | string
  gid?: number | string
  atime?: string
}

export interface SetAttrsFields {
  mode?: number
  uid?: number | string
  gid?: number | string
  atime?: string
  mtime?: number
}

function metaToFields(meta: NodeMeta): NodeFields {
  const out: NodeFields = {}
  if (meta.target !== undefined) out.target = meta.target
  if (meta.mtime !== undefined) out.mtime = meta.mtime
  if (meta.mode !== undefined) out.mode = meta.mode
  if (meta.uid !== undefined) out.uid = meta.uid
  if (meta.gid !== undefined) out.gid = meta.gid
  if (meta.atime !== undefined) out.atime = meta.atime
  return out
}

function metaFromFields(fields: NodeFields): NodeMeta {
  const meta: NodeMeta = {}
  if (typeof fields.target === 'string') meta.target = fields.target
  if (typeof fields.mtime === 'number') meta.mtime = fields.mtime
  if (typeof fields.mode === 'number') meta.mode = fields.mode
  if (typeof fields.uid === 'number' || typeof fields.uid === 'string') meta.uid = fields.uid
  if (typeof fields.gid === 'number' || typeof fields.gid === 'string') meta.gid = fields.gid
  if (typeof fields.atime === 'string') meta.atime = fields.atime
  return meta
}

// Addressing authority: maps virtual paths to their mounts. Owns the mount
// registry and the per-path node-metadata table (symlinks plus the attribute
// overlay). Pure addressing: resolve a virtual path to its resource and
// backend-relative path, following symlinks and crossing mounts. Holds no
// cache and performs no backend I/O; op execution and caching live in the
// Dispatcher, which calls this layer to locate the mount.
//
// The in-memory table is the working copy (reads stay synchronous on the
// hot path); every mutation writes through to a NamespaceStore (RAM by
// default, Redis for restart-durable namespaces), and the table hydrates
// from the store once on first use.
export class Namespace {
  private readonly registry: MountRegistry
  private readonly resolveFn: ResolveFn
  private readonly store: NamespaceStore
  private nodeTable = new Map<string, NodeMeta>()
  private loaded = false
  private loading: Promise<void> | null = null
  private readonly claim: string | null
  private workspaceUser: string | null = null
  private userResolved = false
  private userResolving: Promise<void> | null = null

  constructor(
    registry: MountRegistry,
    resolveFn: ResolveFn,
    store?: NamespaceStore,
    user?: string | null,
  ) {
    this.registry = registry
    this.resolveFn = resolveFn
    this.store = store ?? new RAMNamespaceStore()
    this.claim = user ?? null
  }

  get nodes(): Map<string, NodeMeta> {
    return this.nodeTable
  }

  // The workspace user (whoami identity). Before store resolution the
  // launch claim (or DEFAULT_AGENT_ID) answers; after it, the resolved
  // identity.
  get user(): string {
    if (this.workspaceUser !== null) return this.workspaceUser
    if (this.claim !== null) return this.claim
    return DEFAULT_AGENT_ID
  }

  // Resolve the workspace user against the store, once. An explicit launch
  // claim wins and writes through; without one the stored identity is
  // adopted, so a runtime attaching to a shared store (e.g. Redis)
  // inherits the workspace's whoami.
  private async resolveUser(): Promise<void> {
    if (this.userResolved) return
    this.userResolving ??= (async () => {
      const stored = await this.store.loadUser()
      if (this.claim !== null) {
        this.workspaceUser = this.claim
        if (stored !== this.claim) await this.store.setUser(this.claim)
      } else {
        this.workspaceUser = stored
      }
      this.userResolved = true
    })()
    await this.userResolving
  }

  // Hydrate the working copy from the store, once. A snapshot restore
  // (`replaceNodes`) marks the table loaded, so snapshot state wins over
  // whatever the store held before it.
  async ensureLoaded(): Promise<void> {
    if (this.loaded && this.userResolved) return
    this.loading ??= this.store.load().then((entries) => {
      if (this.loaded) return
      const table = new Map<string, NodeMeta>()
      for (const [path, fields] of entries) table.set(path, metaFromFields(fields))
      this.nodeTable = table
      this.loaded = true
    })
    await this.loading
    await this.resolveUser()
  }

  async replaceNodes(entries: Map<string, NodeMeta>): Promise<void> {
    this.nodeTable = new Map(entries)
    this.loaded = true
    await this.resolveUser()
    const out = new Map<string, NodeFields>()
    for (const [path, meta] of entries) out.set(path, metaToFields(meta))
    await this.store.replaceAll(out)
  }

  async close(): Promise<void> {
    await this.store.close()
  }

  symlinkTargets(): Map<string, string> {
    const out = new Map<string, string>()
    for (const [path, meta] of this.nodeTable) {
      if (meta.target !== undefined) out.set(path, meta.target)
    }
    return out
  }

  hasLinks(): boolean {
    for (const meta of this.nodeTable.values()) {
      if (meta.target !== undefined) return true
    }
    return false
  }

  isLink(path: string): boolean {
    return this.nodeTable.get(path)?.target !== undefined
  }

  readlink(path: string): string | null {
    return this.nodeTable.get(path)?.target ?? null
  }

  async symlink(link: string, target: string, mtime: number): Promise<void> {
    const meta = this.nodeTable.get(link) ?? {}
    meta.target = target
    meta.mtime = mtime
    this.nodeTable.set(link, meta)
    await this.store.set(link, metaToFields(meta))
  }

  metaFor(path: string): NodeMeta | null {
    return this.nodeTable.get(path) ?? null
  }

  // Write overlay attributes for a path (setattr fallback). Used for
  // symlinks (which have no backend inode) and for backends without a
  // native metadata slot. Only present fields are written.
  async setAttrs(path: string, fields: SetAttrsFields): Promise<void> {
    const meta = this.nodeTable.get(path) ?? {}
    if (fields.mode !== undefined) meta.mode = fields.mode
    if (fields.uid !== undefined) meta.uid = fields.uid
    if (fields.gid !== undefined) meta.gid = fields.gid
    if (fields.atime !== undefined) meta.atime = fields.atime
    if (fields.mtime !== undefined) meta.mtime = fields.mtime
    this.nodeTable.set(path, meta)
    await this.store.set(path, metaToFields(meta))
  }

  // Drop overlay times after a content write. write(2) refreshes mtime,
  // so a stored overlay time would otherwise shadow the backend's fresh
  // one forever. Permission and ownership survive writes; a symlink entry
  // keeps its own times.
  async clearTimes(path: string): Promise<void> {
    const meta = this.nodeTable.get(path)
    if (meta === undefined || meta.target !== undefined) return
    delete meta.mtime
    delete meta.atime
    if (Object.keys(meta).length === 0) {
      this.nodeTable.delete(path)
      await this.store.delete([path])
      return
    }
    await this.store.set(path, metaToFields(meta))
  }

  async unlink(path: string): Promise<boolean> {
    const removed = this.nodeTable.delete(path)
    if (removed) await this.store.delete([path])
    return removed
  }

  // Drop node entries matching an unexpanded glob operand. `rm` receives
  // the pattern verbatim (backend wrappers expand globs themselves), so
  // the node table must match it here. Drops matched entries and
  // everything under a matched directory.
  async unlinkGlob(pattern: string): Promise<number> {
    const doomed: string[] = []
    for (const path of this.nodeTable.keys()) {
      if (globPrefixMatch(path, pattern)) doomed.push(path)
    }
    for (const path of doomed) this.nodeTable.delete(path)
    if (doomed.length > 0) await this.store.delete(doomed)
    return doomed.length
  }

  async rename(src: string, dst: string): Promise<boolean> {
    const meta = this.nodeTable.get(src)
    if (meta === undefined) return false
    this.nodeTable.delete(src)
    this.nodeTable.set(dst, meta)
    await this.store.set(dst, metaToFields(meta))
    await this.store.delete([src])
    return true
  }

  // Return `path` with all symlink prefixes resolved; identity when the
  // table is empty or nothing matches. Throws CycleError on ELOOP.
  follow(path: string): string {
    const targets = this.symlinkTargets()
    if (targets.size === 0) return path
    return resolveSymlinks(path, targets)
  }

  // Links living directly under a directory: basename -> target.
  linksUnder(directory: string): Map<string, string> {
    const base = rstripSlash(directory) + '/'
    const out = new Map<string, string>()
    for (const [path, meta] of this.nodeTable) {
      if (
        meta.target !== undefined &&
        path.startsWith(base) &&
        !path.slice(base.length).includes('/')
      ) {
        out.set(path.slice(base.length), meta.target)
      }
    }
    return out
  }

  // Drop every node entry under a directory (`rm -r` semantics).
  async purgeUnder(directory: string): Promise<number> {
    const base = rstripSlash(directory) + '/'
    const doomed: string[] = []
    for (const path of this.nodeTable.keys()) {
      if (path.startsWith(base)) doomed.push(path)
    }
    for (const path of doomed) this.nodeTable.delete(path)
    if (doomed.length > 0) await this.store.delete(doomed)
    return doomed.length
  }

  // Map a virtual path to its mount, following the symlink table first when
  // `follow` is set. Throws CycleError when resolution exceeds the hop limit.
  async resolve(path: string, follow = true): Promise<[Resource, PathSpec, MountMode]> {
    if (follow) path = this.follow(path)
    return this.resolveFn(path)
  }

  mountFor(path: string): MountEntry | null {
    return this.registry.mountFor(path)
  }

  isMountRoot(path: string): boolean {
    return this.registry.isMountRoot(path)
  }
}
