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
import type { ResolveFn } from '../dispatcher.ts'
import type { MountEntry } from './mount.ts'
import type { MountRegistry } from './registry.ts'

// Addressing authority: maps virtual paths to their mounts. Owns the mount
// registry (and, in later phases, the symlink and attribute tables). Pure
// addressing: resolve a virtual path to its resource and backend-relative
// path, following symlinks and crossing mounts. Holds no cache and performs no
// backend I/O; op execution and caching live in the Dispatcher, which calls
// this layer to locate the mount. The `follow` argument on `resolve` is the
// seam for symlink-following; it is a no-op until the symlink table lands.
export class Namespace {
  private readonly registry: MountRegistry
  private readonly resolveFn: ResolveFn

  constructor(registry: MountRegistry, resolveFn: ResolveFn) {
    this.registry = registry
    this.resolveFn = resolveFn
  }

  async resolve(path: string, _follow = true): Promise<[Resource, PathSpec, MountMode]> {
    return this.resolveFn(path)
  }

  mountFor(path: string): MountEntry | null {
    return this.registry.mountFor(path)
  }
}
