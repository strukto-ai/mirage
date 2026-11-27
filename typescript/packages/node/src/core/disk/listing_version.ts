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

import { stat as fsStat } from 'node:fs/promises'
import { tokenOf } from './fingerprint.ts'

/**
 * Stat a host folder and return its listing version: its fingerprint, see
 * `tokenOf`.
 *
 * @param path - the host folder, already checked by `resolveInside`.
 * @param nowNs - the wall clock, read before this call.
 */
export async function folderVersion(path: string, nowNs: bigint): Promise<string | null> {
  return tokenOf(await fsStat(path, { bigint: true }), nowNs)
}
