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

import type { IndexEntry } from '@struktoai/mirage-core/cache/index/config'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { FileStat, FileType } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/utils/errors'
import { contentTypeForPath } from '@struktoai/mirage-core/utils/filetype'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { dirStatEntry, keyOf, lookup } from './lookup.ts'

/**
 * Render one tree row as a FileStat.
 *
 * Size is the row's, which is the Hub's *content* length even for an LFS
 * file; the 135-byte pointer never reaches here. Reporting the pointer would
 * make `wc -c` and `ls -l` lie and risk truncated copies over FUSE.
 *
 * `modified` is null unless the mount asked for commit expansion: a Hub file's
 * only mtime is the commit that last touched it, and stamping the
 * repository's own lastModified onto every file would be a confident lie about
 * files that commit never touched.
 */
function statOf(entry: IndexEntry): FileStat {
  const modified = entry.remoteTime === '' ? null : entry.remoteTime
  if (entry.resourceType === 'folder') {
    return new FileStat({ name: entry.name, type: FileType.DIRECTORY, modified })
  }
  return new FileStat({
    name: entry.name,
    size: entry.size ?? null,
    modified,
    // A file's FileType *is* its content type here; there is no FILE member,
    // so the extension decides, exactly as every other backend spells it.
    type: FileType.FILE,
    content: contentTypeForPath(entry.name),
    // git is content-addressed, so the object id is the strongest fingerprint
    // any backend here has: identical bytes carry an identical oid, and a
    // rewrite that changed nothing correctly reports nothing.
    fingerprint: entry.id,
    extra: { ...entry.extra },
  })
}

export async function stat(
  accessor: HfHubAccessor,
  pathSpec: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = mountPrefixOf(pathSpec.virtual, pathSpec.resourcePath)
  const rel = pathSpec.mountPath.replace(/^\/+|\/+$/g, '')
  if (rel === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })
  const key = keyOf(prefix, rel)
  const found = await lookup(accessor, index, prefix, key)
  if (found.entry !== null) return statOf(found.entry)
  // A directory the tree implies but has no row of its own for still exists,
  // which is what a listing at the key proves.
  if (found.children !== null) return statOf(dirStatEntry(key))
  throw enoent(pathSpec.virtual)
}
