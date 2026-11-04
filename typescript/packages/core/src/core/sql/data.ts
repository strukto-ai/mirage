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
import type { SqlStatement, SqlValue } from '../../vfs/sql/types.ts'
import { SQL } from './constants.ts'
import { byIno, insertRows, type Inode, type InoRef } from './inode.ts'

function bytesOf(value: SqlValue | undefined): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(0)
}

/**
 * The bytes `[offset, offset + length)` of `node`, cut at its size; a row the
 * file never wrote, or one shorter than the chunk size, reads as zeros, as a
 * sparse file does. Mirrors Python's `read_bytes`.
 */
export async function readBytes(
  accessor: SqlAccessor,
  node: Inode,
  offset = 0,
  length: number | null = null,
): Promise<Uint8Array> {
  const stop = length === null ? node.size : Math.min(offset + length, node.size)
  if (stop <= offset) return new Uint8Array(0)
  const cs = await accessor.chunkSize()
  const out = new Uint8Array(stop - offset)
  const rows = await accessor.query(SQL.chunks, [
    node.ino,
    Math.floor(offset / cs),
    Math.floor((stop - 1) / cs),
  ])
  for (const row of rows) {
    const base = Number(row.chunk_index) * cs
    const data = bytesOf(row.data)
    const from = Math.max(base, offset)
    const to = Math.min(base + data.byteLength, stop)
    if (to > from) out.set(data.subarray(from - base, to - base), from - offset)
  }
  return out
}

/**
 * The statements that put `data` at `offset` of a file of `size` bytes: its
 * rows from the one `offset` falls in to the one the end falls in, rewritten
 * whole. The first and last of them keep the bytes outside `data` they held,
 * read first, so only those two rows are read whatever `data` spans. `node`
 * is the file when it has rows; a file a statement earlier in the batch makes
 * has none. Mirrors Python's `place_bytes`.
 */
export async function placeBytes(
  accessor: SqlAccessor,
  ino: InoRef,
  node: Inode | null,
  offset: number,
  data: Uint8Array,
): Promise<SqlStatement[]> {
  if (data.byteLength === 0) return []
  const cs = await accessor.chunkSize()
  const size = node?.size ?? 0
  const end = offset + data.byteLength
  const first = Math.floor(offset / cs)
  const last = Math.floor((end - 1) / cs)
  const start = first * cs
  const region = new Uint8Array(Math.min((last + 1) * cs, Math.max(end, size)) - start)
  const out: SqlStatement[] = []
  if (node !== null) {
    const keepHead = offset > start && size > start
    const keepTail = start + region.byteLength > end
    if (keepHead || keepTail) {
      const edges = [...new Set([keepHead ? first : last, keepTail ? last : first])]
      const rows = await accessor.query(
        `SELECT chunk_index, data FROM fs_data WHERE ino = ? AND chunk_index IN (${edges.map(() => '?').join(', ')})`,
        [node.ino, ...edges],
      )
      for (const row of rows) {
        const at = (Number(row.chunk_index) - first) * cs
        region.set(bytesOf(row.data).subarray(0, region.byteLength - at), at)
      }
    }
    out.push({
      sql: `DELETE FROM fs_data WHERE ino = ${byIno(node.ino).sql} AND chunk_index >= ? AND chunk_index <= ?`,
      params: [first, last],
    })
  }
  region.set(data, offset - start)
  const rows: SqlValue[][] = []
  for (let i = first; i <= last; i++) {
    const at = (i - first) * cs
    rows.push([...ino.params, i, region.subarray(at, Math.min(at + cs, region.byteLength))])
  }
  out.push(
    ...insertRows('INSERT INTO fs_data (ino, chunk_index, data)', `(${ino.sql}, ?, ?)`, rows),
  )
  return out
}

/**
 * The statements that cut `node`'s rows to `length` bytes: rows past it go,
 * and the one it ends in keeps only its head, so bytes cut now never read back
 * after the file grows again. Growing writes nothing; the size alone pads.
 * Mirrors Python's `cut_bytes`.
 */
export async function cutBytes(
  accessor: SqlAccessor,
  node: Inode,
  length: number,
): Promise<SqlStatement[]> {
  if (length >= node.size) return []
  const cs = await accessor.chunkSize()
  const ino = byIno(node.ino)
  const keep = Math.ceil(length / cs)
  const out: SqlStatement[] = [
    { sql: `DELETE FROM fs_data WHERE ino = ${ino.sql} AND chunk_index >= ?`, params: [keep] },
  ]
  const tail = length % cs
  if (tail === 0) return out
  const row = (await accessor.query(SQL.chunks, [node.ino, keep - 1, keep - 1]))[0]
  const data = bytesOf(row?.data)
  if (data.byteLength <= tail) return out
  out.push(
    { sql: `DELETE FROM fs_data WHERE ino = ${ino.sql} AND chunk_index = ?`, params: [keep - 1] },
    {
      sql: `INSERT INTO fs_data (ino, chunk_index, data) VALUES (${ino.sql}, ?, ?)`,
      params: [keep - 1, data.slice(0, tail)],
    },
  )
  return out
}
