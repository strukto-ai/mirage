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

import type { PathSpec } from '@struktoai/mirage-core'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import {
  isNotFound,
  iterEntries,
  resolveDirHandle,
  resolveFileHandle,
  resolveParentDirHandle,
  toWritableChunk,
} from './utils.ts'

async function copyDirRecursive(
  root: FileSystemDirectoryHandle,
  srcPath: string,
  dstPath: string,
): Promise<void> {
  const srcDir = await resolveDirHandle(root, srcPath, { create: false })
  const dstDir = await resolveDirHandle(root, dstPath, { create: true })
  for await (const [name, handle] of iterEntries(srcDir)) {
    if (handle.kind === 'file') {
      const srcFile = await srcDir.getFileHandle(name, { create: false })
      const file = await srcFile.getFile()
      const data = new Uint8Array(await file.arrayBuffer())
      const dstFile = await dstDir.getFileHandle(name, { create: true })
      const writable = await dstFile.createWritable()
      await writable.write(toWritableChunk(data))
      await writable.close()
    } else {
      await copyDirRecursive(root, `${srcPath}/${name}`, `${dstPath}/${name}`)
    }
  }
}

export async function rename(accessor: OPFSAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const root = accessor.rootHandle
  const srcPath = src.mountPath
  const dstPath = dst.mountPath
  let srcParent: FileSystemDirectoryHandle
  let srcName: string
  try {
    ;[srcParent, srcName] = await resolveParentDirHandle(root, srcPath, { create: false })
  } catch (err) {
    if (isNotFound(err)) throw new Error(`file or directory not found: ${srcPath}`)
    throw err
  }
  let isFile = false
  try {
    await srcParent.getFileHandle(srcName, { create: false })
    isFile = true
  } catch (err) {
    if (!isNotFound(err) && !(err instanceof DOMException && err.name === 'TypeMismatchError')) {
      throw err
    }
  }
  if (!isFile) {
    try {
      await srcParent.getDirectoryHandle(srcName, { create: false })
    } catch (err) {
      if (isNotFound(err)) throw new Error(`file or directory not found: ${srcPath}`)
      throw err
    }
  }
  if (isFile) {
    const srcFile = await resolveFileHandle(root, srcPath, { create: false })
    const file = await srcFile.getFile()
    const data = new Uint8Array(await file.arrayBuffer())
    const dstFile = await resolveFileHandle(root, dstPath, { create: true })
    const writable = await dstFile.createWritable()
    await writable.write(toWritableChunk(data))
    await writable.close()
    await srcParent.removeEntry(srcName)
    return
  }
  await copyDirRecursive(root, srcPath, dstPath)
  await srcParent.removeEntry(srcName, { recursive: true })
}
