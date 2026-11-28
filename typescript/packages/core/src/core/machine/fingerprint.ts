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

import { REMOTE_RACY_WINDOW_NS } from '../../utils/constants.ts'
import { settled } from '../../utils/dates.ts'
import type { PosixEntry } from '../posix/types.ts'

/**
 * An entry's fingerprint, from what find printed for it: the machine holding
 * it, its size and the millisecond its last change landed at.
 *
 * Two same-size writes in one millisecond share both numbers, so an entry gets
 * none until it has `settled` for `REMOTE_RACY_WINDOW_NS` by this host's clock
 * when find was asked, which holds while the machine's clock drifts from this
 * one by less than that window. The machine is named, so a copy of the path
 * another machine holds is never taken for the one recorded. A copy that keeps
 * the time of the file it replaces (`cp -p` of a same-size file written in the
 * same millisecond) keeps the token. Mirrors Python's `token_of`.
 *
 * @param entry the entry, with the time find was asked
 * @param machine the machine holding it
 */
export function tokenOf(entry: PosixEntry, machine: string): string | null {
  const changed = BigInt(entry.mtimeMs) * 1_000_000n
  if (!settled(changed, entry.askedNs ?? 0n, REMOTE_RACY_WINDOW_NS)) return null
  return `${machine}:${String(entry.size)}:${String(entry.mtimeMs)}`
}
