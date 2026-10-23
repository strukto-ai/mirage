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
import { open } from 'node:fs/promises'
import { recordStream } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import { diskError } from './errors.ts'
import { resolveInside } from './utils.ts'

export async function* readStream(
  accessor: DiskAccessor,
  path: PathSpec,
): AsyncIterable<Uint8Array> {
  const full = await resolveInside(accessor.root, path)
  const rec = recordStream('read', path.virtual, VFSName.DISK)
  const failed = (err: unknown): unknown =>
    (err as NodeJS.ErrnoException).code === 'ENOENT' ? enoent(path) : diskError(err, path)
  // node:fs/promises, never the CommonJS fs a JS runtime's patch may route
  // back into the workspace this mount serves.
  const handle = await open(full, 'r').catch((err: unknown) => {
    throw failed(err)
  })
  try {
    for (;;) {
      const { bytesRead, buffer } = await handle
        .read(new Uint8Array(65536), 0, 65536, null)
        .catch((err: unknown) => {
          throw failed(err)
        })
      if (bytesRead === 0) return
      if (rec !== null) rec.bytes += bytesRead
      yield buffer.subarray(0, bytesRead)
    }
  } finally {
    await handle.close()
  }
}
