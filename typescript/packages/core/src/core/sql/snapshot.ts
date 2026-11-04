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
import { CLEAR, DIR, FILE, RENUMBERED, ROOT_INO, SQL } from './constants.ts'
import { placeBytes, readBytes } from './data.ts'
import { byIno, inodeOf, isDir, isFile, isoOf, nowStamp, stampOf } from './inode.ts'

/**
 * What a snapshot keeps of a sql mount: each file's bytes and each
 * directory, by mount path, with the mtime of each. A path's mode and owner
 * are the namespace's, which the workspace snapshots itself. Mirrors
 * Python's snapshot dict.
 */
export interface SqlSnapshot {
  files: Record<string, Uint8Array>
  dirs: string[]
  modified: Record<string, string>
}

function depth(p: string): number {
  return p.split('/').length
}

/** Every file and directory of the database, read in one walk of the tree. */
export async function snapshot(accessor: SqlAccessor): Promise<SqlSnapshot> {
  const out: SqlSnapshot = { files: {}, dirs: ['/'], modified: {} }
  for (const row of await accessor.query(SQL.subtree, [ROOT_INO])) {
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
 * Replace everything the database holds with `state`, in one transaction:
 * the directories outermost first, then each file under its directory. A
 * path whose directory the state does not hold is dropped. Each inode is
 * given its number here, so an entry names its parent by number however
 * deep the tree.
 */
export async function restore(accessor: SqlAccessor, state: SqlSnapshot): Promise<void> {
  const statements: SqlStatement[] = CLEAR.map((sql) => ({ sql }))
  const dirs = new Map<string, number>([['/', ROOT_INO]])
  const now = nowStamp()
  let next = ROOT_INO
  const place = async (p: string, mode: number, data: Uint8Array | null): Promise<void> => {
    const up = dirs.get(parent(p))
    if (up === undefined) return
    const ino = ++next
    const modified = state.modified[p]
    const [seconds, nanoseconds] = modified !== undefined ? stampOf(modified) : now
    statements.push(
      { sql: SQL.numberedInode, params: [ino, mode, data?.byteLength ?? 0, seconds, nanoseconds] },
      { sql: SQL.newEntry, params: [gnuBasename(p), up, ino] },
    )
    if (data === null) dirs.set(p, ino)
    else statements.push(...(await placeBytes(accessor, byIno(ino), null, 0, data)))
  }
  const listed = state.dirs.filter((p) => p !== '/')
  listed.sort((a, b) => depth(a) - depth(b) || compareCodePoints(a, b))
  for (const p of listed) await place(p, DIR, null)
  for (const [p, data] of Object.entries(state.files)) await place(p, FILE, data)
  const renumbered = RENUMBERED[accessor.driver.dialect]
  if (renumbered !== null) statements.push({ sql: renumbered })
  await accessor.batch(statements)
}
