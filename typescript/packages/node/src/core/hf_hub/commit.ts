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

import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { apiUrl, hubPost, hubPostNdjson, revSegment } from './client.ts'
import { COMMIT_CHUNK, DEFAULT_COMMIT_MESSAGE, PREUPLOAD_SAMPLE_BYTES } from './constants.ts'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

// The upload modes the Hub's preupload endpoint answers with. "regular" is a
// git blob and rides inline in the commit; the other two are out-of-band
// uploads that must happen BEFORE the commit references them.
const REGULAR = 'regular'

/** One file a commit adds or replaces. */
export interface Addition {
  path: string
  data: Uint8Array
}

/**
 * A write the Hub will only accept through the LFS/Xet upload path.
 *
 * Thrown rather than papered over, because the alternative is a commit that
 * references content the Hub never received: the file would appear in the
 * tree and every read of it would fail. Which files land here is the
 * repository's own `.gitattributes` plus a size threshold, so it is the
 * repo's decision, not a fixed byte count this code could apply.
 */
export class LfsRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LfsRequiredError'
  }
}

function b64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64')
}

/** The commit endpoint for one revision. */
export function commitUrl(accessor: HfHubAccessor, revision?: string): string {
  const rev = revision ?? accessor.revision
  return apiUrl(accessor.endpoint, accessor.repoType, accessor.repoId, `/commit/${revSegment(rev)}`)
}

/**
 * Ask the Hub how each file must be uploaded.
 *
 * The Hub decides regular-vs-LFS-vs-Xet from the repository's
 * `.gitattributes` and the file's size, so it is asked rather than guessed. It
 * only needs the first bytes to sniff the type, which is why a sample rather
 * than the content is sent.
 */
export async function uploadModes(
  accessor: HfHubAccessor,
  additions: Addition[],
  revision?: string,
): Promise<Map<string, string>> {
  const modes = new Map<string, string>()
  if (additions.length === 0) return modes
  const rev = revision ?? accessor.revision
  const url = apiUrl(
    accessor.endpoint,
    accessor.repoType,
    accessor.repoId,
    `/preupload/${revSegment(rev)}`,
  )
  for (let start = 0; start < additions.length; start += COMMIT_CHUNK) {
    const chunk = additions.slice(start, start + COMMIT_CHUNK)
    const body = {
      files: chunk.map((add) => ({
        path: add.path,
        sample: b64(add.data.slice(0, PREUPLOAD_SAMPLE_BYTES)),
        size: add.data.length,
      })),
    }
    const data = await hubPost(accessor.token, url, body, undefined, accessor.timeoutMs)
    const rows = (data as { files?: unknown }).files
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row !== 'object' || row === null) continue
      const item = row as { path?: unknown; uploadMode?: unknown }
      modes.set(
        typeof item.path === 'string' ? item.path : '',
        typeof item.uploadMode === 'string' ? item.uploadMode : REGULAR,
      )
    }
  }
  return modes
}

/**
 * Serialize one commit as newline-delimited JSON.
 *
 * The header line comes first and carries the message; every operation is one
 * line after it. This is the Hub's own shape, not a convention chosen here.
 */
export function payload(
  additions: Addition[],
  deletions: string[],
  message: string,
  description = '',
  parent = '',
): Uint8Array {
  const header: Record<string, unknown> = { summary: message, description }
  if (parent !== '') header.parentCommit = parent
  const lines: Record<string, unknown>[] = [{ key: 'header', value: header }]
  for (const add of additions) {
    lines.push({
      key: 'file',
      value: { content: b64(add.data), path: add.path, encoding: 'base64' },
    })
  }
  for (const path of deletions) lines.push({ key: 'deletedFile', value: { path } })
  return new TextEncoder().encode(lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
}

export interface CommitOptions {
  additions?: Addition[]
  deletions?: string[]
  message?: string
  description?: string
  createPr?: boolean
  revision?: string
}

/**
 * Apply one commit to the repository.
 *
 * Every addition is checked against the preupload endpoint first, and a file
 * the Hub wants uploaded out of band is refused here rather than referenced by
 * a commit whose content never arrived.
 */
export async function commit(
  accessor: HfHubAccessor,
  options: CommitOptions = {},
): Promise<Record<string, unknown>> {
  const adds = options.additions ?? []
  const modes = await uploadModes(accessor, adds, options.revision)
  const heavy = adds
    .filter((add) => (modes.get(add.path) ?? REGULAR) !== REGULAR)
    .map((add) => add.path)
    .sort(compareCodePoints)
  if (heavy.length > 0) {
    throw new LfsRequiredError(
      `${accessor.repoId}: the Hub requires an LFS upload for ${heavy.join(', ')}; ` +
        'write it with `hf upload` instead',
    )
  }
  const body = payload(
    adds,
    options.deletions ?? [],
    options.message ?? DEFAULT_COMMIT_MESSAGE,
    options.description ?? '',
  )
  const params = options.createPr === true ? { create_pr: '1' } : undefined
  const data = await hubPostNdjson(
    accessor.token,
    commitUrl(accessor, options.revision),
    body,
    params,
    accessor.timeoutMs,
  )
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}
