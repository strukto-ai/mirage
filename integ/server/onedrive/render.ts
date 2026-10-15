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

import type { JsonValue } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { baseName, dirName, norm } from './paths.ts'
import { childNames, fileAt, dirAt, fileId, folderId, folderSize, versionsOf } from './store.ts'
import type { FileRow } from './store.ts'

function parentOf(drive: string, path: string): JsonValue {
  return { id: folderId(drive, dirName(norm(path))), driveId: drive }
}

// The download URL is absolute and points back at the host the caller actually
// reached, which is why the origin is a parameter rather than a field the
// server recorded at listen time: behind a port mapping the two differ, and
// the caller can only follow the one it can route to.
export async function fileItem(
  db: C,
  tenant: string,
  origin: string,
  row: FileRow,
): Promise<JsonValue> {
  const versions = await versionsOf(db, tenant, row.drive, row.path)
  return {
    id: fileId(row.drive, row.seq),
    name: baseName(row.path),
    parentReference: parentOf(row.drive, row.path),
    createdDateTime: versions.at(-1)?.lastModifiedDateTime ?? row.modified,
    size: row.content.length,
    lastModifiedDateTime: row.modified,
    cTag: row.ctag,
    eTag: row.etag,
    file: { mimeType: 'application/octet-stream' },
    // Pre-authenticated, like the vendor's own: it is fetched with no bearer,
    // so the account is a path segment rather than something the handler on
    // the other end can read off a header.
    '@microsoft.graph.downloadUrl': `${origin}/download/${encodeURIComponent(tenant)}/${row.drive}/${row.path}`,
    versions,
  }
}

// A folder facet reports an AGGREGATE subtree size, not a content length, and
// mirage's Graph backend is careful to keep that out of FileStat.size for
// exactly that reason. childCount is what `find -empty` reads.
export async function folderItem(
  db: C,
  tenant: string,
  drive: string,
  path: string,
  modified: string,
): Promise<JsonValue> {
  const p = norm(path)
  return {
    id: folderId(drive, p),
    name: p === '' ? 'root' : baseName(p),
    size: await folderSize(db, tenant, drive, p),
    lastModifiedDateTime: modified,
    folder: { childCount: (await childNames(db, tenant, drive, p)).length },
    ...(p === '' ? { root: {} } : { parentReference: parentOf(drive, p) }),
  }
}

export async function itemAt(
  db: C,
  tenant: string,
  origin: string,
  drive: string,
  path: string,
  modified: string,
): Promise<JsonValue | null> {
  const p = norm(path)
  const file = await fileAt(db, tenant, drive, p)
  if (file !== null) return fileItem(db, tenant, origin, file)
  if (await dirAt(db, tenant, drive, p)) return folderItem(db, tenant, drive, p, modified)
  return null
}
