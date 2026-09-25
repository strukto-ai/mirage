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

import type { TokenManager } from '../google/client.ts'
import { driveBase, googleGet, googleGetBytes } from '../google/client.ts'
import type { ByteWindow } from '../../utils/ranges.ts'

const REVISION_FIELDS = 'nextPageToken,revisions(id,modifiedTime,md5Checksum,size)'

export interface DriveRevision {
  id: string
  modifiedTime?: string
  md5Checksum?: string
  size?: string
}

interface ListRevisionsResponse {
  revisions?: DriveRevision[]
  nextPageToken?: string
}

// List a file's revisions via the Drive Revisions API, oldest first.
export async function listRevisions(tm: TokenManager, fileId: string): Promise<DriveRevision[]> {
  const revisions: DriveRevision[] = []
  let pageToken: string | null = null
  for (;;) {
    const params: Record<string, string> = { fields: REVISION_FIELDS }
    if (pageToken !== null) params.pageToken = pageToken
    const url = `${driveBase(tm)}/files/${fileId}/revisions`
    const data = (await googleGet(tm, url, params)) as ListRevisionsResponse
    if (data.revisions !== undefined) revisions.push(...data.revisions)
    pageToken = data.nextPageToken ?? null
    if (pageToken === null) break
  }
  return revisions
}

// Download a pinned revision's content (binary files only).
export async function downloadRevision(
  tm: TokenManager,
  fileId: string,
  revisionId: string,
  window?: ByteWindow,
): Promise<Uint8Array> {
  const url = `${driveBase(tm)}/files/${fileId}/revisions/${revisionId}?alt=media`
  return googleGetBytes(tm, url, window)
}

// Fetch a file's three version fields at read time. Returns the slots raw
// rather than a coalesced token, because the caller has to know which one it
// got: it verifies an md5 against the bytes it downloaded, and a token it
// cannot tell apart from a timestamp would be dropped for every binary file
// whose md5 Drive withholds. The head revision doubles as the pinnable
// revision. modifiedTime rides the same request and costs nothing; it is the
// only field a Drive shortcut carries.
export async function captureFileMetadata(
  tm: TokenManager,
  fileId: string,
): Promise<[string | null, string | null, string | null]> {
  const url = `${driveBase(tm)}/files/${fileId}`
  const item = (await googleGet(tm, url, {
    fields: 'headRevisionId,md5Checksum,modifiedTime',
    supportsAllDrives: 'true',
  })) as { headRevisionId?: string; md5Checksum?: string; modifiedTime?: string }
  return [item.md5Checksum ?? null, item.headRevisionId ?? null, item.modifiedTime ?? null]
}
