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

import type { TiDBFilesystemAccessor } from '../../accessor/tidb_filesystem.ts'
import { eexist, einval, eisdir, enoent, enotdir } from '../../errors/fs.ts'
import type { FsError } from '../../errors/types.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { ancestors } from '../../utils/path.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { statEntries } from './client.ts'
import { backendPath } from './path.ts'
import type { Kinds } from './types.ts'

/**
 * What each mount-local path is, in one fs:batch-stat. drive9 creates missing
 * parents on a write, a mkdir and a file rename, and keeps a file and a
 * directory of one name side by side, so the errno open(2) or rename(2) would
 * answer has to be worked out here from what the paths are before the call.
 * The mount root is always a directory and is not asked.
 */
export async function kindsOf(
  accessor: TiDBFilesystemAccessor,
  keys: readonly string[],
): Promise<Kinds> {
  const asked = [...new Set(keys)].filter((key) => key !== '/')
  const found = await statEntries(
    accessor,
    asked.map((key) => backendPath(accessor.config, key)),
  )
  const kinds: Kinds = new Map(asked.map((key, index) => [key, found[index] ?? null]))
  kinds.set('/', { name: '/', isDir: true, size: 0, mtime: null })
  return kinds
}

/**
 * ENOTDIR for a file above `key`, ENOENT for a missing directory above it,
 * the first the walk meets, as the kernel resolves a path.
 */
export function brokenParent(kinds: Kinds, spec: PathSpec, key: string): FsError | null {
  for (const ancestor of ancestors(key)) {
    const entry = kinds.get(ancestor) ?? null
    if (entry === null) return enoent(spec)
    if (!entry.isDir) return enotdir(spec)
  }
  return null
}

export function lookupError(kinds: Kinds, spec: PathSpec, key: string): FsError {
  return brokenParent(kinds, spec, key) ?? enoent(spec)
}

export function checkWriteTarget(kinds: Kinds, spec: PathSpec, key: string): void {
  const broken = brokenParent(kinds, spec, key)
  if (broken !== null) throw broken
  if (kinds.get(key)?.isDir === true) throw eisdir(spec)
}

/**
 * Refuse a mkdir GNU refuses; true when `-p` finds it done. Plain mkdir is
 * EEXIST for anything at the target and owes the parent chain the walk a
 * write owes it. `-p` names the component it trips on: a file above the
 * target is ENOTDIR, the target as a file EEXIST, and the target as a
 * directory is success.
 */
export function checkMkdirTarget(
  kinds: Kinds,
  spec: PathSpec,
  key: string,
  parents: boolean,
): boolean {
  const entry = kinds.get(key) ?? null
  if (!parents) {
    if (entry !== null) throw eexist(spec)
    const broken = brokenParent(kinds, spec, key)
    if (broken !== null) throw broken
    return false
  }
  for (const component of ancestors(key)) {
    if (kinds.get(component)?.isDir === false) throw enotdir(mountedPath(spec, component))
  }
  if (entry !== null && !entry.isDir) throw eexist(spec)
  return entry !== null
}

/**
 * Refuse a rename rename(2) refuses once both ends resolve. A missing
 * destination parent is ENOENT and a file above it ENOTDIR; a file onto a
 * directory is EISDIR, a directory onto a file ENOTDIR, and into its own
 * subtree EINVAL. A directory onto one that holds entries is left to drive9,
 * which answers it with a conflict.
 */
export function checkRename(
  kinds: Kinds,
  src: PathSpec,
  s: string,
  dst: PathSpec,
  d: string,
): void {
  const broken = brokenParent(kinds, dst, d)
  if (broken !== null) throw broken
  const source = kinds.get(s) ?? null
  if (source === null) throw lookupError(kinds, src, s)
  if (s === d) return
  const target = kinds.get(d) ?? null
  if (!source.isDir) {
    if (target?.isDir === true) throw eisdir(dst)
    return
  }
  if (d.startsWith(`${rstripSlash(s)}/`)) throw einval(src)
  if (target !== null && !target.isDir) throw enotdir(dst)
}
