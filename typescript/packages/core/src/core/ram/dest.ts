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

import type { RAMAccessor } from '../../accessor/ram.ts'
import type { PathSpec } from '../../types.ts'
import { ancestors } from '../../utils/path.ts'
import { enoent, enotdir } from '../../utils/errors.ts'

// Reject a destination whose parent chain is not all directories. Mirrors how
// rename(2) resolves the destination: a component that does not exist is
// ENOENT, a component that is a plain file is ENOTDIR (at any depth). Without
// this the store grows a key under a directory it never recorded, and that
// orphan makes both the phantom directory and its real parent unlistable.
// Shared by every op that places a key at a caller-supplied path (rename,
// copy, write, append, mkdir; create routes through write): none of them
// creates parents (that is `mkdir -p`), so all owe the destination the same
// probe. The real-filesystem backends get this from the kernel.
export function checkDestParents(accessor: RAMAccessor, dst: PathSpec, d: string): void {
  for (const ancestor of ancestors(d)) {
    if (accessor.store.dirs.has(ancestor)) continue
    if (accessor.store.files.has(ancestor)) throw enotdir(dst)
    throw enoent(dst)
  }
}
