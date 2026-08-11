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

import {
  type PathSpec,
  ancestors,
  eexist,
  enotdir,
  invalidateAfterWrite,
  invalidateAncestors,
  mountedPath,
  norm,
} from '@struktoai/mirage-core'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import {
  destError,
  kindAt,
  resolveDirHandle,
  resolveParentDirHandle,
  splitSegments,
} from './utils.ts'

// Reject a `mkdir` OPFS cannot satisfy, the way the store backends'
// checkMkdirTarget does. OPFS has no kernel to consult and raises the same
// TypeMismatchError whether the chain crossed a plain file or the target
// itself is one, so the chain is walked to tell GNU's two errnos apart and to
// name the component `-p` tripped on.
async function checkMkdirTarget(
  root: FileSystemDirectoryHandle,
  spec: PathSpec,
  key: string,
  parents: boolean,
): Promise<void> {
  if (!parents) {
    if ((await kindAt(root, key)) !== null) throw eexist(spec)
    return
  }
  for (const component of [...ancestors(key), key]) {
    if ((await kindAt(root, component)) !== 'file') continue
    const named = mountedPath(spec, component)
    throw component === key ? eexist(named) : enotdir(named)
  }
}

export async function mkdir(
  accessor: OPFSAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const root = accessor.rootHandle
  const virtual = path.mountPath
  const segs = splitSegments(virtual)
  if (segs.length === 0) return
  await checkMkdirTarget(root, path, norm(virtual), parents)
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
  await parentDir.getDirectoryHandle(name, { create: true })
  await invalidateAfterWrite(path)
}
