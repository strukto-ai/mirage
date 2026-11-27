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

import { REMOTE_RACY_WINDOW_NS } from '@struktoai/mirage-core/utils/constants'
import { settled } from '@struktoai/mirage-core/utils/dates'

/**
 * A file's fingerprint, from its remote attributes: its size and the second
 * its last write landed at.
 *
 * SFTP reports whole seconds, so two same-size writes in one share both
 * numbers. A file gets none until it has `settled` for `REMOTE_RACY_WINDOW_NS`
 * by this host's clock, which holds while the server's clock drifts from this
 * one by less than that window less a second. SFTP gives no inode or change
 * time, so a rename over a same-size file written in the same second keeps
 * the token. Mirrors Python's `token_of`.
 *
 * @param size the file's size
 * @param mtime its modification time, in whole seconds
 * @param nowNs this host's wall clock, read before the request
 */
export function tokenOf(size: number | null, mtime: number | null, nowNs: bigint): string | null {
  if (size === null || mtime === null) return null
  const seconds = Math.trunc(mtime)
  if (!settled(BigInt(seconds) * 1_000_000_000n, nowNs, REMOTE_RACY_WINDOW_NS)) return null
  return `${String(size)}:${String(seconds)}`
}
