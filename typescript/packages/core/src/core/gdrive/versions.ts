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

import type { TokenManager } from '../google/_client.ts'
import { driveBase, googleGet, googleGetBytes } from '../google/_client.ts'

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
): Promise<Uint8Array> {
  const url = `${driveBase(tm)}/files/${fileId}/revisions/${revisionId}?alt=media`
  return googleGetBytes(tm, url)
}

// Fetch the (fingerprint, revision) pair for a file at read time. The head
// revision ID doubles as the pinnable revision; the MD5 checksum is the
// content fingerprint (falls back to the head revision ID for types
// without one).
export async function captureFileMetadata(
  tm: TokenManager,
  fileId: string,
): Promise<[string | null, string | null]> {
  const url = `${driveBase(tm)}/files/${fileId}`
  const item = (await googleGet(tm, url, {
    fields: 'headRevisionId,md5Checksum',
    supportsAllDrives: 'true',
  })) as { headRevisionId?: string; md5Checksum?: string }
  const revision = item.headRevisionId ?? null
  const fingerprint = item.md5Checksum ?? revision
  return [fingerprint, revision]
}
