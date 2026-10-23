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

import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import type { DriveApi } from '../gdrive/api.ts'
import { GoogleApiError } from './client.ts'
import type { DriveFile } from './drive.ts'

/**
 * A native app file as its corpus listing names it and stat answers. The
 * size stays null: Drive reports the source document's storage size, not the
 * rendered JSON length (FileStat.size must be render-derived or null, see the
 * CLAUDE.md FUSE rules). The source size rides in `extra`. Mirrors Python's
 * `app_file`.
 */
export function appFile(name: string, item: DriveFile): FileStat {
  const modified =
    item.modifiedTime !== undefined && item.modifiedTime !== '' ? item.modifiedTime : null
  const extra: Record<string, unknown> = { doc_id: item.id, doc_name: item.name }
  const sourceSize = Number.parseInt(item.size ?? item.quotaBytesUsed ?? '0', 10)
  if (Number.isFinite(sourceSize) && sourceSize > 0) extra.source_size = sourceSize
  return new FileStat({
    name,
    type: FileType.FILE,
    content: ContentType.JSON,
    modified,
    fingerprint: modified,
    extra,
  })
}

/**
 * Resolve a native app file by the id in its name, without an account-wide
 * search: a path no listing has named is fetched alone. Mirrors Python's
 * `resolve_app_entry`.
 */
export async function resolveAppEntry(
  drive: DriveApi,
  match: ScopeMatch,
  path: PathSpec,
  mime: string,
  filename: (title: string, id: string, modified: string) => string,
): Promise<FileStat> {
  const fileId = match.slots.file_id
  if (fileId === undefined) throw enoent(path.virtual)
  let item
  try {
    item = await drive.getFile(fileId)
  } catch (err) {
    if (!(err instanceof GoogleApiError) || err.status !== 404) throw err
    throw enoent(path.virtual)
  }
  const name = filename(item.name, item.id, item.modifiedTime ?? '')
  const owned = item.owners?.[0]?.me === true
  if (
    item.trashed === true ||
    item.mimeType !== mime ||
    owned !== (match.slots.corpus === 'owned') ||
    name !== path.vfsPath.split('/').at(-1)
  ) {
    throw enoent(path.virtual)
  }
  return appFile(name, item)
}
