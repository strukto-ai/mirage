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
import { createReadStream } from 'node:fs'
import { recordStream } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/utils/errors'
import { diskError } from './errors.ts'
import { resolveInside } from './utils.ts'

export async function* readStream(
  accessor: DiskAccessor,
  path: PathSpec,
): AsyncIterable<Uint8Array> {
  const full = await resolveInside(accessor.root, path)
  const rec = recordStream('read', path.virtual, VFSName.DISK)
  const rs = createReadStream(full, { highWaterMark: 65536 })
  try {
    for await (const chunk of rs) {
      const buf = chunk as Buffer
      const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      if (rec !== null) rec.bytes += u8.byteLength
      yield u8
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw enoent(path)
    }
    throw diskError(err, path)
  }
}
