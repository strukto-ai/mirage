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
import type { PathSpec } from '../../types.ts'
import { childSpec } from '../../utils/key_prefix.ts'
import { SqlDialect } from '../../vfs/sql/types.ts'
import { candidateFiles } from './constants.ts'
import { isDir } from './inode.ts'
import { target, walk } from './path.ts'

const MAX_CANDIDATES = 512

/**
 * SQLite can rule out a file from its BLOBs without bringing them into the
 * isolate. A printable ASCII needle at most one chunk wide crosses at most
 * one boundary, so either its first or its second half is in a single row.
 * A UTF-16 BOM may change the bytes rg matches. Keep those files as well.
 */
export async function filesContaining(
  accessor: SqlAccessor,
  path: PathSpec,
  text: string,
  ignoreCase: boolean,
): Promise<PathSpec[] | null> {
  if (accessor.driver.dialect !== SqlDialect.SQLITE || text === '' || /[^ -~]/.test(text))
    return null
  // ASCII i, k and s have locale or Unicode fold partners outside SQLite's ASCII lower().
  const literal = ignoreCase
    ? text
        .toLowerCase()
        .split(/[iks]/)
        .reduce((a, b) => (a.length >= b.length ? a : b))
    : text
  if (!literal) return null
  const node = target(await walk(accessor, path))
  if (node === null || !isDir(node)) return null
  const chunkSize = await accessor.chunkSize()
  const needle = new TextEncoder().encode(literal.slice(0, chunkSize))
  const cut = Math.ceil(needle.length / 2)
  const first = needle.subarray(0, cut)
  const second = cut === needle.length ? first : needle.subarray(cut)
  const overlap = needle.length - 1
  const rows = await accessor.query(candidateFiles(ignoreCase), [
    node.ino,
    needle,
    chunkSize,
    -overlap,
    first,
    overlap,
    second,
    MAX_CANDIDATES + 1,
  ])
  return rows.length > MAX_CANDIDATES ? null : rows.map((row) => childSpec(path, String(row.rel)))
}
