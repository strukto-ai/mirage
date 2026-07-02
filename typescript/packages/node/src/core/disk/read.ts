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

import type { DiskAccessor } from '../../accessor/disk.ts'
import { readFile } from 'node:fs/promises'
import { enoent, type PathSpec, record, ResourceName } from '@struktoai/mirage-core'
import { resolveSafe } from './utils.ts'

export async function read(accessor: DiskAccessor, path: PathSpec): Promise<Uint8Array> {
  const start = performance.now()
  const virtual = path.mountPath
  const full = resolveSafe(accessor.root, virtual)
  let data: Buffer
  try {
    data = await readFile(full)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw enoent(path)
    }
    throw err
  }
  record('read', virtual, ResourceName.DISK, data.byteLength, start)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
