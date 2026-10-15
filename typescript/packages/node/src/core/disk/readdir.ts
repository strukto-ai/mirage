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

import type { Dirent } from 'node:fs'
import { lstat } from 'node:fs/promises'
import nodePath from 'node:path'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { DirListing, type FileStat, type PathSpec } from '@struktoai/mirage-core/types'
import { enoent, enotdir } from '@struktoai/mirage-core/errors/fs'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { diskError } from './errors.ts'
import { folderVersion, wallNs } from './listing_version.ts'
import { statOf } from './stat.ts'
import { readEntries, resolveInside } from './utils.ts'

/** An entry as `stat` answers it, null for one removed during the scan. */
async function rowOf(
  full: string,
  entry: Dirent,
  nowNs: bigint,
  versioned: boolean,
): Promise<FileStat | null> {
  try {
    const st = await lstat(nodePath.join(full, entry.name), { bigint: true })
    return statOf(entry.name, st, nowNs, versioned)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function readdir(accessor: DiskAccessor, path: PathSpec): Promise<DirListing> {
  // A pattern spec addresses the directory whose entries the glob filters,
  // and the rest of this function works in mount-relative space, so the
  // directory has to be read off `dir` rather than off the virtual
  // `directory` string (python strips the prefix by hand for the same
  // reason).
  const target = path.pattern !== null ? path.dir : path
  const full = await resolveInside(accessor.root, path, target.mountPath)
  const nowNs = wallNs()
  try {
    // The version is read before the scan: a change landing during the scan
    // then leaves the stored version behind the folder's, and the next check
    // re-lists instead of serving rows that missed it.
    const version = accessor.folderVersions ? await folderVersion(full, nowNs) : null
    // A host symlink is not an entry of the mount (see resolveInside).
    const entries = await readEntries(full)
    const rows = await Promise.all(
      entries.map((entry) => rowOf(full, entry, nowNs, accessor.folderVersions)),
    )
    const listed = rows.filter((row): row is FileStat => row !== null)
    listed.sort((a, b) => compareCodePoints(a.name, b.name))
    return new DirListing({ entries: listed, version })
  } catch (err) {
    // The kernel already separates ENOENT (a component does not exist) from
    // ENOTDIR (a component exists but is not a directory); keep that split
    // instead of collapsing both into one errno. Restamped onto the PathSpec
    // so the virtual path, never the real fs path, is reported.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOTDIR') throw enotdir(path)
    if (code === 'ENOENT') throw enoent(path)
    throw diskError(err, path)
  }
}
