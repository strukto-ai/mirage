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

import { open } from 'node:fs/promises'
import { constants } from 'node:fs'

import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { diskError } from './errors.ts'
import { resolveInside } from './utils.ts'

export async function pwrite(
  accessor: DiskAccessor,
  p: PathSpec,
  data: Uint8Array,
  offset: number,
): Promise<void> {
  const timer = startOp()
  const full = await resolveInside(accessor.root, p)
  try {
    const handle = await open(full, constants.O_WRONLY | constants.O_CREAT, 0o666)
    try {
      let done = 0
      while (done < data.byteLength) {
        const { bytesWritten } = await handle.write(
          data,
          done,
          data.byteLength - done,
          offset + done,
        )
        done += bytesWritten
      }
    } finally {
      await handle.close()
    }
  } catch (err) {
    throw diskError(err, p)
  }
  record('pwrite', p.virtual, VFSName.DISK, data.byteLength, timer)
}
