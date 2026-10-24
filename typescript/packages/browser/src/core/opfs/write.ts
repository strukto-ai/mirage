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

import { chunks } from '@struktoai/mirage-core/io/cooperative'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import { openError, resolveFileHandle, toWritableChunk } from './utils.ts'

export async function write(
  accessor: OPFSAccessor,
  p: PathSpec,
  data: ByteSource,
  signal?: AbortSignal,
): Promise<void> {
  const root = await accessor.root()
  const timer = startOp()
  const key = p.mountPath
  let handle: FileSystemFileHandle
  try {
    handle = await resolveFileHandle(root, key, { create: true })
  } catch (err) {
    throw await openError(root, key, err, p)
  }
  const writable = await handle.createWritable()
  let size = 0
  try {
    for await (const part of chunks(data, signal)) {
      await writable.write(toWritableChunk(part))
      size += part.length
    }
    await writable.close()
  } catch (error) {
    await writable.abort().catch((cleanup: unknown) => {
      console.debug('Could not abort OPFS write', cleanup)
    })
    throw error
  }
  record('write', p.virtual, VFSName.OPFS, size, timer)
}
