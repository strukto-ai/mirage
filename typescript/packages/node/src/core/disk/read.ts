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

import type { DiskAccessor } from '../../accessor/disk.ts'
import { open, readFile } from 'node:fs/promises'
import { enoent, type PathSpec, record, ResourceName } from '@struktoai/mirage-core'
import { resolveSafe } from './utils.ts'

const CHUNK = 1 << 20

export async function read(accessor: DiskAccessor, path: PathSpec): Promise<Uint8Array> {
  const start = performance.now()
  const virtual = path.mountPath
  const full = resolveSafe(accessor.root, virtual)
  let data: Buffer
  try {
    data = await readFile(full)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw enoent(path)
    }
    throw err
  }
  record('read', virtual, ResourceName.DISK, data.byteLength, start)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * Read a byte range, seeking rather than reading the whole file.
 *
 * A null size means the rest of the file, which has no length to allocate for
 * up front, so those reads accumulate fixed chunks until the handle is spent.
 * A stated size is one positioned read.
 *
 * @param accessor the mount's disk handle
 * @param path the path to read
 * @param _index listing cache, unused here
 * @param offset first byte to read
 * @param size how many bytes, or null for the rest
 */
export async function readRange(
  accessor: DiskAccessor,
  path: PathSpec,
  _index: unknown,
  offset: number,
  size: number | null,
): Promise<Uint8Array> {
  const start = performance.now()
  const virtual = path.mountPath
  const full = resolveSafe(accessor.root, virtual)
  let handle
  try {
    handle = await open(full, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw enoent(path)
    }
    throw err
  }
  try {
    if (size !== null) {
      const buf = Buffer.allocUnsafe(size)
      const { bytesRead } = await handle.read(buf, 0, size, offset)
      const out = new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
      record('read', virtual, ResourceName.DISK, bytesRead, start)
      return out
    }
    const parts: Buffer[] = []
    let total = 0
    let at = offset
    for (;;) {
      const buf = Buffer.allocUnsafe(CHUNK)
      const { bytesRead } = await handle.read(buf, 0, CHUNK, at)
      if (bytesRead === 0) break
      parts.push(buf.subarray(0, bytesRead))
      total += bytesRead
      at += bytesRead
    }
    const joined = Buffer.concat(parts, total)
    record('read', virtual, ResourceName.DISK, total, start)
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength)
  } finally {
    await handle.close()
  }
}
