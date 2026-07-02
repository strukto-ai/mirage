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

import { mountPrefixOf } from '@struktoai/mirage-core'
import type { PathSpec } from '@struktoai/mirage-core'
import { enotdir } from '@struktoai/mirage-core'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import { isNotFound, iterEntries, norm, resolveDirHandle } from './utils.ts'

export async function readdir(accessor: OPFSAccessor, path: PathSpec): Promise<string[]> {
  const root = accessor.rootHandle
  const virtual = path.pattern !== null ? path.directory : path.mountPath
  let dir: FileSystemDirectoryHandle
  try {
    dir = await resolveDirHandle(root, virtual, { create: false })
  } catch (err) {
    if (isNotFound(err)) throw enotdir(path)
    if (err instanceof DOMException && err.name === 'TypeMismatchError') {
      throw enotdir(path)
    }
    throw err
  }
  const names: string[] = []
  for await (const [name] of iterEntries(dir)) {
    names.push(name)
  }
  const base = norm(virtual)
  const dirPrefix = base === '/' ? '/' : `${base}/`
  const mountPrefix = mountPrefixOf(path.virtual, path.resourcePath)
  return names.map((n) => `${mountPrefix}${dirPrefix}${n}`).sort()
}
