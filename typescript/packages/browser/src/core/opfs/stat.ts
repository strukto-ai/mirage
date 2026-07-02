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

import { FileStat, FileType, guessType, type PathSpec } from '@struktoai/mirage-core'
import { enoent } from '@struktoai/mirage-core'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import {
  isNotFound,
  iterEntries,
  resolveDirHandle,
  resolveParentDirHandle,
  splitSegments,
} from './utils.ts'

export async function stat(accessor: OPFSAccessor, p: PathSpec): Promise<FileStat> {
  const root = accessor.rootHandle
  const virtual = p.mountPath
  const segs = splitSegments(virtual)
  const last = segs.at(-1)
  if (last === undefined) {
    return new FileStat({
      name: '/',
      size: null,
      modified: null,
      type: FileType.DIRECTORY,
    })
  }
  const name = last
  let parentDir: FileSystemDirectoryHandle
  let entryName: string
  try {
    ;[parentDir, entryName] = await resolveParentDirHandle(root, virtual, { create: false })
  } catch (err) {
    if (isNotFound(err)) throw enoent(p)
    throw err
  }
  try {
    const fileHandle = await parentDir.getFileHandle(entryName, { create: false })
    const file = await fileHandle.getFile()
    const modified = new Date(file.lastModified).toISOString()
    return new FileStat({
      name,
      size: file.size,
      modified,
      fingerprint: modified,
      type: guessType(name),
    })
  } catch (err) {
    if (!isNotFound(err) && !(err instanceof DOMException && err.name === 'TypeMismatchError')) {
      throw err
    }
  }
  let dirHandle: FileSystemDirectoryHandle
  try {
    dirHandle = await resolveDirHandle(root, virtual, { create: false })
  } catch (err) {
    if (isNotFound(err)) throw enoent(p)
    throw err
  }
  // OPFS exposes no directory timestamp, so derive one from the newest file
  // child's lastModified (null when the directory holds no files).
  let latest = 0
  for await (const [, handle] of iterEntries(dirHandle)) {
    if (handle.kind !== 'file') continue
    const file = await (handle as FileSystemFileHandle).getFile()
    if (file.lastModified > latest) latest = file.lastModified
  }
  return new FileStat({
    name,
    size: null,
    modified: latest > 0 ? new Date(latest).toISOString() : null,
    type: FileType.DIRECTORY,
  })
}
