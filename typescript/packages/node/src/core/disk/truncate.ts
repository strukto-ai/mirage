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
import { readFile, writeFile } from 'node:fs/promises'
import { type PathSpec, invalidateAfterWrite } from '@struktoai/mirage-core'
import { resolveSafe } from './utils.ts'

export async function truncate(
  accessor: DiskAccessor,
  path: PathSpec,
  length: number,
): Promise<void> {
  const full = resolveSafe(accessor.root, path.mountPath)
  let data: Buffer
  try {
    data = await readFile(full)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      data = Buffer.alloc(0)
    } else {
      throw err
    }
  }
  const out = new Uint8Array(length)
  out.set(data.subarray(0, Math.min(data.byteLength, length)))
  await writeFile(full, out)
  await invalidateAfterWrite(path)
}
