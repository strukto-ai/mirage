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

import { activeRecorder, recordStream } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import { openError, resolveFileHandle } from './utils.ts'

export async function* readStream(
  accessor: OPFSAccessor,
  path: PathSpec,
): AsyncIterable<Uint8Array> {
  const recorder = activeRecorder()
  const root = await accessor.root()
  const key = path.mountPath
  let handle: FileSystemFileHandle
  try {
    handle = await resolveFileHandle(root, key, { create: false })
  } catch (err) {
    // One TypeMismatchError for a directory at the leaf (EISDIR) and for a
    // plain file in the chain (ENOTDIR); openError tells them apart.
    throw await openError(root, key, err, path)
  }
  const file = await handle.getFile()
  const rec = recordStream('read', path.virtual, VFSName.OPFS, {}, recorder)
  const reader = file.stream().getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (rec !== null) rec.bytes += value.byteLength
    yield value
  }
}
