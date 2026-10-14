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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { revisionFor } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { driveBase, googleGet } from '../google/client.ts'
import { fileEntry } from './read.ts'
import { NATIVE_RESOURCE_TYPES } from './readdir.ts'

// The digests Drive keeps for a file's content, by hashlib name.
const DIGEST_FIELDS: Readonly<Record<string, string>> = {
  md5: 'md5Checksum',
  sha1: 'sha1Checksum',
  sha256: 'sha256Checksum',
}

/**
 * The digest Drive keeps for a file's content. Drive hashes the bytes of
 * every file it stores, which are the bytes a read downloads. A Google Docs,
 * Sheets or Slides file has no stored bytes, only a rendering, and a pinned
 * revision reads older bytes than the file's own digest names, so both are
 * read instead. Mirrors Python's core/gdrive/checksum.py.
 */
export async function checksum(
  accessor: GDriveAccessor,
  path: PathSpec,
  algorithm: string,
  index?: IndexCacheStore,
): Promise<string | null> {
  const field = DIGEST_FIELDS[algorithm]
  if (field === undefined || revisionFor(path.virtual) !== null) return null
  const entry = await fileEntry(accessor, path, index)
  if (NATIVE_RESOURCE_TYPES.has(entry.resourceType)) return null
  const tm = accessor.tokenManager
  const item = (await googleGet(tm, `${driveBase(tm)}/files/${entry.id}`, {
    fields: field,
    supportsAllDrives: 'true',
  })) as Record<string, unknown>
  const found = item[field]
  return typeof found === 'string' && found !== '' ? found.toLowerCase() : null
}
