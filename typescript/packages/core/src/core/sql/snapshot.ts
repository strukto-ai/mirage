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
import { gnuBasename, parent } from '../../utils/path.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { SqlStatement } from '../../vfs/sql/types.ts'
import {
  CLEAR,
  clearUnder,
  DIR,
  FILE,
  RENUMBERED,
  RESTORED_INO,
  ROOT_INO,
  SQL,
} from './constants.ts'
import { placeBytes, readBytes } from './data.ts'
import { inodeOf, isDir, isFile, isoOf, nowStamp, stampOf, type InoRef } from './inode.ts'

/**
 * What a snapshot keeps of a sql mount: each file's bytes and each
 * directory, by mount path, with the mtime of each. Mirrors Python's
 * snapshot dict.
 */
export interface SqlSnapshot {
  files: Record<string, Uint8Array>
  dirs: string[]
  modified: Record<string, string>
}

function depth(p: string): number {
  return p.split('/').length
}

/** Every file and directory of the mount's folder, read in one walk of the tree. */
export async function snapshot(accessor: SqlAccessor): Promise<SqlSnapshot> {
  const out: SqlSnapshot = { files: {}, dirs: ['/'], modified: {} }
  for (const row of await accessor.query(SQL.subtree, [await accessor.rootIno()])) {
    const node = inodeOf(row)
    if (node === null || !(isDir(node) || isFile(node))) continue
    const p = `/${String(row.rel)}`
    if (isDir(node)) out.dirs.push(p)
    else out.files[p] = await readBytes(accessor, node)
    out.modified[p] = isoOf(node.mtime, node.mtimeNsec)
  }
  out.dirs.sort(compareCodePoints)
  return out
}

/**
 * Replace everything the mount's folder holds with `state`, in one
 * transaction: the directories outermost first, then each file under its
 * directory. A path whose directory the state does not hold is dropped. The
 * inodes take fresh numbers counted from one the database gives first, so
 * an entry names its parent by number however deep the tree, and an op that
 * read an inode before the restore reaches none it made. Outside the folder,
 * the database keeps what it holds.
 */
export async function restore(accessor: SqlAccessor, state: SqlSnapshot): Promise<void> {
  const now = nowStamp()
  const root = await accessor.rootIno()
  const statements: SqlStatement[] = [
    { sql: SQL.dropBase },
    { sql: SQL.newInode, params: [FILE, 0, ...now] },
    { sql: SQL.setBase },
    ...(root === ROOT_INO ? CLEAR : clearUnder(root)).map((sql) => ({ sql })),
  ]
  // The folder through its inode, so one removed before the batch leaves
  // the top entries no parent, which their column refuses, and the restore
  // fails whole rather than strand them.
  const top: InoRef = { sql: `(SELECT ino FROM fs_inode WHERE ino = ${String(root)})`, params: [] }
  const dirs = new Map<string, InoRef>([['/', top]])
  let made = 0
  const place = async (p: string, mode: number, data: Uint8Array | null): Promise<void> => {
    const up = dirs.get(parent(p))
    if (up === undefined) return
    const ref: InoRef = { sql: RESTORED_INO, params: [++made] }
    const modified = state.modified[p]
    const [seconds, nanoseconds] = modified !== undefined ? stampOf(modified) : now
    statements.push(
      {
        sql: `INSERT INTO fs_inode (ino, mode, size, mtime, mtime_nsec) VALUES (${ref.sql}, ?, ?, ?, ?)`,
        params: [...ref.params, mode, data?.byteLength ?? 0, seconds, nanoseconds],
      },
      {
        sql: `INSERT INTO fs_dentry (name, parent_ino, ino) VALUES (?, ${up.sql}, ${ref.sql})`,
        params: [gnuBasename(p), ...up.params, ...ref.params],
      },
    )
    if (data === null) dirs.set(p, ref)
    else statements.push(...(await placeBytes(accessor, ref, null, 0, data)))
  }
  const listed = state.dirs.filter((p) => p !== '/')
  listed.sort((a, b) => depth(a) - depth(b) || compareCodePoints(a, b))
  for (const p of listed) await place(p, DIR, null)
  for (const [p, data] of Object.entries(state.files)) await place(p, FILE, data)
  const renumbered = RENUMBERED[accessor.driver.dialect]
  if (renumbered !== null) statements.push({ sql: renumbered })
  statements.push({ sql: SQL.dropBase })
  await accessor.batch(statements)
}
