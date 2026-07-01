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

import type { Resource } from '../../resource/base.ts'
import type { MountMode, PathSpec } from '../../types.ts'
import { resolveSymlinks } from '../../utils/path.ts'
import type { ResolveFn } from '../dispatcher.ts'
import type { MountEntry } from './mount.ts'
import type { MountRegistry } from './registry.ts'

// A symlink stored verbatim as typed: the target string is kept exactly as the
// user wrote it (relative targets are resolved lazily against the link's own
// parent at resolution time), so `readlink` is GNU-faithful. `mtime` gives the
// link a stat home for later phases (a symlink has no backend inode).
export interface LinkEntry {
  target: string
  mtime: number
}

// Addressing authority: maps virtual paths to their mounts. Owns the mount
// registry and the symlink table (and, in a later phase, the attribute
// overlay). Pure addressing: resolve a virtual path to its resource and
// backend-relative path, following symlinks and crossing mounts. Holds no
// cache and performs no backend I/O; op execution and caching live in the
// Dispatcher, which calls this layer to locate the mount.
export class Namespace {
  private readonly registry: MountRegistry
  private readonly resolveFn: ResolveFn
  private links = new Map<string, LinkEntry>()

  constructor(registry: MountRegistry, resolveFn: ResolveFn) {
    this.registry = registry
    this.resolveFn = resolveFn
  }

  get symlinks(): Map<string, LinkEntry> {
    return this.links
  }

  replaceSymlinks(entries: Map<string, LinkEntry>): void {
    this.links = new Map(entries)
  }

  symlinkTargets(): Map<string, string> {
    const out = new Map<string, string>()
    for (const [link, entry] of this.links) out.set(link, entry.target)
    return out
  }

  isLink(path: string): boolean {
    return this.links.has(path)
  }

  readlink(path: string): string | null {
    return this.links.get(path)?.target ?? null
  }

  symlink(link: string, target: string, mtime: number): void {
    this.links.set(link, { target, mtime })
  }

  unlink(path: string): boolean {
    return this.links.delete(path)
  }

  rename(src: string, dst: string): boolean {
    const entry = this.links.get(src)
    if (entry === undefined) return false
    this.links.delete(src)
    this.links.set(dst, entry)
    return true
  }

  // Map a virtual path to its mount, following the symlink table first when
  // `follow` is set. Throws CycleError when resolution exceeds the hop limit.
  async resolve(path: string, follow = true): Promise<[Resource, PathSpec, MountMode]> {
    if (follow && this.links.size > 0) {
      path = resolveSymlinks(path, this.symlinkTargets())
    }
    return this.resolveFn(path)
  }

  mountFor(path: string): MountEntry | null {
    return this.registry.mountFor(path)
  }

  isMountRoot(path: string): boolean {
    return this.registry.isMountRoot(path)
  }
}
