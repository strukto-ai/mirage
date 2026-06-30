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

import type { FileCache } from '../../cache/file/mixin.ts'
import type { IOResult } from '../../io/types.ts'
import type { OpsRegistry } from '../../ops/registry.ts'
import type { Resource } from '../../resource/base.ts'
import type { MountMode } from '../../types.ts'
import { ConsistencyPolicy, type PathSpec } from '../../types.ts'
import { Dispatcher, type ResolveFn } from '../dispatcher.ts'
import type { DispatchFn } from '../executor/cross_mount.ts'
import type { MountRegistry } from './registry.ts'

// Single front for path resolution and VFS op dispatch. Owns the mount
// registry and the op dispatcher (cache read-through plus post-write
// invalidation), so the rest of the workspace talks to storage through one
// object instead of reaching the registry and dispatcher separately. The
// `follow` argument on `resolve` is the seam for symlink-following; it is a
// no-op until the symlink table lands in a later phase.
export class Namespace {
  private readonly dispatcher: Dispatcher
  private readonly resolveFn: ResolveFn

  constructor(
    registry: MountRegistry,
    cache: FileCache & Resource,
    opsRegistry: OpsRegistry,
    resolveFn: ResolveFn,
    consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY,
  ) {
    this.resolveFn = resolveFn
    this.dispatcher = new Dispatcher(registry, cache, opsRegistry, resolveFn, consistency)
  }

  async resolve(path: string, _follow = true): Promise<[Resource, PathSpec, MountMode]> {
    return this.resolveFn(path)
  }

  get dispatch(): DispatchFn {
    return this.dispatcher.dispatch
  }

  async applyIo(io: IOResult): Promise<void> {
    await this.dispatcher.applyIo(io)
  }

  async invalidateAfterWriteByPath(path: string): Promise<void> {
    await this.dispatcher.invalidateAfterWriteByPath(path)
  }
}
