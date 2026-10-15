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

import { DirListing, type FileStat, PathSpec } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { Handed } from '../../vfs/types.ts'

export type ListFn<A> = (
  accessor: A,
  path: PathSpec,
  entry?: FileStat | null,
) => Promise<readonly FileStat[] | DirListing>

/**
 * What is at `path`, found by listing each folder from the mount root down,
 * each handed what its parent's listing named, as the mount finds it. Null for
 * the mount root and for a path nothing is at. Mirrors Python's `entry_at`.
 */
export async function entryAt<A>(
  readdir: ListFn<A>,
  accessor: A,
  path: PathSpec,
): Promise<FileStat | null> {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const names = path.vfsPath.split('/').filter((name) => name !== '')
  let found: FileStat | null = null
  for (const [depth, name] of names.entries()) {
    const key = names.slice(0, depth).join('/')
    const virtual = key !== '' ? `${prefix}/${key}` : prefix || '/'
    let listed: readonly FileStat[] | DirListing
    try {
      listed = await readdir(
        accessor,
        new PathSpec({ virtual, directory: virtual, vfsPath: key }),
        found,
      )
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw error
    }
    const rows = listed instanceof DirListing ? listed.entries : listed
    found = rows.find((row) => row.name === name) ?? null
    if (found === null) return null
  }
  return found
}

/** The folder holding `path`, addressed like it. Mirrors Python's `parent_of`. */
export function parentOf(path: PathSpec): PathSpec {
  const trimmed = path.virtual.replace(/\/+$/, '')
  const virtual = trimmed.slice(0, trimmed.lastIndexOf('/')) || '/'
  const key = path.vfsPath.replace(/^\/+|\/+$/g, '')
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '',
  })
}

/**
 * Every stat the mount hands a backend function at `path` (and a rename's or
 * a copy's `dst`), each found by listing. Mirrors Python's `call`, which
 * hands only the ones a function declares.
 */
export async function handedAt<A>(
  readdir: ListFn<A>,
  accessor: A,
  path: PathSpec,
  dst?: PathSpec,
): Promise<Handed> {
  return {
    entry: await entryAt(readdir, accessor, path),
    parent: await entryAt(readdir, accessor, parentOf(path)),
    ...(dst === undefined
      ? {}
      : {
          dstEntry: await entryAt(readdir, accessor, dst),
          dstParent: await entryAt(readdir, accessor, parentOf(dst)),
        }),
  }
}
