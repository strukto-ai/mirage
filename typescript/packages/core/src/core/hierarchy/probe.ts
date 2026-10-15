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

import type { Accessor } from '../../accessor/base.ts'
import type { FileStat } from '../../types.ts'
import { DirListing, FileType, PathSpec } from '../../types.ts'
import { mountKey, mountPrefixOf, mountedPath } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'

export type ReaddirFn<A extends Accessor> = (
  accessor: A,
  pathSpec: PathSpec,
  entry?: FileStat | null,
  parent?: FileStat | null,
) => Promise<FileStat[] | DirListing>

/** The PathSpec of the directory holding `path`, on the same mount. */
export function parentSpec(path: PathSpec): PathSpec {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const virtual = rstripSlash(path.virtual)
  const parentVirtual = virtual.slice(0, virtual.lastIndexOf('/')) || '/'
  return new PathSpec({
    virtual: parentVirtual,
    directory: parentVirtual,
    resolved: false,
    vfsPath: mountKey(parentVirtual, prefix),
  })
}

/** The listed directory's own children, whichever shape listed them. */
export function rowsOf(listed: readonly FileStat[] | DirListing): readonly FileStat[] {
  return listed instanceof DirListing ? listed.entries : listed
}

/** Whether a listed row is a directory to walk into. */
export function isDirectory(row: FileStat): boolean {
  return row.type === FileType.DIRECTORY
}

/**
 * Every row below `directory`, walked through the backend's own listings,
 * each directory handed the row its parent's listing named. Mirrors Python's
 * `rows_under`.
 */
export async function rowsUnder<A extends Accessor>(
  readdir: ReaddirFn<A>,
  accessor: A,
  directory: PathSpec,
  entry: FileStat | null,
  parent: FileStat | null = null,
  isDir: (row: FileStat) => boolean = isDirectory,
): Promise<[PathSpec, FileStat][]> {
  const found: [PathSpec, FileStat][] = []
  const pending: [PathSpec, FileStat | null, FileStat | null][] = [[directory, entry, parent]]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [current, row, above] = next
    const base = rstripSlash(current.mountPath)
    for (const child of rowsOf(await readdir(accessor, current, row, above))) {
      const path = mountedPath(current, `${base}/${child.name}`)
      found.push([path, child])
      if (isDir(child)) pending.push([path, child, row])
    }
  }
  return found
}

/**
 * What is at `path` and at its parent, as each level's listing names it,
 * listed from the mount root down: a walk that starts below the root hands
 * its first directory these. The mount root is no listing's child, so it
 * answers nothing; a name a level does not list answers no row at `path`.
 * Mirrors Python's `row_at`.
 */
export async function rowAt<A extends Accessor>(
  readdir: ReaddirFn<A>,
  accessor: A,
  path: PathSpec,
): Promise<[FileStat | null, FileStat | null]> {
  const key = stripSlash(path.mountPath)
  let entry: FileStat | null = null
  let parent: FileStat | null = null
  let current = mountedPath(path, '/')
  for (const name of key !== '' ? key.split('/') : []) {
    const listed = rowsOf(await readdir(accessor, current, entry, parent))
    const row = listed.find((one) => one.name === name) ?? null
    if (row === null) return [null, entry]
    parent = entry
    entry = row
    current = mountedPath(path, `${rstripSlash(current.mountPath)}/${name}`)
  }
  return [entry, parent]
}
