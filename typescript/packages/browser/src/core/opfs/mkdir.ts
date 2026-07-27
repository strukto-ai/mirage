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

import { type PathSpec, invalidateAfterWrite, invalidateAncestors } from '@struktoai/mirage-core'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import {
  destError,
  isNotFound,
  resolveDirHandle,
  resolveParentDirHandle,
  splitSegments,
} from './utils.ts'

export async function mkdir(
  accessor: OPFSAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const root = accessor.rootHandle
  const virtual = path.mountPath
  const segs = splitSegments(virtual)
  if (segs.length === 0) return
  if (parents) {
    await resolveDirHandle(root, virtual, { create: true })
    await invalidateAfterWrite(path)
    await invalidateAncestors(path)
    return
  }
  let parentDir: FileSystemDirectoryHandle
  let name: string
  try {
    ;[parentDir, name] = await resolveParentDirHandle(root, virtual, { create: false })
  } catch (err) {
    // A bare Error here would not be classified as a filesystem failure,
    // so the command layer could not report it with a GNU strerror.
    throw destError(err, path)
  }
  try {
    await parentDir.getDirectoryHandle(name, { create: false })
    return
  } catch (err) {
    if (!isNotFound(err)) {
      if (err instanceof DOMException && err.name === 'TypeMismatchError') {
        throw new Error(`path exists and is not a directory: ${virtual}`)
      }
      throw err
    }
  }
  await parentDir.getDirectoryHandle(name, { create: true })
}
