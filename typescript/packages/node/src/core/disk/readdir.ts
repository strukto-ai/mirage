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
import type { DiskAccessor } from '../../accessor/disk.ts'
import { IndexEntry, ResourceType } from '@struktoai/mirage-core/cache/index/config'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent, enotdir } from '@struktoai/mirage-core/errors/fs'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { diskError } from './errors.ts'
import { folderVersion, wallNs } from './listing_version.ts'
import { norm, readEntries, resolveInside } from './utils.ts'

export async function readdir(
  accessor: DiskAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  // A pattern spec addresses the directory whose entries the glob filters,
  // and the rest of this function works in mount-relative space, so the
  // directory has to be read off `dir` rather than off the virtual
  // `directory` string (python strips the prefix by hand for the same
  // reason).
  const target = path.pattern !== null ? path.dir : path
  const virtual = target.mountPath
  const mountPrefix = mountPrefixOf(target.virtual, target.vfsPath)
  // Canonical key: no trailing slash (except root), or the same dir
  // indexes under two keys and cache hits return doubled-slash entries.
  const virtualKey = rstripSlash(mountPrefix + virtual) || '/'
  if (index !== undefined) {
    const cached = await index.listDir(virtualKey)
    if (cached.entries !== undefined && cached.entries !== null) {
      return cached.entries
    }
  }
  const full = await resolveInside(accessor.root, path, virtual)
  let entries: Dirent[]
  let version: string | null = null
  try {
    // The version is read before the scan: a change landing during the scan
    // then leaves the stored version behind the folder's, and the next check
    // re-lists instead of serving rows that missed it.
    if (accessor.folderVersions) version = await folderVersion(full, wallNs())
    // A host symlink is not an entry of the mount (see resolveInside).
    entries = await readEntries(full)
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
  const base = norm(virtual)
  const dirPrefix = base === '/' ? '/' : `${base}/`
  const sorted = [...entries].sort((a, b) => compareCodePoints(a.name, b.name))
  const virtualEntries = sorted.map((e) => `${mountPrefix}${dirPrefix}${e.name}`)
  if (index !== undefined) {
    const indexEntries: [string, IndexEntry][] = sorted.map((entry) => [
      entry.name,
      new IndexEntry({
        id: `${dirPrefix}${entry.name}`,
        name: entry.name,
        resourceType: entry.isDirectory() ? ResourceType.FOLDER : ResourceType.FILE,
      }),
    ])
    await index.setDir(virtualKey, indexEntries, null, { version })
  }
  return virtualEntries
}
