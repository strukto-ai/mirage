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

import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { ResourceName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { eisdir, enoent } from '@struktoai/mirage-core/utils/errors'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import { isNotFound, resolveFileHandle } from './utils.ts'

/**
 * Read a file, optionally only a byte range of it.
 *
 * `File` is a `Blob`, so `slice` bounds the window without materializing the
 * whole file: only the sliced bytes are read off the origin-private store.
 * `slice`'s end is exclusive, and it clamps past EOF rather than throwing,
 * which is the POSIX answer the ops factory expects.
 *
 * Args:
 *   accessor: OPFS accessor.
 *   path: the path to read.
 *   _index: unused; OPFS resolves the handle from the path itself.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: OPFSAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const offset = options?.offset ?? 0
  const size = options?.size ?? null
  const root = accessor.rootHandle
  const timer = startOp()
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
  const window =
    offset === 0 && size === null
      ? file
      : file.slice(offset, size === null ? undefined : offset + size)
  const bytes = new Uint8Array(await window.arrayBuffer())
  record('read', virtual, ResourceName.OPFS, bytes.byteLength, timer)
  return bytes
}
