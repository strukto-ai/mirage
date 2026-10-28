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

import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { readEntries, resolveInside } from './utils.ts'

/** The bytes of the regular files at or under `host`; 0 for none. */
async function bytesUnder(host: string): Promise<number> {
  let info
  try {
    info = await lstat(host)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
  if (!info.isDirectory()) return info.isFile() ? info.size : 0
  let total = 0
  let entries
  try {
    entries = await readEntries(host)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
  for (const entry of entries) total += await bytesUnder(path.join(host, entry.name))
  return total
}

/** The bytes at `path`, a directory's whole subtree included. Mirrors
 * Python's `size_of`. */
export async function sizeOf(accessor: DiskAccessor, spec: PathSpec): Promise<number> {
  return bytesUnder(await resolveInside(accessor.root, spec))
}

/** The bytes the whole mount root holds. Mirrors Python's `count`. */
export function count(accessor: DiskAccessor): Promise<number> {
  return bytesUnder(accessor.root)
}
