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
import type { PathSpec } from '../../types.ts'
import { stripMount } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import type { MountRegistry } from './registry.ts'

// Serial numbers for resources that declare no storageId, keyed on the
// object so one instance mounted at two prefixes gets one identity.
// Browser resources implement Resource directly instead of extending
// BaseResource, so they have no storageId; keying on the mount prefix
// would hand one object two identities and let a self-move through.
const OBJECT_IDS = new WeakMap<Resource, number>()
let objectIdCounter = 0

export function resourceStorageId(resource: Resource): string {
  const declared = resource.storageId?.()
  if (declared !== undefined) return declared
  let serial = OBJECT_IDS.get(resource)
  if (serial === undefined) {
    serial = ++objectIdCounter
    OBJECT_IDS.set(resource, serial)
  }
  return `resource:${String(serial)}`
}

/**
 * Build the transfer generics' identity function for a mount set.
 *
 * `cp` and `mv` compare two operands to decide whether they name the same
 * file. Within one mount the mount-relative path answers that, but across
 * mounts it does not: two prefixes can address one store, and there a move
 * would copy an object over itself and then unlink the source.
 *
 * The resource's storage id and the mount-relative path are joined into
 * one path-like string rather than kept as separate components, so nested
 * backings collapse onto the same key. Two disk mounts rooted at
 * `/srv/data` and `/srv/data/sub` make `/a/sub/x` and `/b/x` the same
 * file, and both render as `disk:/srv/data/sub/x`. A delimiter between
 * the two parts would keep them apart and let the move through.
 *
 * The mount-relative path keeps its leading slash so the generics'
 * `startsWith(key + '/')` containment test still marks a directory as an
 * ancestor of its children, and only within one storage.
 */
export function makeStorageKey(registry: MountRegistry): (path: PathSpec) => string {
  return (path: PathSpec): string => {
    const entry = registry.tryMountFor(path.virtual)
    if (entry === null) {
      // Outside every mount there is no storage to name, so fall back to
      // the path itself; such an operand fails on its own when the
      // command tries to read it.
      return rstripSlash(path.virtual)
    }
    const rel = rstripSlash(stripMount(path.virtual, rstripSlash(entry.prefix)))
    return resourceStorageId(entry.resource) + rel
  }
}
