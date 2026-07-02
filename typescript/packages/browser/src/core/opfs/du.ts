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
import { isNotFound, iterEntries, norm, resolveDirHandle, resolveParentDirHandle } from './utils.ts'

async function walkSizes(dir: FileSystemDirectoryHandle): Promise<number> {
  let total = 0
  for await (const [name, handle] of iterEntries(dir)) {
    if (handle.kind === 'file') {
      try {
        const fh = await dir.getFileHandle(name, { create: false })
        const file = await fh.getFile()
        total += file.size
      } catch {
        // ignore
      }
    } else {
      try {
        const child = await dir.getDirectoryHandle(name, { create: false })
        total += await walkSizes(child)
      } catch {
        // ignore
      }
    }
  }
  return total
}

async function walkAll(
  dir: FileSystemDirectoryHandle,
  currentPath: string,
  entries: [string, number][],
): Promise<number> {
  let total = 0
  for await (const [name, handle] of iterEntries(dir)) {
    const childPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`
    if (handle.kind === 'file') {
      try {
        const fh = await dir.getFileHandle(name, { create: false })
        const file = await fh.getFile()
        entries.push([childPath, file.size])
        total += file.size
      } catch {
        // ignore
      }
    } else {
      try {
        const child = await dir.getDirectoryHandle(name, { create: false })
        total += await walkAll(child, childPath, entries)
      } catch {
        // ignore
      }
    }
  }
  return total
}

async function sizeOfPath(root: FileSystemDirectoryHandle, virtual: string): Promise<number> {
  try {
    const [parentDir, name] = await resolveParentDirHandle(root, virtual, { create: false })
    try {
      const fh = await parentDir.getFileHandle(name, { create: false })
      const file = await fh.getFile()
      return file.size
    } catch (err) {
      if (!isNotFound(err) && !(err instanceof DOMException && err.name === 'TypeMismatchError')) {
        throw err
      }
    }
    const dir = await parentDir.getDirectoryHandle(name, { create: false })
    return await walkSizes(dir)
  } catch (err) {
    if (isNotFound(err)) return 0
    if (err instanceof Error && err.message.startsWith('no parent directory')) {
      try {
        const rootDir = await resolveDirHandle(root, virtual, { create: false })
        return await walkSizes(rootDir)
      } catch {
        return 0
      }
    }
    throw err
  }
}

export async function du(accessor: OPFSAccessor, p: PathSpec): Promise<number> {
  return sizeOfPath(accessor.rootHandle, p.mountPath)
}

export async function duAll(
  accessor: OPFSAccessor,
  p: PathSpec,
): Promise<[entries: [string, number][], total: number]> {
  const root = accessor.rootHandle
  const virtual = norm(p.mountPath)
  const entries: [string, number][] = []
  try {
    const [parentDir, name] = await resolveParentDirHandle(root, virtual, { create: false })
    try {
      const fh = await parentDir.getFileHandle(name, { create: false })
      const file = await fh.getFile()
      entries.push([virtual, file.size])
      return [entries, file.size]
    } catch (err) {
      if (!isNotFound(err) && !(err instanceof DOMException && err.name === 'TypeMismatchError')) {
        throw err
      }
    }
    const dir = await parentDir.getDirectoryHandle(name, { create: false })
    const total = await walkAll(dir, virtual, entries)
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return [entries, total]
  } catch (err) {
    if (isNotFound(err)) return [entries, 0]
    if (err instanceof Error && err.message.startsWith('no parent directory')) {
      try {
        const rootDir = await resolveDirHandle(root, virtual, { create: false })
        const total = await walkAll(rootDir, virtual, entries)
        entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        return [entries, total]
      } catch {
        return [entries, 0]
      }
    }
    throw err
  }
}
