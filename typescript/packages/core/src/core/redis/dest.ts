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
import { eexist, enoent, enotdir } from '../../utils/errors.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { ancestors } from '../../utils/path.ts'
import type { RedisStoreLike } from '../../resource/redis/store.ts'

// Reject a destination whose parent chain is not all directories. Mirrors how
// rename(2) resolves the destination: a component that does not exist is
// ENOENT, a component that is a plain file is ENOTDIR (at any depth). Without
// this the store grows a key under a directory it never recorded, and that
// orphan makes both the phantom directory and its real parent unlistable.
// Shared by every op that places a key at a caller-supplied path (rename,
// copy, create, write, append, mkdir): none of them creates parents (that is
// `mkdir -p`), so all owe the destination the same probe. The real-filesystem
// backends get this from the kernel.
//
// Components are probed one at a time rather than by pulling the whole
// directory set: this runs on every write, so a set membership test per
// component (O(1), and a path is only a few components deep) beats
// transferring every directory in the mount.
export async function checkDestParents(
  store: RedisStoreLike,
  dst: PathSpec,
  d: string,
): Promise<void> {
  for (const ancestor of ancestors(d)) {
    if (await store.hasDir(ancestor)) continue
    if (await store.hasFile(ancestor)) throw enotdir(dst)
    throw enoent(dst)
  }
}

// Reject a `mkdir` the store cannot satisfy. The companion of
// checkDestParents for the one op that may create its own parents, and the two
// flag modes fail differently because GNU implements them differently:
//
//   * Plain mkdir issues one mkdir(2) on the whole path, so an existing target
//     is EEXIST whichever kind it is. Its parent chain stays checkDestParents'
//     job, which reports the operand because that is what the kernel resolves.
//   * mkdir -p walks the chain itself, creating as it goes, so it reports the
//     *component* it tripped on rather than the operand: `mkdir -p a.txt/sub`
//     is "cannot create directory 'a.txt': Not a directory". Reaching the
//     target itself as a plain file is EEXIST, not ENOTDIR. An existing
//     directory anywhere in the chain is success, which is what makes -p
//     idempotent.
//
// Without this a store has no kernel to refuse a directory key that collides
// with a file key: -p added it anyway, the directory shadowed the file, and
// reading it started reporting EISDIR while the bytes stayed orphaned in the
// store. Pinned against GNU coreutils in docker.
export async function checkMkdirTarget(
  store: RedisStoreLike,
  spec: PathSpec,
  key: string,
  parents: boolean,
): Promise<void> {
  if (!parents) {
    if ((await store.hasDir(key)) || (await store.hasFile(key))) throw eexist(spec)
    return
  }
  for (const component of [...ancestors(key), key]) {
    if (!(await store.hasFile(component))) continue
    const named = mountedPath(spec, component)
    throw component === key ? eexist(named) : enotdir(named)
  }
}
