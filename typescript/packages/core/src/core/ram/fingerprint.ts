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

import type { RAMStore } from '../../vfs/ram/store.ts'

/**
 * A file's fingerprint: the time its last write landed at, to the nanosecond,
 * null for a file no write dated.
 *
 * Every write lands past the time the store gave the write before
 * (`RAMStore.stamped`), so a rewrite always moves it, a same-size one in the
 * same instant included. A time set by hand (`touch -d`, `touch -r`) can be
 * one the file had before, so the stamp the store gave that set
 * (`timesSetAt`) goes with it, and a rewrite whose time is set back to the old
 * one still moves the fingerprint. Mirrors Python's `token_of`.
 *
 * @param store the mount's store
 * @param p the file's normalized key
 */
export function tokenOf(store: RAMStore, p: string): string | null {
  const modified = store.modified.get(p)
  if (modified === undefined) return null
  const setAt = store.attrs.get(p)?.timesSetAt
  return setAt === undefined ? modified : `${modified}~${setAt}`
}
