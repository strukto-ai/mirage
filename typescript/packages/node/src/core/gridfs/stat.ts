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

import {
  FileStat,
  FileType,
  enoent,
  gnuBasename,
  guessType,
  mountPrefixOf,
  rstripSlash,
  stripSlash,
  type IndexCacheStore,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { escapeRegex, filesColl, gridfsKey, latestFile } from './_client.ts'

export async function stat(
  accessor: GridFSAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const original = path.virtual
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const rawPath =
    prefix !== '' && original.startsWith(prefix) ? original.slice(prefix.length) || '/' : original
  const stripped = stripSlash(rawPath)
  if (stripped === '') {
    return new FileStat({ name: '/', type: FileType.DIRECTORY })
  }

  // A trailing slash ("/gridfs/csv/") signals the caller treats it as a
  // directory. GridFS allows both a file named "csv" AND deeper files
  // under "csv/" to coexist — without this hint we'd return the file and
  // `ls /gridfs/csv/` would list the file itself instead of the prefix.
  const hintsDirectory = rawPath.endsWith('/')

  // Fast path: check the index cache populated by readdir().
  if (index !== undefined) {
    const virtualKey = prefix !== '' ? `${prefix}/${stripped}` : '/' + stripped
    const lookup = await index.get(virtualKey)
    if (lookup.entry !== undefined && lookup.entry !== null) {
      const entry = lookup.entry
      if (entry.resourceType === 'folder') {
        return new FileStat({ name: entry.name, type: FileType.DIRECTORY })
      }
      return new FileStat({
        name: entry.name,
        size: entry.size ?? null,
        modified: entry.remoteTime !== '' ? entry.remoteTime : null,
        type: guessType(entry.name),
      })
    }
    // Parent was already listed and didn't include this path — it doesn't
    // exist. Avoids speculative lookups for shell-probed paths like .git.
    const parent = virtualKey.replace(/\/[^/]*$/, '') || '/'
    const parentListing = await index.listDir(parent)
    if (parentListing.entries !== undefined && parentListing.entries !== null) {
      throw enoent(path)
    }
  }

  const { config } = accessor
  const key = gridfsKey(rawPath, config)
  // File lookup first — skipped when the path hints a directory so a
  // coexisting file of the same name does not shadow the prefix.
  if (!hintsDirectory) {
    const doc = await latestFile(accessor, key)
    if (doc !== null) {
      const revision = doc._id.toString()
      return new FileStat({
        name: gnuBasename(rawPath),
        size: doc.length,
        modified: doc.uploadDate.toISOString(),
        fingerprint: revision,
        revision,
        type: guessType(rawPath),
        extra: { file_id: revision },
      })
    }
  }

  // No file (or it was skipped) — check whether the path is a valid
  // prefix (directory): a "key/" marker or any deeper filename proves it.
  const pfx = rstripSlash(key) + '/'
  const files = await filesColl(accessor)
  const probe = await files.findOne(
    { filename: { $regex: `^${escapeRegex(pfx)}` } },
    { projection: { _id: 1 } },
  )
  if (probe !== null) {
    return new FileStat({ name: gnuBasename(rawPath) || '/', type: FileType.DIRECTORY })
  }

  throw enoent(path)
}
