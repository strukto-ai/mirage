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
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import { iterEntries, kindAt, resolveDirHandle, resolveFileHandle } from './utils.ts'

/** The bytes of every file under `dir`. */
async function bytesUnder(dir: FileSystemDirectoryHandle): Promise<number> {
  let total = 0
  for await (const [name, handle] of iterEntries(dir)) {
    total +=
      handle.kind === 'file'
        ? (await (await dir.getFileHandle(name)).getFile()).size
        : await bytesUnder(await dir.getDirectoryHandle(name))
  }
  return total
}

/** The bytes at `path`, a directory's whole subtree included; 0 for none.
 * Mirrors the disk backend's `sizeOf`. */
export async function sizeOf(accessor: OPFSAccessor, path: PathSpec): Promise<number> {
  const root = await accessor.root()
  const key = path.mountPath
  const kind = key === '/' || key === '' ? 'dir' : await kindAt(root, key)
  if (kind === 'file') return (await (await resolveFileHandle(root, key)).getFile()).size
  if (kind === 'dir') return bytesUnder(await resolveDirHandle(root, key))
  return 0
}

/** The bytes the whole mount root holds. */
export async function count(accessor: OPFSAccessor): Promise<number> {
  return bytesUnder(await accessor.root())
}
