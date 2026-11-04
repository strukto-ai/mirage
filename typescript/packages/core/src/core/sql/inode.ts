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
import { ALL_MODE_BITS, S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } from '../../utils/stat_view.ts'
import type { SqlRow, SqlStatement, SqlValue } from '../../vfs/sql/types.ts'
import type { INODE_COLUMNS } from './constants.ts'
import { LAST_INO, MAX_PARAMS, SQL } from './constants.ts'

/** One `fs_inode` row. Mirrors Python's `Inode`. */
export interface Inode {
  readonly ino: number
  readonly mode: number
  readonly nlink: number
  readonly uid: number
  readonly gid: number
  readonly size: number
  readonly atime: number
  readonly atimeNsec: number
  readonly mtime: number
  readonly mtimeNsec: number
  readonly ctime: number
  readonly ctimeNsec: number
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
    nlink: n('nlink'),
    uid: n('uid'),
    gid: n('gid'),
    size: n('size'),
    atime: n('atime'),
    atimeNsec: n('atime_nsec'),
    mtime: n('mtime'),
    mtimeNsec: n('mtime_nsec'),
    ctime: n('ctime'),
    ctimeNsec: n('ctime_nsec'),
  }
}

export function isDir(node: Inode): boolean {
  return (node.mode & S_IFMT) === S_IFDIR
}

export function isFile(node: Inode): boolean {
  return (node.mode & S_IFMT) === S_IFREG
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
 * What `stat` answers for the inode at mount path `p`. AgentFS records owner
 * 0 for a file nobody chowned, so 0 reads as no owner, and `ls -l` shows the
 * session's user as it does on a mount that keeps none. Mirrors Python's
 * `inode_stat`.
 */
export function inodeStat(p: string, node: Inode): FileStat {
  const common = {
    name: gnuBasename(p),
    modified: isoOf(node.mtime, node.mtimeNsec),
    mode: node.mode & ALL_MODE_BITS,
    uid: node.uid === 0 ? null : node.uid,
    gid: node.gid === 0 ? null : node.gid,
    atime: isoOf(node.atime, node.atimeNsec),
    ctime: isoOf(node.ctime, node.ctimeNsec),
  }
  const kind = node.mode & S_IFMT
  if (kind === S_IFDIR) return new FileStat({ ...common, type: FileType.DIRECTORY })
  if (kind === S_IFLNK) return new FileStat({ ...common, type: FileType.SYMLINK, size: node.size })
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
 * the inode was just given.
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
      params: [mode, size, seconds, nanoseconds, seconds, nanoseconds, seconds, nanoseconds],
    },
    {
      sql: `INSERT INTO fs_dentry (name, parent_ino, ino)
        VALUES (?, ${parent.sql}, ${LAST_INO[accessor.driver.dialect]})`,
      params: [name, ...parent.params],
    },
  ]
}

/** Set the inode's size, and its mtime and ctime to `stamp`. */
export function resized(ino: InoRef, size: number, [seconds, nanoseconds]: Stamp): SqlStatement {
  return {
    sql: `UPDATE fs_inode SET size = ?, mtime = ?, mtime_nsec = ?, ctime = ?, ctime_nsec = ?
      WHERE ino = ${ino.sql}`,
    params: [size, seconds, nanoseconds, seconds, nanoseconds, ...ino.params],
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
 * After entries naming `inos` were removed: count each one's links afresh and
 * drop each that has none left, its bytes and link target with it. A file
 * another entry still names (a hard link) keeps everything.
 */
export function reap(inos: readonly number[]): SqlStatement[] {
  const out: SqlStatement[] = []
  for (let i = 0; i < inos.length; i += 500) {
    const list = inos
      .slice(i, i + 500)
      .map((ino) => byIno(ino).sql)
      .join(', ')
    const gone = `SELECT ino FROM fs_inode WHERE ino IN (${list}) AND nlink = 0`
    out.push(
      {
        sql: `UPDATE fs_inode SET nlink = (SELECT COUNT(*) FROM fs_dentry d WHERE d.ino = fs_inode.ino)
          WHERE ino IN (${list})`,
      },
      { sql: `DELETE FROM fs_data WHERE ino IN (${gone})` },
      { sql: `DELETE FROM fs_symlink WHERE ino IN (${gone})` },
      { sql: `DELETE FROM fs_inode WHERE ino IN (${list}) AND nlink = 0` },
    )
  }
  return out
}
