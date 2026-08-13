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

import type { GitHubTransport } from './_client.ts'

export interface RepoRef {
  owner: string
  repo: string
}

/**
 * gh's `[HOST/]OWNER/REPO`: the host is optional and leading, so the owner and
 * the repository are always the last two segments. Taking the first two
 * instead read `github.com/acme/tools` as owner `github.com`, repo `acme` --
 * a different repository, reported as success.
 *
 * Args:
 *   spec (string): the repository as the line spelled it.
 *
 * Returns:
 *   RepoRef: the owner and repository names.
 */
export function parseRepo(spec: string): RepoRef {
  const parts = spec.split('/')
  const repo = parts.pop()
  const owner = parts.pop()
  if (owner === undefined || repo === undefined || owner === '' || repo === '') {
    throw new Error(`expected the "[HOST/]OWNER/REPO" format, got "${spec}"`)
  }
  // One more segment is a host; two is not a repository any spelling reaches.
  if (parts.length > 1) {
    throw new Error(`expected the "[HOST/]OWNER/REPO" format, got "${spec}"`)
  }
  return { owner, repo }
}

export async function login(transport: GitHubTransport): Promise<string> {
  const me = (await transport.get('/user')) as { login?: string }
  return me.login ?? ''
}

export function viewRepo(transport: GitHubTransport, ref: RepoRef): Promise<unknown> {
  return transport.get(`/repos/${ref.owner}/${ref.repo}`)
}

export function forkRepo(
  transport: GitHubTransport,
  ref: RepoRef,
  name?: string,
): Promise<unknown> {
  const body = name === undefined ? {} : { name }
  return transport.request('POST', `/repos/${ref.owner}/${ref.repo}/forks`, body)
}

export function renameRepo(
  transport: GitHubTransport,
  ref: RepoRef,
  name: string,
): Promise<unknown> {
  return transport.request('PATCH', `/repos/${ref.owner}/${ref.repo}`, { name })
}
