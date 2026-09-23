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

import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent, enotdir } from '@struktoai/mirage-core/utils/errors'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import { isNotFound, isTypeMismatch, iterEntries, norm, resolveDirHandle } from './utils.ts'

export async function readdir(accessor: OPFSAccessor, path: PathSpec): Promise<string[]> {
  const root = accessor.rootHandle
  // A pattern spec addresses the directory whose entries the glob filters,
  // and the rest of this function works in mount-relative space, so the
  // directory has to be read off `dir` rather than off the virtual
  // `directory` string (python strips the prefix by hand for the same
  // reason).
  const virtual = (path.pattern !== null ? path.dir : path).mountPath
  let dir: FileSystemDirectoryHandle
  try {
    dir = await resolveDirHandle(root, virtual, { create: false })
  } catch (err) {
    // OPFS already separates the two cases the way the kernel does: a missing
    // component is NotFoundError (ENOENT), a component that exists but is a
    // file is TypeMismatchError (ENOTDIR). Keep the split instead of
    // collapsing both into one errno.
    if (isNotFound(err)) throw enoent(path)
    if (isTypeMismatch(err)) throw enotdir(path)
    throw err
  }
  const names: string[] = []
  for await (const [name] of iterEntries(dir)) {
    names.push(name)
  }
  const base = norm(virtual)
  const dirPrefix = base === '/' ? '/' : `${base}/`
  const mountPrefix = mountPrefixOf(path.virtual, path.vfsPath)
  return names.map((n) => `${mountPrefix}${dirPrefix}${n}`).sort(compareCodePoints)
}
