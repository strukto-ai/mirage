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

import { enoent, enotdir, type PathSpec } from '@struktoai/mirage-core'

export { norm, parent, gnuBasename as basename } from '@struktoai/mirage-core'

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

// `create` applies to the named file only, never to its parents: that is
// what O_CREAT means, and OPFS would otherwise build the whole chain on
// demand (a silent `mkdir -p`) where GNU reports ENOENT. A missing parent
// surfaces as NotFoundError and a plain-file component as TypeMismatchError,
// which the callers map to ENOENT/ENOTDIR against the operand.
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
    dir = await dir.getDirectoryHandle(seg, { create: false })
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

// Translate a handle-resolution failure on a write target into the errno the
// command layer reports. OPFS raises NotFoundError for a missing component
// and TypeMismatchError for one that is a plain file, which are exactly
// rename(2)'s ENOENT and ENOTDIR. Anything else is a real fault and is
// rethrown untouched.
export function destError(err: unknown, spec: PathSpec): unknown {
  if (isNotFound(err)) return enoent(spec)
  if (isTypeMismatch(err)) return enotdir(spec)
  return err
}

// What lives at a mount-local key: 'file', 'dir', or null when nothing does.
// OPFS raises the same TypeMismatchError whichever kind is in the way, so a
// chain walk that has to tell GNU's two errnos apart can only get the split by
// trying both handle kinds.
export async function kindAt(
  root: FileSystemDirectoryHandle,
  key: string,
): Promise<'file' | 'dir' | null> {
  let dir: FileSystemDirectoryHandle
  let name: string
  try {
    ;[dir, name] = await resolveParentDirHandle(root, key, { create: false })
  } catch {
    return null
  }
  try {
    await dir.getDirectoryHandle(name, { create: false })
    return 'dir'
  } catch (err) {
    if (!isNotFound(err) && !isTypeMismatch(err)) throw err
  }
  try {
    await dir.getFileHandle(name, { create: false })
    return 'file'
  } catch (err) {
    if (!isNotFound(err) && !isTypeMismatch(err)) throw err
  }
  return null
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
