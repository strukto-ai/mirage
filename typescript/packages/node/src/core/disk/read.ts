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
import { constants, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { record, recordStream, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import { norm } from '@struktoai/mirage-core/utils/path'
import { diskError } from './errors.ts'
import { exactName, probeName, resolveInside } from './utils.ts'

const CHUNK = 1 << 20

// How a batch opens a file it checks: never through a link, and never waiting
// on a FIFO that replaced it since.
const OPEN_CHECKED = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/**
 * Read a file, or a byte range of it, seeking rather than reading the whole
 * file.
 *
 * A null size means the rest of the file, which has no length to allocate for
 * up front, so those reads accumulate fixed chunks until the handle is spent.
 * A stated size is one positioned read.
 *
 * @param accessor the mount's disk handle
 * @param path the path to read
 * @param offset first byte to read
 * @param size how many bytes, or null for the rest
 */
export async function read(
  accessor: DiskAccessor,
  path: PathSpec,
  offset = 0,
  size: number | null = null,
): Promise<Uint8Array> {
  const timer = startOp()
  const full = await resolveInside(accessor.root, path)
  let handle
  try {
    handle = await open(full, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw enoent(path)
    }
    throw diskError(err, path)
  }
  try {
    if (size !== null) {
      const buf = Buffer.allocUnsafe(size)
      const { bytesRead } = await handle.read(buf, 0, size, offset)
      const out = new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
      record('read', path.virtual, VFSName.DISK, bytesRead, timer)
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
    record('read', path.virtual, VFSName.DISK, total, timer)
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength)
  } finally {
    await handle.close()
  }
}

/**
 * Several whole files by virtual path, each checked as its own read checks it
 * (`resolveInside`): no link on the way and every name spelled as its entry
 * is, each folder above the files proved once for the batch and each parent
 * opened once. A file is read only while it is the regular file its check
 * saw; one longer than `limit`, one that does not fit in `room` beside the
 * files read before it, and one whose check or read fails is left out for its
 * own read to meet. Each file read is recorded as a whole streamed read
 * records it. Mirrors Python's `read_many`.
 *
 * @param accessor the mount's disk handle
 * @param paths the files, all on this mount
 * @param limit the most bytes worth reading for one file
 * @param room the most bytes the files read may come to together, null for
 *   no bound
 */
export async function readMany(
  accessor: DiskAccessor,
  paths: readonly PathSpec[],
  limit: number,
  room: number | null = null,
): Promise<Map<string, Uint8Array>> {
  const opened = new Map<string, Promise<void>>()
  const folders = new Map<string, string | null>()
  const read = new Map<string, Uint8Array>()
  let total = 0
  for (const spec of paths) {
    const key = norm(spec.mountPath)
    const cut = key.lastIndexOf('/')
    const folder = key.slice(0, cut) || '/'
    const name = key.slice(cut + 1)
    let parent = folders.get(folder)
    if (parent === undefined) {
      parent = await folderInside(accessor.root, spec, folder, opened)
      folders.set(folder, parent)
    }
    const most = room === null ? limit : Math.min(limit, room - total)
    if (parent === null || name === '' || most < 0) continue
    let data: Uint8Array | null
    try {
      data = await readChecked(parent, name, most, opened)
    } catch (err) {
      console.debug(`batch read leaves ${spec.virtual} to its own read: ${String(err)}`)
      continue
    }
    if (data === null) continue
    total += data.byteLength
    const rec = recordStream('read', spec.virtual, VFSName.DISK)
    if (rec !== null) {
      rec.bytes = data.byteLength
      rec.complete = true
    }
    read.set(spec.virtual, data)
  }
  return read
}

/**
 * The host directory a batch's `folder` names, checked as a read of a file in
 * it checks it, or null when it is no directory there. Mirrors Python's
 * `_folder_inside`.
 */
async function folderInside(
  root: string,
  spec: PathSpec,
  folder: string,
  opened: Map<string, Promise<void>>,
): Promise<string | null> {
  try {
    const host = await resolveInside(root, spec, folder, opened)
    return (await stat(host)).isDirectory() ? host : null
  } catch (err) {
    console.debug(`batch read leaves ${folder} to its own read: ${String(err)}`)
    return null
  }
}

/**
 * The bytes of the regular file `name` in the checked host folder `parent`,
 * or null when it is no regular file spelled so, is longer than `most` bytes,
 * or grew past its stat while it was read. The file is opened before its name
 * is proved, so the proof is of the file that is read; a link refuses the
 * open. One read asks for the size its stat gives and one byte more, never
 * `most`, so no buffer outgrows the file; a short read of a regular file is
 * its end. Mirrors Python's `_read_checked`.
 */
async function readChecked(
  parent: string,
  name: string,
  most: number,
  opened: Map<string, Promise<void>>,
): Promise<Uint8Array | null> {
  const handle = await open(join(parent, name), OPEN_CHECKED)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > most) return null
    const buf = Buffer.allocUnsafe(info.size + 1)
    const [exact, filled] = await Promise.allSettled([
      exactName(probeName(parent, name, opened, info), info),
      handle.read(buf, 0, buf.byteLength, 0),
    ])
    if (exact.status === 'rejected') throw exact.reason
    if (filled.status === 'rejected') throw filled.reason
    if (!exact.value || filled.value.bytesRead > info.size) return null
    return new Uint8Array(buf.buffer, buf.byteOffset, filled.value.bytesRead)
  } finally {
    await handle.close()
  }
}
