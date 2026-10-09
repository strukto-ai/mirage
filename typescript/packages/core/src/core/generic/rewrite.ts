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

import { readVersioned, runWithOwnVersion } from '../../cache/context.ts'
import { OwnRead } from '../../cache/types.ts'
import { eexist, einval, eisdir, enotsup, isEnotdir, isMissingPath } from '../../errors/fs.ts'
import { FileType, type FileStat, type PathSpec } from '../../types.ts'
import { spliceWindow } from '../../utils/ranges.ts'

export type ReadFn = (path: PathSpec) => Promise<Uint8Array>
export type WriteFn = (path: PathSpec, data: Uint8Array) => Promise<void>
export type StatFn = (path: PathSpec) => Promise<FileStat>

/**
 * Append by reading the file and writing it back whole.
 *
 * Not atomic against a concurrent writer. A zero-byte append is an open for
 * appending with nothing written after it (`cmd >> f` opens `f` before `cmd`
 * runs): it creates a missing file and leaves an existing one alone, so it
 * costs a stat rather than moving the whole object twice to add nothing, and
 * cannot put back bytes a concurrent writer had just replaced. The read takes
 * the caller's index, as every other read does: an id-addressed backend (Box,
 * Drive) turns a path into an id through it. Mirrors Python's
 * `append_by_rewrite`.
 */
export async function appendByRewrite(
  read: ReadFn,
  write: WriteFn,
  stat: StatFn,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  if (data.length === 0) {
    let found: FileStat
    try {
      found = await stat(path)
    } catch (error) {
      if (!isMissingPath(error)) throw error
      await runWithOwnVersion(path, OwnRead.ABSENT, () => write(path, data))
      return
    }
    if (found.type === FileType.DIRECTORY) throw eisdir(path)
    return
  }
  let existing: Uint8Array
  let own: string | OwnRead | null
  try {
    ;[existing, own] = await readVersioned(path, () => read(path))
  } catch (error) {
    if (!isMissingPath(error)) throw error
    await runWithOwnVersion(path, OwnRead.ABSENT, () => write(path, data))
    return
  }
  const joined = new Uint8Array(existing.length + data.length)
  joined.set(existing)
  joined.set(data, existing.length)
  await runWithOwnVersion(path, own, () => write(path, joined))
}

/**
 * Write at an offset by reading the file and writing it back whole.
 *
 * A zero-length pwrite(2) on an existing file changes nothing and must not
 * read the file back: a concurrent writer's update between the stat and a
 * write would be clobbered by the stale contents. On a missing file it
 * creates an empty one. A key store answers a read of a directory's name as
 * a missing key, so a read that misses is checked against stat before
 * writing: writing there would put an object beside the directory. Mirrors
 * Python's `pwrite_by_rewrite`.
 */
export async function pwriteByRewrite(
  read: ReadFn,
  write: WriteFn,
  stat: StatFn,
  path: PathSpec,
  data: Uint8Array,
  offset: number,
): Promise<void> {
  if (data.length === 0) {
    let found: FileStat
    try {
      found = await stat(path)
    } catch (error) {
      if (!isMissingPath(error)) throw error
      await runWithOwnVersion(path, OwnRead.ABSENT, () => write(path, data))
      return
    }
    if (found.type === FileType.DIRECTORY) throw eisdir(path)
    return
  }
  let existing: Uint8Array
  let own: string | OwnRead | null = null
  try {
    ;[existing, own] = await readVersioned(path, () => read(path))
  } catch (error) {
    if (!isMissingPath(error)) throw error
    let missing: FileStat | null = null
    try {
      missing = await stat(path)
    } catch (statError) {
      if (!isMissingPath(statError)) throw statError
    }
    if (missing !== null && missing.type === FileType.DIRECTORY) throw eisdir(path)
    existing = new Uint8Array()
    own = OwnRead.ABSENT
  }
  await runWithOwnVersion(path, own, () => write(path, spliceWindow(existing, offset, data)))
}

/**
 * Resize by reading the file and writing it back padded or cut.
 *
 * For a store with no partial write. It cannot hold `noCreate` atomically,
 * so it refuses that before writing anything. Mirrors Python's
 * `truncate_by_rewrite`.
 */
export async function truncateByRewrite(
  read: ReadFn,
  write: WriteFn,
  path: PathSpec,
  length: number,
  noCreate: boolean,
): Promise<void> {
  if (noCreate) throw enotsup('emulated', 'truncate --no-create', path)
  let data: Uint8Array
  try {
    data = await read(path)
  } catch (error) {
    if (!isMissingPath(error)) throw error
    data = new Uint8Array(0)
  }
  const out = new Uint8Array(length)
  out.set(data.subarray(0, length))
  await write(path, out)
}

/** A pwrite offset, refused with EINVAL when negative. Mirrors Python's `expect_offset`. */
export function expectOffset(offset: number, path: PathSpec): number {
  if (!Number.isInteger(offset) || offset < 0) throw einval(path)
  return offset
}

/**
 * Refuse a mkdir of a name that is taken, as mkdir(2) does.
 *
 * mkdir(2) refuses a name that exists, file or directory, and `mkdir -p`
 * passes only a directory. Not every backend's create says so (a Graph 409
 * on a folder, Nextcloud's MKCOL 405, SFTP under `-p`), so both entry points look
 * the name up before the create. A directory under `-p` still reaches the
 * create, which keeps it durable (an object store writes the marker of a
 * directory only a key implied), and a name that cannot be looked up is left
 * to it too, to answer ENOENT or ENOTDIR. Mirrors Python's `refuse_taken`.
 */
export async function refuseTaken(stat: StatFn, path: PathSpec, parents: boolean): Promise<void> {
  let row: FileStat
  try {
    row = await stat(path)
  } catch (error) {
    if (isMissingPath(error) || isEnotdir(error)) return
    throw error
  }
  if (parents && row.type === FileType.DIRECTORY) return
  throw eexist(path)
}
