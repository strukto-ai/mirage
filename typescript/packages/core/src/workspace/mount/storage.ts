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

import type { BaseVFS } from '../../vfs/base.ts'
import { enotsup, fsError } from '../../errors/fs.ts'
import { PathSpec, WritePolicy } from '../../types.ts'
import { mountKey, stripMount, underPath } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import type { SessionAccess } from '../../view/types.ts'
import type { MountRegistry } from './registry.ts'
import { writeConditions } from './write_policy.ts'

// A driver that knows where its bytes live (a disk root, a bucket and key
// prefix) says so through `storageLocation`; one that does not is its own
// location, keyed by identity, so one object mounted at two prefixes keys
// as one store rather than two. Mirrors Python's `vfs_storage_location`.
const OWN_LOCATION = new WeakMap<BaseVFS, string>()
let ownLocations = 0

export function vfsStorageLocation(vfs: BaseVFS): string {
  const location = vfs.storageLocation()
  if (location !== null) return location
  let own = OWN_LOCATION.get(vfs)
  if (own === undefined) {
    ownLocations += 1
    own = `${vfs.name}:${String(ownLocations)}`
    OWN_LOCATION.set(vfs, own)
  }
  return own
}

/**
 * Build the transfer generics' identity function for a mount set.
 *
 * `cp` and `mv` compare two operands to decide whether they name the same
 * file. Within one mount the mount-relative path answers that, but across
 * mounts it does not: two prefixes can address one store, and there a move
 * would copy an object over itself and then unlink the source.
 *
 * The VFS's storage id and the mount-relative path are joined into
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
    return vfsStorageLocation(entry.vfs) + rel
  }
}

/**
 * Refuse up front a delete a mount under the path could not condition: a
 * move across mounts copies before it deletes, and on a conditional mount
 * whose backend ignores delete conditions the delete would be refused after
 * the copy landed. The owning mount counts, and so does any mount nested
 * under the path, which the walk would cross; a mount above the owner is
 * never touched. A live pipe (a process substitution) is no file a move can
 * delete either, and copying it first would drain it, so it is refused with
 * EPERM before anything is read, as `rm` refuses it. The pipe is looked up
 * as the moving command's own session sees /dev, since a browser view bound
 * to no owner sees no pipe while sessions overlap. Mirrors Python's
 * `make_check_unlink`.
 */
export function makeCheckUnlink(
  registry: MountRegistry,
  access?: SessionAccess,
): (path: PathSpec) => void {
  return (path: PathSpec): void => {
    const owner = registry.tryMountFor(path.virtual)
    const live = owner?.livePipe(
      new PathSpec({
        virtual: path.virtual,
        directory: path.directory,
        vfsPath: mountKey(path.virtual, rstripSlash(owner.prefix)),
      }),
      access,
    )
    if (live != null) throw fsError(path, 'EPERM')
    for (const entry of registry.allMounts()) {
      if (
        entry.write === WritePolicy.CONDITIONAL &&
        (entry === owner || underPath(entry.prefix, path.virtual)) &&
        !writeConditions(entry.vfs).includes('delete')
      ) {
        throw enotsup(entry.vfs.name, 'conditional delete', path)
      }
    }
  }
}
