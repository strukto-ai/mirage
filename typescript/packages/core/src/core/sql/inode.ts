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
import { FileStat, FileType } from '../../types.ts'
import { systemDate } from '../../utils/clock.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { gnuBasename } from '../../utils/path.ts'
import type { SqlRow, SqlStatement, SqlValue } from '../../vfs/sql/types.ts'
import type { INODE_COLUMNS } from './constants.ts'
import { DIR, FILE, LAST_INO, MAX_PARAMS, SQL } from './constants.ts'

/** One `fs_inode` row. Mirrors Python's `Inode`. */
export interface Inode {
  readonly ino: number
  /** The type bits: `DIR` or `FILE`. */
  readonly mode: number
  readonly size: number
  readonly mtime: number
  readonly mtimeNsec: number
}

/** A time as `fs_inode` keeps it: whole seconds since the epoch and the nanoseconds past them. */
export type Stamp = readonly [seconds: number, nanoseconds: number]

/**
 * The inode `row` holds under column names `prefix` starts, or null when the
 * row has none (a name the walk did not find). A driver may answer a number
 * as text (Postgres BIGINT), so each is read as a number.
 */
export function inodeOf(row: SqlRow | undefined, prefix = ''): Inode | null {
  const ino = row?.[`${prefix}ino`]
  if (row === undefined || ino === null || ino === undefined) return null
  const n = (column: (typeof INODE_COLUMNS)[number]): number => Number(row[prefix + column] ?? 0)
  return {
    ino: n('ino'),
    mode: n('mode'),
    size: n('size'),
    mtime: n('mtime'),
    mtimeNsec: n('mtime_nsec'),
  }
}

export function isDir(node: Inode): boolean {
  return node.mode === DIR
}

export function isFile(node: Inode): boolean {
  return node.mode === FILE
}

/** Now, as `fs_inode` keeps a time. */
export function nowStamp(): Stamp {
  const ms = systemDate().getTime()
  const seconds = Math.floor(ms / 1000)
  return [seconds, (ms - seconds * 1000) * 1_000_000]
}

/** The stamp an ISO time names, to the nanosecond its fraction gives. */
export function stampOf(iso: string): Stamp {
  const seconds = Math.floor(Date.parse(iso) / 1000)
  const fraction = /\.(\d+)/.exec(iso)?.[1] ?? ''
  return [seconds, Number(fraction.padEnd(9, '0').slice(0, 9))]
}

/** A stamp as ISO text: whole seconds, or six fraction digits, as Python's `to_iso_z` writes it. */
export function isoOf(seconds: number, nanoseconds: number): string {
  const whole = new Date(seconds * 1000).toISOString().replace('.000Z', '')
  const micros = Math.floor(nanoseconds / 1000)
  return micros === 0 ? `${whole}Z` : `${whole}.${String(micros).padStart(6, '0')}Z`
}

/**
 * What `stat` answers for the inode at mount path `p`: its type, size and
 * mtime. The namespace overlay adds a mode, owner or atime set on the path.
 * Mirrors Python's `inode_stat`.
 */
export function inodeStat(p: string, node: Inode): FileStat {
  const common = { name: gnuBasename(p), modified: isoOf(node.mtime, node.mtimeNsec) }
  if (isDir(node)) return new FileStat({ ...common, type: FileType.DIRECTORY })
  return new FileStat({
    ...common,
    type: FileType.FILE,
    size: node.size,
    content: contentTypeForPath(p),
  })
}

/**
 * An inode as a statement names it: by number once it is known, else by the
 * entry a statement earlier in the same batch made for it.
 */
export interface InoRef {
  readonly sql: string
  readonly params: readonly SqlValue[]
}

/** The inode numbered `ino`, written into the statement: an integer the database gave. */
export function byIno(ino: number): InoRef {
  return { sql: String(Math.trunc(ino)), params: [] }
}

