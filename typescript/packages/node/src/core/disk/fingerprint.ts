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

import type { BigIntStats } from 'node:fs'
import { settled } from '@struktoai/mirage-core/utils/dates'

/**
 * An entry's fingerprint, from its stat: a file's bytes, or the names a
 * folder lists.
 *
 * Every write to a file and every add, rename or remove inside a folder moves
 * the entry's change time, so the stat covers both. The inode and device catch
 * an entry made again or a filesystem mounted over it; the mtime covers a
 * platform whose ctime is a creation time. An entry that has not `settled`
 * gets none, since a second change within one timestamp tick would leave every
 * one of those numbers where it was. Mirrors Python's `token_of`.
 *
 * @param st - the entry's bigint stat, links followed.
 * @param nowNs - the wall clock, read before the stat.
 * @returns `dev:ino:ctimeNs:mtimeNs`, or null while the entry is settling.
 */
export function tokenOf(st: BigIntStats, nowNs: bigint): string | null {
  const changed = st.ctimeNs > st.mtimeNs ? st.ctimeNs : st.mtimeNs
  if (!settled(changed, nowNs)) return null
  return `${String(st.dev)}:${String(st.ino)}:${String(st.ctimeNs)}:${String(st.mtimeNs)}`
}
