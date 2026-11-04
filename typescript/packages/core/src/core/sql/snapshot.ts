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
import { CLEAR, DIR, FILE, ROOT_INO, SQL } from './constants.ts'
import { placeBytes, readBytes } from './data.ts'
import {
  byEntry,
  byIno,
  inodeOf,
  isDir,
  isFile,
  isoOf,
  makeNode,
  nowStamp,
  stampOf,
  type InoRef,
} from './inode.ts'

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
 * path whose directory the state does not hold is dropped.
 */
export async function restore(accessor: SqlAccessor, state: SqlSnapshot): Promise<void> {
  const statements: SqlStatement[] = CLEAR.map((sql) => ({ sql }))
  const refs = new Map<string, InoRef>([['/', byIno(ROOT_INO)]])
  const now = nowStamp()
  const place = async (p: string, mode: number, data: Uint8Array | null): Promise<void> => {
    const up = refs.get(parent(p))
    if (up === undefined) return
    const name = gnuBasename(p)
    const modified = state.modified[p]
    const ref = byEntry(up, name)
    statements.push(
      ...makeNode(
        accessor,
        up,
        name,
        mode,
        data?.byteLength ?? 0,
        modified !== undefined ? stampOf(modified) : now,
      ),
    )
    if (data !== null) statements.push(...(await placeBytes(accessor, ref, null, 0, data)))
    if (data === null) refs.set(p, ref)
  }
  const dirs = state.dirs.filter((p) => p !== '/')
  dirs.sort((a, b) => depth(a) - depth(b) || compareCodePoints(a, b))
  for (const p of dirs) await place(p, DIR, null)
  for (const [p, data] of Object.entries(state.files)) await place(p, FILE, data)
  await accessor.batch(statements)
}