/** The inode the entry `name` under `parent` holds. */
export function byEntry(parent: InoRef, name: string): InoRef {
  return {
    sql: `(SELECT ino FROM fs_dentry WHERE parent_ino = ${parent.sql} AND name = ?)`,
    params: [...parent.params, name],
  }
}

/**
 * A new inode of `mode` and `size` bytes, and the entry that names it `name`
 * under `parent`, as two statements of one batch: the entry takes the number
 * the inode was just given. The parent is named through its inode, so a
 * parent another writer removed since the lookup leaves the entry no parent,
 * which its column refuses, and the batch fails whole rather than strand it.
 */
export function makeNode(
  accessor: SqlAccessor,
  parent: InoRef,
  name: string,
  mode: number,
  size: number,
  [seconds, nanoseconds]: Stamp,
): SqlStatement[] {
  return [
    {
      sql: SQL.newInode,
      params: [mode, size, seconds, nanoseconds],
    },
    {
      sql: `INSERT INTO fs_dentry (name, parent_ino, ino)
        VALUES (?, (SELECT ino FROM fs_inode WHERE ino = ${parent.sql}),
          ${LAST_INO[accessor.driver.dialect]})`,
      params: [name, ...parent.params],
    },
  ]
}

/** Set the inode's size, and its mtime to `stamp`. */
export function resized(ino: InoRef, size: number, [seconds, nanoseconds]: Stamp): SqlStatement {
  return {
    sql: `UPDATE fs_inode SET size = ?, mtime = ?, mtime_nsec = ? WHERE ino = ${ino.sql}`,
    params: [size, seconds, nanoseconds, ...ino.params],
  }
}

/**
 * `resized`, landing only on the inode as `node` read it: a size or mtime
 * another writer changed since leaves the size NULL, which its column
 * refuses, so the batch fails whole and the caller reads the file again.
 */
export function resizedFrom(
  node: Inode,
  size: number,
  [seconds, nanoseconds]: Stamp,
): SqlStatement {
  return {
    sql: `UPDATE fs_inode SET
      size = CASE WHEN size = ? AND mtime = ? AND mtime_nsec = ? THEN CAST(? AS BIGINT) END,
      mtime = ?, mtime_nsec = ? WHERE ino = ${byIno(node.ino).sql}`,
    params: [node.size, node.mtime, node.mtimeNsec, size, seconds, nanoseconds],
  }
}

/**
 * One multi-row INSERT per run of `rows` that fits `MAX_PARAMS`: `head` is the
 * statement up to VALUES, `row` one row's placeholders, and each entry of
 * `rows` that row's parameters.
 */
export function insertRows(
  head: string,
  row: string,
  rows: readonly (readonly SqlValue[])[],
): SqlStatement[] {
  const width = rows[0]?.length ?? 1
  const per = Math.max(1, Math.floor(MAX_PARAMS / width))
  const out: SqlStatement[] = []
  for (let i = 0; i < rows.length; i += per) {
    const run = rows.slice(i, i + per)
    out.push({ sql: `${head} VALUES ${run.map(() => row).join(', ')}`, params: run.flat() })
  }
  return out
}

/**
 * After the entries naming `inos` were removed: the inodes, and a file's
 * bytes. A directory something was written under since keeps its inode, as
 * the guard that removed its entry kept that too.
 */
export function dropInodes(inos: readonly number[]): SqlStatement[] {
  const out: SqlStatement[] = []
  for (let i = 0; i < inos.length; i += 500) {
    const list = inos
      .slice(i, i + 500)
      .map((ino) => byIno(ino).sql)
      .join(', ')
    out.push(
      { sql: `DELETE FROM fs_data WHERE ino IN (${list})` },
      {
        sql: `DELETE FROM fs_inode WHERE ino IN (${list})
          AND NOT EXISTS (SELECT 1 FROM fs_dentry c WHERE c.parent_ino = fs_inode.ino)`,
      },
    )
  }
  return out
}
