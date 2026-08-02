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

import type { PathSpec } from '../../types.ts'
import { stripMount } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import type { MountRegistry } from './registry.ts'

/**
 * Build the transfer generics' identity function for a mount set.
 *
 * `cp` and `mv` compare two operands to decide whether they name the same
 * file. Within one mount the mount-relative path answers that, but across
 * mounts it does not: two prefixes can address one store (two disk mounts
 * on a shared root, one bucket mounted twice, the same resource object
 * mounted at two prefixes), and there a move would copy an object over
 * itself and then unlink the source. Pairing the resource's `storageId`
 * with the mount-relative path makes the comparison about bytes rather
 * than about spelling.
 *
 * The mount-relative path keeps its leading slash so the generics'
 * `startsWith(key + '/')` containment test still marks a directory as an
 * ancestor of its children, and only within one storage.
 */
export function makeStorageKey(registry: MountRegistry): (path: PathSpec) => string {
  return (path: PathSpec): string => {
    const entry = registry.mountFor(path.virtual)
    if (entry === null) {
      // Outside every mount there is no storage to name, so fall back to
      // the path itself; such an operand fails on its own when the
      // command tries to read it.
      return rstripSlash(path.virtual)
    }
    const rel = stripMount(path.virtual, rstripSlash(entry.prefix))
    const trimmed = rstripSlash(rel)
    // A resource that declares no identity is treated as its own storage,
    // keyed by the mount prefix. That only reproduces the pre-existing
    // behavior, which is the safe direction: it can miss an alias, never
    // refuse a legitimate move.
    const id = entry.resource.storageId?.() ?? `mount:${entry.prefix}`
    return `${id}:${trimmed === '' ? '/' : trimmed}`
  }
}
