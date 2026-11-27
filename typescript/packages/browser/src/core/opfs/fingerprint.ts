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

import { settled } from '@struktoai/mirage-core/utils/dates'

/**
 * A file's fingerprint, from its OPFS snapshot: its size and the millisecond
 * its last write landed at.
 *
 * OPFS keeps no time finer than a millisecond, so two same-size writes in one
 * would share both numbers. A file that has not `settled` gets none, as a disk
 * entry inside its racy window does; once it is older, any later write lands
 * on a later millisecond.
 *
 * @param file the file as `getFile()` handed it
 * @param nowNs the wall clock, read before `getFile()`
 * @returns `size:lastModified`, or null while the file is still settling
 */
export function tokenOf(file: File, nowNs: bigint): string | null {
  if (!settled(BigInt(file.lastModified) * 1_000_000n, nowNs)) return null
  return `${String(file.size)}:${String(file.lastModified)}`
}
