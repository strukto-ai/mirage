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

import type { HfBucketsAccessor } from '../../accessor/hf.ts'
import { HfHubError, etagValue, hubPost } from '../hf_hub/client.ts'

type Row = Record<string, unknown>

function base(accessor: HfBucketsAccessor): string {
  return accessor.endpoint.replace(/\/+$/, '')
}

/**
 * The paths-info endpoint of the mount's bucket.
 *
 * A bucket has no revisions, so unlike a repository's route this one carries
 * no revision segment: `/paths-info/main` answers 404.
 */
export function pathsInfoUrl(accessor: HfBucketsAccessor): string {
  return `${base(accessor)}/api/buckets/${accessor.repoId}/paths-info`
}

/**
 * The content URL of one bucket file.
 *
 * The path is percent-encoded per segment, as a repository's resolve URL is:
 * a name holding a "#" pasted raw truncates at the fragment.
 */
export function resolveUrl(accessor: HfBucketsAccessor, rel: string): string {
  const encoded = accessor
    .bucketPath(rel)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `${base(accessor)}/buckets/${accessor.repoId}/resolve/${encoded}`
}

/**
 * The paths-info row of one bucket file, in one request.
 *
 * paths-info answers a missing path, a directory and a leading-slash spelling
 * alike with an empty list, and a file with its row, so only a file row naming
 * exactly the asked path is an answer. A row for some other path is not
 * evidence about this one, and must not read as its absence: reconcile deletes
 * what it believes is gone. The mount root is never a file and is never asked.
 */
export async function fetchRow(accessor: HfBucketsAccessor, key: string): Promise<Row | null> {
  if (key.replace(/^\/+|\/+$/g, '') === '') return null
  const asked = accessor.bucketPath(key)
  const rows = await hubPost(accessor.token, pathsInfoUrl(accessor), { paths: [asked] })
  if (!Array.isArray(rows)) {
    throw new HfHubError(`paths-info answered no list for ${asked}`, 0, 'InvalidResponse')
  }
  const matching = rows.filter(
    (row): row is Row => typeof row === 'object' && row !== null && (row as Row).path === asked,
  )
  if (rows.length > 0 && matching.length === 0) {
    throw new HfHubError(`paths-info answered no row for ${asked}`, 0, 'PathMismatch')
  }
  return matching.find((row) => row.type === 'file') ?? null
}

/**
 * The content token a download's ETag vouches for, or null.
 *
 * A bucket file's strong ETag is its xet hash, the value paths-info reports,
 * whether the read was whole or ranged. A weak validator promises equivalence
 * rather than the same bytes, so it vouches for nothing, and neither does an
 * empty one.
 */
export function readToken(rawEtag: string): string | null {
  if (rawEtag.trim().startsWith('W/')) return null
  const value = etagValue(rawEtag)
  return value === '' ? null : value
}
