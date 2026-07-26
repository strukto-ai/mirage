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

import { ancestors, enoent, enotdir, type PathSpec } from '@struktoai/mirage-core'
import type { RedisStore } from '../../resource/redis/store.ts'

// Reject a destination whose parent chain is not all directories. Mirrors how
// rename(2) resolves the destination: a component that does not exist is
// ENOENT, a component that is a plain file is ENOTDIR (at any depth). Without
// this the store grows a key under a directory it never recorded, and that
// orphan makes both the phantom directory and its real parent unlistable. The
// directory set is read once so a deep destination costs one round trip, not
// one per component. Shared by rename and copy: neither creates parents (that
// is `mkdir -p`), so both owe the destination the same probe.
export async function checkDestParents(store: RedisStore, dst: PathSpec, d: string): Promise<void> {
  const chain = ancestors(d)
  if (chain.length === 0) return
  const dirs = await store.listDirs()
  for (const ancestor of chain) {
    if (dirs.has(ancestor)) continue
    if (await store.hasFile(ancestor)) throw enotdir(dst)
    throw enoent(dst)
  }
}
