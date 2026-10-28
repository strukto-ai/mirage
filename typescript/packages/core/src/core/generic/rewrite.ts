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
import { FileType, type FileStat, type PathSpec, type StatFn } from '../../types.ts'
import { CHUNK_SIZE, chunks } from '../../io/cooperative.ts'
import { ByteSpool } from '../../io/spool.ts'
import type { ByteSource } from '../../io/types.ts'

export type ReadFn = (path: PathSpec) => Promise<Uint8Array>
export type WriteFn<Written = unknown> = (path: PathSpec, data: Uint8Array) => Promise<Written>

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
export async function appendByRewrite<Written>(
  read: ReadFn,
  write: WriteFn<Written>,
  stat: StatFn,
  path: PathSpec,
  data: Uint8Array,
): Promise<Written | undefined> {
  if (data.length === 0) {
    let found: FileStat
    try {
      found = await stat(path)
    } catch (error) {
      if (!isMissingPath(error)) throw error
      return await runWithOwnVersion(path, OwnRead.ABSENT, () => write(path, data))
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
    return await runWithOwnVersion(path, OwnRead.ABSENT, () => write(path, data))
  }
  const joined = new Uint8Array(existing.length + data.length)
  joined.set(existing)
  joined.set(data, existing.length)
  return await runWithOwnVersion(path, own, () => write(path, joined))
}

/** Stage a read-modify-write with bounded RAM and the read's version. */
export async function appendByStreamedRewrite<Written>(
  read: (path: PathSpec, onVersion: (version: string | null) => void) => AsyncIterable<Uint8Array>,
  write: (path: PathSpec, data: ByteSource) => Promise<Written>,
  stat: StatFn,
  path: PathSpec,
  data: ByteSource,
): Promise<Written | undefined> {
  const source = chunks(data)[Symbol.asyncIterator]()
  const spool = new ByteSpool()
  try {
    const first = await source.next()
    if (first.done) {
      let found: FileStat
      try {
        found = await stat(path)
      } catch (error) {
        if (!isMissingPath(error)) throw error
        return await runWithOwnVersion(path, OwnRead.ABSENT, () => write(path, new Uint8Array()))
      }
      if (found.type === FileType.DIRECTORY) throw eisdir(path)
      return
    }
    let own: string | OwnRead | null = null
    try {
      await spool.fill(
        read(path, (version) => {
          own = version
        }),
      )
    } catch (error) {
      if (!isMissingPath(error) || spool.size > 0) throw error
      own = OwnRead.ABSENT
    }
    await spool.append(first.value)
    for (;;) {
      const part = await source.next()
      if (part.done) break
      await spool.append(part.value)
    }
    return await runWithOwnVersion(path, own, () => write(path, spool.stream()))
  } finally {
    await source.return?.()
    await spool.close()
  }
}

/**
 * Write at an offset by spooling the file and writing it back whole, its
 * head, the new bytes and its tail streamed, so memory holds a chunk at a
 * time whatever the sizes.
 *
 * A zero-length pwrite(2) on an existing file changes nothing and must not
 * read the file back: a concurrent writer's update between the stat and a
 * write would be clobbered by the stale contents. On a missing file it
 * creates an empty one. A key store answers a read of a directory's name as
 * a missing key, so a read that misses is checked against stat before
 * writing: writing there would put an object beside the directory. `read`
 * fills a spool with the whole file and answers the version the read
 * carried. Mirrors Python's `pwrite_by_streamed_rewrite`.
 */
export async function pwriteByStreamedRewrite(
  read: (path: PathSpec, spool: ByteSpool) => Promise<string | null>,
  write: (path: PathSpec, data: ByteSource) => Promise<unknown>,
  stat: StatFn,
  path: PathSpec,
  data: ByteSource,
  offset: number,
): Promise<void> {
  const source = chunks(data)[Symbol.asyncIterator]()
  const spool = new ByteSpool()
  try {
    const first = await source.next()
    if (first.done) {
      let found: FileStat
      try {
        found = await stat(path)
      } catch (error) {
        if (!isMissingPath(error)) throw error
        await runWithOwnVersion(path, OwnRead.ABSENT, () => write(path, new Uint8Array()))
        return
      }
      if (found.type === FileType.DIRECTORY) throw eisdir(path)
      return
    }
    let own: string | OwnRead | null
    try {
      own = await read(path, spool)
    } catch (error) {
      if (!isMissingPath(error) || spool.size > 0) throw error
      let missing: FileStat | null = null
      try {
        missing = await stat(path)
      } catch (statError) {
        if (!isMissingPath(statError)) throw statError
      }
      if (missing !== null && missing.type === FileType.DIRECTORY) throw eisdir(path)
      own = OwnRead.ABSENT
    }
    await runWithOwnVersion(path, own, () =>
      write(path, spliced(spool, offset, first.value, source)),
    )
  } finally {
    await source.return?.()
    await spool.close()
  }
}

/**
 * The spooled file with new bytes laid over it from `offset`: its head,
 * zeros where it ends before `offset`, the new bytes, then what it holds past
 * them. Mirrors Python's `_spliced`.
 */
async function* spliced(
  spool: ByteSpool,
  offset: number,
  first: Uint8Array,
  rest: AsyncIterator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield* spool.stream(0, offset)
  for (let at = spool.size; at < offset; at += CHUNK_SIZE)
    yield new Uint8Array(Math.min(CHUNK_SIZE, offset - at))
  let end = offset + first.byteLength
  yield first
  for (let part = await rest.next(); part.done !== true; part = await rest.next()) {
    end += part.value.byteLength
    yield part.value
  }
  yield* spool.stream(end)
}

/**
 * Resize by reading the file and writing it back padded or cut.
 *
 * For a store with no partial write. It cannot hold `noCreate` atomically,
 * so it refuses that before writing anything, as it does a negative length
 * (EINVAL). Emptying reads nothing, so its
 * write carries the version the agent read. Mirrors Python's
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
  expectOffset(length, path)
  if (length === 0) {
    await write(path, new Uint8Array(0))
    return
  }
  let data: Uint8Array
  let own: string | OwnRead | null
  try {
    ;[data, own] = await readVersioned(path, () => read(path))
  } catch (error) {
    if (!isMissingPath(error)) throw error
    data = new Uint8Array(0)
    own = OwnRead.ABSENT
  }
  const out = new Uint8Array(length)
  out.set(data.subarray(0, length))
  await runWithOwnVersion(path, own, () => write(path, out))
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
 * on a folder, Nextcloud's MKCOL 405, SFTP under `-p`), so both callers look
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
