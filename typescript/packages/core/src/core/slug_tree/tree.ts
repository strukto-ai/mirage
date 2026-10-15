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

import { DirListing, type FileStat, type PathSpec } from '../../types.ts'
import { enoent, enotdir } from '../../errors/fs.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { DirRows, LoadRows } from './types.ts'

/**
 * A backend's whole document list, served as a directory tree.
 *
 * Every listing of the mount comes from one fetch, so a folder's listing
 * carries every folder below it as seeds. The members are arrow properties so
 * they can be handed around as ops without losing `this`.
 */
export class SlugTree<A> {
  constructor(readonly load: LoadRows<A>) {}

  /** A folder's rows, with every folder below it as seeds. */
  readonly readdir = async (
    accessor: A,
    path: PathSpec,
    _entry: FileStat | null = null,
  ): Promise<DirListing> => listingAt(await this.load(accessor), path)
}

/** The tree path of `path`; a glob word keys the folder it lists. */
export function treeKey(path: PathSpec): string {
  const key = stripSlash((path.pattern !== null ? path.dir : path).mountPath)
  return key !== '' ? '/' + key : '/'
}

/** The listing of the folder at `path` out of the whole tree's rows. */
export function listingAt(rows: DirRows, path: PathSpec): DirListing {
  const key = treeKey(path)
  const own = rows.get(key)
  if (own === undefined) {
    const cut = key.lastIndexOf('/')
    const name = key.slice(cut + 1)
    if ((rows.get(key.slice(0, cut) || '/') ?? []).some((row) => row.name === name)) {
      throw enotdir(path.virtual)
    }
    throw enoent(path.virtual)
  }
  const stem = key === '/' ? '' : key
  const seeds = new Map<string, FileStat[]>()
  for (const [folder, children] of rows) {
    if (folder !== key && folder.startsWith(stem + '/')) {
      seeds.set(folder.slice(stem.length + 1), [...children])
    }
  }
  return new DirListing({ entries: [...own], seeds })
}
