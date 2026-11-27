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

import { record, recordStream, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import { openError, resolveFileHandle, splitSegments } from './utils.ts'

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
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: OPFSAccessor,
  path: PathSpec,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const offset = options?.offset ?? 0
  const size = options?.size ?? null
  const root = await accessor.root()
  const timer = startOp()
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
  const window =
    offset === 0 && size === null
      ? file
      : file.slice(offset, size === null ? undefined : offset + size)
  const bytes = new Uint8Array(await window.arrayBuffer())
  record('read', path.virtual, VFSName.OPFS, bytes.byteLength, timer)
  return bytes
}

/**
 * Several whole files by virtual path, each folder handle resolved once for
 * the batch instead of once a file, from its own parent's, so folders the
 * files share are opened once too, and the files' handles taken and read
 * together. A file is kept only from the size its `File` gives, before its
 * bytes are read: one that is gone or no file, one longer than `limit`, one
 * that does not fit in `room` beside the files kept before it, and one whose
 * read fails is left out for its own read to meet. A path named twice is read
 * once. Each file read is recorded as a whole streamed read records it.
 *
 * Args:
 *   accessor: OPFS accessor.
 *   paths: the files, all on this mount.
 *   limit: the most bytes worth reading for one file.
 *   room: the most bytes the files read may come to together, null for no
 *     bound.
 */
export async function readMany(
  accessor: OPFSAccessor,
  paths: readonly PathSpec[],
  limit: number,
  room: number | null = null,
): Promise<Map<string, Uint8Array>> {
  const root = await accessor.root()
  const folders = new Map<string, Promise<FileSystemDirectoryHandle | null>>()
  const folderOf = (segs: readonly string[]): Promise<FileSystemDirectoryHandle | null> => {
    const key = '/' + segs.join('/')
    let folder = folders.get(key)
    if (folder === undefined) {
      const name = segs[segs.length - 1]
      folder =
        name === undefined
          ? Promise.resolve(root)
          : folderOf(segs.slice(0, -1))
              .then((parent) => (parent === null ? null : parent.getDirectoryHandle(name)))
              .catch((err: unknown) => {
                console.debug(`batch read leaves ${key} to its own read: ${String(err)}`)
                return null
              })
      folders.set(key, folder)
    }
    return folder
  }
  const files = [...new Map(paths.map((p) => [p.virtual, p])).values()]
  const found = await Promise.all(
    files.map(async (spec): Promise<File | null> => {
      try {
        const segs = splitSegments(spec.mountPath)
        const name = segs.pop()
        if (name === undefined) return null
        const dir = await folderOf(segs)
        return dir === null ? null : await (await dir.getFileHandle(name)).getFile()
      } catch (err) {
        console.debug(`batch read leaves ${spec.virtual} to its own read: ${String(err)}`)
        return null
      }
    }),
  )
  const kept: [PathSpec, File][] = []
  let total = 0
  files.forEach((spec, i) => {
    const file = found[i] ?? null
    if (file === null || file.size > limit || (room !== null && total + file.size > room)) return
    total += file.size
    kept.push([spec, file])
  })
  const bytes = await Promise.all(
    kept.map(async ([spec, file]): Promise<Uint8Array | null> => {
      try {
        return new Uint8Array(await file.arrayBuffer())
      } catch (err) {
        console.debug(`batch read leaves ${spec.virtual} to its own read: ${String(err)}`)
        return null
      }
    }),
  )
  const read = new Map<string, Uint8Array>()
  kept.forEach(([spec], i) => {
    const data = bytes[i] ?? null
    if (data === null) return
    const rec = recordStream('read', spec.virtual, VFSName.OPFS)
    if (rec !== null) {
      rec.bytes = data.byteLength
      rec.complete = true
    }
    read.set(spec.virtual, data)
  })
  return read
}
