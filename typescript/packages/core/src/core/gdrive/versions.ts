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
import { driveBase, googleGet, googleGetBytes, googleGetStream } from '../google/client.ts'
import type { ByteWindow } from '../../utils/ranges.ts'

// Download a pinned revision's content (binary files only).
export async function downloadRevision(
  tm: TokenManager,
  fileId: string,
  revisionId: string,
  window?: ByteWindow,
): Promise<Uint8Array> {
  return googleGetBytes(tm, revisionUrl(tm, fileId, revisionId), window)
}

/** Stream a pinned revision's content as it downloads. */
export function downloadRevisionStream(
  tm: TokenManager,
  fileId: string,
  revisionId: string,
): AsyncGenerator<Uint8Array, void> {
  return googleGetStream(tm, revisionUrl(tm, fileId, revisionId))
}

function revisionUrl(tm: TokenManager, fileId: string, revisionId: string): string {
  return `${driveBase(tm)}/files/${fileId}/revisions/${revisionId}?alt=media`
}

// Fetch a file's md5 and head revision at read time, raw rather than
// coalesced, because the caller checks the md5 against the bytes it
// downloads. The head revision doubles as the pinnable revision.
export async function captureFileMetadata(
  tm: TokenManager,
  fileId: string,
): Promise<[string | null, string | null]> {
  const url = `${driveBase(tm)}/files/${fileId}`
  const item = (await googleGet(tm, url, {
    fields: 'headRevisionId,md5Checksum',
    supportsAllDrives: 'true',
  })) as { headRevisionId?: string; md5Checksum?: string }
  return [item.md5Checksum ?? null, item.headRevisionId ?? null]
}
