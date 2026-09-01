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

import { record, startOp } from '../../observe/context.ts'
import type { RAMAccessor } from '../../accessor/ram.ts'
import { ResourceName, type PathSpec } from '../../types.ts'
import { norm } from './utils.ts'
import { enoent } from '../../utils/errors.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'

/**
 * Read a file, optionally only a byte range of it.
 *
 * The bytes are already in memory, so the window is a slice rather than a
 * smaller fetch. It is taken here anyway so a RAM mount answers a windowed
 * read the same way every other backend does.
 *
 * Args:
 *   accessor: RAM accessor.
 *   path: the path to read.
 *   _index: unused; the store is the listing.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export function read(
  accessor: RAMAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const offset = options?.offset ?? 0
  const size = options?.size ?? null
  const timer = startOp()
  const p = norm(path.mountPath)
  const whole = accessor.store.files.get(p)
  if (whole === undefined) {
    throw enoent(path)
  }
  const data = offset === 0 && size === null ? whole : sliceWindow(whole, offset, size)
  record('read', p, ResourceName.RAM, data.byteLength, timer)
  return Promise.resolve(data)
}
