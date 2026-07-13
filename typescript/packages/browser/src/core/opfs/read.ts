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

import { type PathSpec, record, ResourceName } from '@struktoai/mirage-core'
import { eisdir, enoent } from '@struktoai/mirage-core'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import { isNotFound, resolveFileHandle } from './utils.ts'

export async function read(accessor: OPFSAccessor, path: PathSpec): Promise<Uint8Array> {
  const root = accessor.rootHandle
  const start = performance.now()
  const virtual = path.mountPath
  let handle: FileSystemFileHandle
  try {
    handle = await resolveFileHandle(root, virtual, { create: false })
  } catch (err) {
    if (isNotFound(err)) throw enoent(path)
    if (err instanceof DOMException && err.name === 'TypeMismatchError') throw eisdir(path)
    throw err
  }
  const file = await handle.getFile()
  const bytes = new Uint8Array(await file.arrayBuffer())
  record('read', virtual, ResourceName.OPFS, bytes.byteLength, start)
  return bytes
}
