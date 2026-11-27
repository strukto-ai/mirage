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

import type { SqlAccessor } from '../../accessor/sql.ts'
import { eisdir } from '../../errors/fs.ts'
import { record, recordStream, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { norm } from '../../utils/path.ts'
import type { SqlRow } from '../../vfs/sql/types.ts'
import { entriesNamed, MAX_PARAMS, READ_RUN_BYTES, rowsOf } from './constants.ts'
import { fillBytes, readBytes } from './data.ts'
import { type Inode, inodeOf, isDir, isFile } from './inode.ts'
import { found, namesOf, target, walk } from './path.ts'

/**
 * Read a file, optionally only a byte range of it.
 *
 * Args:
 *   accessor: Sql accessor.
 *   path: the path to read.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: SqlAccessor,
  path: PathSpec,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const timer = startOp()
  const node = found(await walk(accessor, path), path)
  if (isDir(node)) throw eisdir(path)
  const data = await readBytes(accessor, node, options?.offset ?? 0, options?.size ?? null)
  record('read', path.virtual, VFSName.SQL, data.byteLength, timer)
  return data
}

/**
 * Several whole files by virtual path, in a few queries whatever their
 * number: each folder they sit in walked once, its entries the files name in
 * one query, and the rows of the files kept in one more for each
 * `READ_RUN_BYTES` of them (`runs`), so the rows alive beside the files built
 * never pass a run. A file is kept only from what its inode says, before its
 * rows are asked for: one that is gone or no file, one longer than `limit`,
 * and one that does not fit in `room` beside the files kept before it is left
 * out for its own read to meet, and so is one whose rows come back with
 * another size than it was kept at, or with none, as when a write lands
 * between the two queries. A path named twice is kept once, and so is an
 * inode two paths reach (one moved between the folders' lookups): the later
 * path is left for its own read, so no file is answered with the size another
 * path saw. Each file read is recorded as a whole streamed read records it.
 * Mirrors Python's `read_many`.
 *
 * Args:
 *   accessor: the database.
 *   paths: the files, all on this mount.
 *   limit: the most bytes worth fetching for one file.
 *   room: the most bytes the files kept may come to together, null for no
 *     bound.
 */
export async function readMany(
  accessor: SqlAccessor,
  paths: readonly PathSpec[],
  limit: number,
  room: number | null = null,
): Promise<Map<string, Uint8Array>> {
  const folders = new Map<string, [PathSpec, string][]>()
  for (const spec of new Map(paths.map((p) => [p.virtual, p])).values()) {
    const names = namesOf(norm(spec.mountPath))
    const name = names.pop()
    if (name === undefined) continue
    const folder = '/' + names.join('/')
    const files = folders.get(folder) ?? []
    files.push([spec, name])
    folders.set(folder, files)
  }
  const kept: [PathSpec, Inode][] = []
  const inos = new Set<number>()
  let total = 0
  for (const [folder, files] of folders) {
    const node = target(await walk(accessor, folder))
    if (node === null || !isDir(node)) continue
    const entries = await inodesNamed(
      accessor,
      node.ino,
      files.map(([, name]) => name),
    )
    for (const [spec, name] of files) {
      const entry = entries.get(name)
      if (
        entry === undefined ||
        !isFile(entry) ||
        inos.has(entry.ino) ||
        entry.size > limit ||
        (room !== null && total + entry.size > room)
      ) {
        continue
      }
      total += entry.size
      inos.add(entry.ino)
      kept.push([spec, entry])
    }
  }
  const cs = await accessor.chunkSize()
  const read = new Map<string, Uint8Array>()
  for (const run of runs(kept)) {
    const rows = await rowsByIno(
      accessor,
      run.filter(([, e]) => e.size > 0).map(([, e]) => e),
      cs,
    )
    for (const [spec, entry] of run) {
      const found = rows.get(entry.ino) ?? []
      rows.delete(entry.ino)
      const changed = found.length === 0 || found.some((r) => Number(r.size ?? 0) !== entry.size)
      if (entry.size > 0 && changed) continue
      const data = fillBytes(found, cs, 0, entry.size)
      const rec = recordStream('read', spec.virtual, VFSName.SQL)
      if (rec !== null) {
        rec.bytes = data.byteLength
        rec.complete = true
      }
      read.set(spec.virtual, data)
    }
  }
  return read
}

/**
 * `kept` cut into runs whose rows one query fetches: at most `READ_RUN_BYTES`
 * of files, a longer file alone, and at most the files `MAX_PARAMS` binds at
 * two parameters a file (`rowsOf`). Mirrors Python's `_runs`.
 */
function runs(kept: readonly [PathSpec, Inode][]): [PathSpec, Inode][][] {
  const out: [PathSpec, Inode][][] = []
  let size = 0
  for (const [spec, entry] of kept) {
    const last = out[out.length - 1]
    if (
      last === undefined ||
      last.length === Math.floor(MAX_PARAMS / 2) ||
      size + entry.size > READ_RUN_BYTES
    ) {
      out.push([[spec, entry]])
      size = entry.size
    } else {
      last.push([spec, entry])
      size += entry.size
    }
  }
  return out
}

/**
 * The inode each of `names` holds in the folder `folder`, by name; a name the
 * folder does not hold is left out. Mirrors Python's `_inodes_named`.
 */
async function inodesNamed(
  accessor: SqlAccessor,
  folder: number,
  names: readonly string[],
): Promise<Map<string, Inode>> {
  const out = new Map<string, Inode>()
  const step = MAX_PARAMS - 1
  for (let at = 0; at < names.length; at += step) {
    const part = names.slice(at, at + step)
    for (const row of await accessor.query(entriesNamed(part.length), [folder, ...part])) {
      const node = inodeOf(row)
      if (node !== null) out.set(String(row.name), node)
    }
  }
  return out
}

/**
 * The `fs_data` rows of `files`, by inode, each file's only as far as the size
 * its inode gave when it was kept, and each with the size the file has as they
 * are read (`rowsOf`). Mirrors Python's `_rows_by_ino`.
 */
async function rowsByIno(
  accessor: SqlAccessor,
  files: readonly Inode[],
  cs: number,
): Promise<Map<number, SqlRow[]>> {
  const out = new Map<number, SqlRow[]>()
  const step = Math.floor(MAX_PARAMS / 2)
  for (let at = 0; at < files.length; at += step) {
    const part = files.slice(at, at + step)
    const params = part.flatMap((e) => [e.ino, Math.floor((e.size - 1) / cs)])
    for (const row of await accessor.query(rowsOf(part.length), params)) {
      const ino = Number(row.ino ?? 0)
      const list = out.get(ino) ?? []
      list.push(row)
      out.set(ino, list)
    }
  }
  return out
}
