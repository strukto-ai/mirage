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

import type { HfAccountAccessor } from '../../accessor/hf_hub.ts'
import { HfHubError, hubGet, hubPost, hubRequest, repoUrl, revSegment } from './client.ts'
import { API_SEGMENTS, DEFAULT_REVISION, HTTP_CONFLICT } from './constants.ts'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'

/**
 * The organization and name halves the repo endpoints take.
 *
 * The create and delete endpoints do not take a `namespace/name` id: they take
 * the two apart, and an id with no namespace means the caller's own, which the
 * Hub fills in from the token.
 */
export function splitRepoId(repoId: string): [string | null, string] {
  const cut = repoId.indexOf('/')
  if (cut === -1) return [null, repoId]
  return [repoId.slice(0, cut), repoId.slice(cut + 1)]
}

function repoApiUrl(
  account: HfAccountAccessor,
  repoType: string,
  repoId: string,
  suffix: string,
): string {
  const segment = API_SEGMENTS[repoType] ?? 'models'
  return `${rstripSlash(account.endpoint)}/api/${segment}/${repoId}${suffix}`
}

export interface CreateRepoOptions {
  repoType?: string
  private?: boolean
  spaceSdk?: string | undefined
  /**
   * Treat the Hub's 409 as success, answering with the repository url
   * derived from the id rather than the one the create call would have
   * returned.
   */
  existOk?: boolean
  /**
   * The Enterprise resource group to create the repository in. Spelled
   * `resourceGroupId` on the wire, which is huggingface_hub's own spelling.
   */
  resourceGroupId?: string | undefined
}

/** Create a repository on the Hub. */
export async function createRepo(
  account: HfAccountAccessor,
  repoId: string,
  options: CreateRepoOptions = {},
): Promise<Record<string, unknown>> {
  const [organization, name] = splitRepoId(repoId)
  const body: Record<string, unknown> = {
    name,
    organization,
    type: options.repoType ?? 'model',
  }
  if (options.private === true) body.visibility = 'private'
  if (options.spaceSdk !== undefined && options.spaceSdk !== '') body.sdk = options.spaceSdk
  if (options.resourceGroupId !== undefined && options.resourceGroupId !== '') {
    body.resourceGroupId = options.resourceGroupId
  }
  const url = `${rstripSlash(account.endpoint)}/api/repos/create`
  let data: unknown
  try {
    data = await hubPost(account, url, body)
  } catch (err) {
    if (options.existOk !== true || !(err instanceof HfHubError) || err.status !== HTTP_CONFLICT) {
      throw err
    }
    return { url: repoUrl(account.endpoint, options.repoType ?? 'model', repoId) }
  }
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

/** Tag a revision of a repository. */
export async function createTag(
  account: HfAccountAccessor,
  repoId: string,
  tag: string,
  repoType = 'model',
  revision: string = DEFAULT_REVISION,
  message?: string,
): Promise<void> {
  const body: Record<string, unknown> = { tag }
  if (message !== undefined) body.message = message
  await hubPost(
    account,
    repoApiUrl(account, repoType, repoId, `/tag/${revSegment(revision)}`),
    body,
  )
}

/** Remove a tag from a repository. */
export async function deleteTag(
  account: HfAccountAccessor,
  repoId: string,
  tag: string,
  repoType = 'model',
): Promise<void> {
  await hubRequest(
    account,
    'DELETE',
    repoApiUrl(account, repoType, repoId, `/tag/${revSegment(tag)}`),
    null,
  )
}

/**
 * Every tag on a repository.
 *
 * Read from /refs, which is the only endpoint that enumerates them; there is
 * no tag listing of its own.
 */
export async function listTags(
  account: HfAccountAccessor,
  repoId: string,
  repoType = 'model',
): Promise<string[]> {
  const data = await hubGet(account, repoApiUrl(account, repoType, repoId, '/refs'))
  const rows = (data as { tags?: unknown }).tags
  const names: string[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row === 'object' && row !== null) {
      const name = (row as { name?: unknown }).name
      if (typeof name === 'string') names.push(name)
    }
  }
  return names
}
