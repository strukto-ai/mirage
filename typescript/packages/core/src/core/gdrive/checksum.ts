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
import { record, revisionFor, startOp } from '../../observe/context.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { driveBase, googleGet } from '../google/client.ts'
import { NATIVE_RESOURCE_TYPES, driveFingerprint } from './fingerprint.ts'
import { fileEntry } from './read.ts'

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
 * read instead. A digest answered is recorded as the read it stands in for,
 * with the token and head revision a read would record, so a snapshot pins
 * them and a conditional write later in the line is conditioned on them.
 * Mirrors Python's core/gdrive/checksum.py.
 */
export async function checksum(
  accessor: GDriveAccessor,
  path: PathSpec,
  algorithm: string,
  entry?: FileStat | null,
): Promise<string | null> {
  const field = DIGEST_FIELDS[algorithm]
  if (field === undefined || revisionFor(path.virtual) !== null) return null
  const row = fileEntry(path, entry)
  const resourceType = row.extra.resource_type as string
  if (NATIVE_RESOURCE_TYPES.has(resourceType)) return null
  const tm = accessor.tokenManager
  const timer = startOp()
  const fields = [...new Set([field, 'md5Checksum', 'headRevisionId'])]
  const item = (await googleGet(tm, `${driveBase(tm)}/files/${row.extra.file_id as string}`, {
    fields: fields.join(','),
    supportsAllDrives: 'true',
  })) as Record<string, unknown>
  const found = item[field]
  if (typeof found !== 'string' || found === '') return null
  const revision = item.headRevisionId
  record('read', path.virtual, 'gdrive', 0, timer, {
    fingerprint: driveFingerprint(resourceType, item.md5Checksum, revision, row.modified),
    revision: typeof revision === 'string' ? revision : null,
  })
  return found.toLowerCase()
}
