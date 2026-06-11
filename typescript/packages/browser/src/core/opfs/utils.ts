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

export { basename, norm, parent } from '@struktoai/mirage-core'

export function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  if (i < 0) return ''
  if (i === 0) return '/'
  return p.slice(0, i)
}

export function splitSegments(virtual: string): string[] {
  const parts: string[] = []
  for (const seg of virtual.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) {
        throw new Error(`path escapes root: ${virtual}`)
      }
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts
}

export async function resolveDirHandle(
  root: FileSystemDirectoryHandle,
  virtual: string,
  options: { create?: boolean } = {},
): Promise<FileSystemDirectoryHandle> {
  const segs = splitSegments(virtual)
  let handle = root
  for (const seg of segs) {
    handle = await handle.getDirectoryHandle(seg, { create: options.create ?? false })
  }
  return handle
}

export async function resolveFileHandle(
  root: FileSystemDirectoryHandle,
  virtual: string,
  options: { create?: boolean } = {},
): Promise<FileSystemFileHandle> {
  const segs = splitSegments(virtual)
  const fileName = segs.pop()
  if (fileName === undefined) {
    throw new Error(`not a file: ${virtual}`)
  }
  let dir = root
  for (const seg of segs) {
    dir = await dir.getDirectoryHandle(seg, { create: options.create ?? false })
  }
  return dir.getFileHandle(fileName, { create: options.create ?? false })
}

export async function resolveParentDirHandle(
  root: FileSystemDirectoryHandle,
  virtual: string,
  options: { create?: boolean } = {},
): Promise<[FileSystemDirectoryHandle, string]> {
  const segs = splitSegments(virtual)
  const name = segs.pop()
  if (name === undefined) {
    throw new Error(`no parent directory: ${virtual}`)
  }
  let dir = root
  for (const seg of segs) {
    dir = await dir.getDirectoryHandle(seg, { create: options.create ?? false })
  }
  return [dir, name]
}

export function isNotFound(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'NotFoundError'
  }
  return false
}

export function isTypeMismatch(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'TypeMismatchError'
  }
  return false
}

interface DirEntryIter {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}

export function toWritableChunk(data: Uint8Array): Blob {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return new Blob([copy])
}

export async function* iterEntries(
  dir: FileSystemDirectoryHandle,
): AsyncIterable<[string, FileSystemHandle]> {
  const iter = (dir as unknown as DirEntryIter).entries()
  for await (const [name, handle] of iter) {
    yield [name, handle]
  }
}
