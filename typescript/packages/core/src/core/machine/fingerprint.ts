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

import { settled } from '../../utils/dates.ts'
import type { PosixEntry } from '../posix/types.ts'

/**
 * An entry's fingerprint, from what find printed for it: its size and the
 * millisecond its last change landed at.
 *
 * Two same-size writes in one millisecond share both numbers, so an entry that
 * has not `settled` by this host's clock when find was asked gets none, which
 * takes the machine's clock to agree with this one within the racy window.
 * Mirrors Python's `token_of`.
 *
 * @param entry the entry, with the time find was asked
 */
export function tokenOf(entry: PosixEntry): string | null {
  if (!settled(BigInt(entry.mtimeMs) * 1_000_000n, entry.askedNs ?? 0n)) return null
  return `${String(entry.size)}:${String(entry.mtimeMs)}`
}
