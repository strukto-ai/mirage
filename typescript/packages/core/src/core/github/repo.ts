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

// Repository arguments are read as go-gh v2.13.0 reads them (MIT; see
// licenses/third_party/go-gh.txt).

import { stripSlash } from '../../utils/slash.ts'
import type { GitHubTransport } from './client.ts'
import { GRAPHQL_PATH } from './constants.ts'

export interface RepoRef {
  owner: string
  repo: string
}

export async function fetchDefaultBranch(
  transport: GitHubTransport,
  owner: string,
  repo: string,
): Promise<string> {
  const data = (await transport.get(`/repos/${owner}/${repo}`)) as { default_branch: string }
  return data.default_branch
}

// go-gh's IsURL: a word that starts `git@` or with a scheme a git remote uses
// names a repository by URL rather than as `[HOST/]OWNER/REPO`.
const URL_PREFIXES = ['git@', 'ssh:', 'git+ssh:', 'git:', 'http:', 'git+https:', 'https:']
// The schemes go-gh leaves alone before it reads an scp-style `host:path`.
const PROTOCOLS = [...URL_PREFIXES.slice(1), 'ftp:', 'ftps:', 'file:']

/**
 * A repository URL as go-gh's ParseURL reads it: `git@HOST:OWNER/REPO.git` is
 * scp syntax for `ssh://`, and a URL with no host is refused.
 */
function urlOf(spec: string): URL {
  let raw = spec
  if (
    !PROTOCOLS.some((prefix) => raw.startsWith(prefix)) &&
    raw.includes(':') &&
    !raw.includes('\\')
  )
    raw = `ssh://${raw.replace(':', '/')}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('no hostname detected')
  }
  if (url.hostname === '') throw new Error('no hostname detected')
  return url
}

/** The host a repository argument names, null for `OWNER/REPO`. */
export function repoHost(spec: string): string | null {
  if (URL_PREFIXES.some((prefix) => spec.startsWith(prefix))) return urlOf(spec).hostname
  const parts = spec.split('/')
  return parts.length === 3 ? (parts[0] ?? '').toLowerCase() : null
}

/**
 * A repository named by URL, read as go-gh's ParseURL and RepoInfoFromURL
 * read it: the path must be exactly two segments once its slashes are
 * trimmed, and `.git` comes off the name.
 */
function repoFromUrl(spec: string): RepoRef {
  const url = urlOf(spec)
  let path = url.pathname
  if (url.protocol === 'ssh:' && path.startsWith('//')) path = path.slice(1)
  const parts = stripSlash(path).split('/')
  const [owner, name] = parts
  if (parts.length !== 2 || owner === undefined || name === undefined) {
    throw new Error(`invalid path: ${path}`)
  }
  return { owner, repo: name.replace(/\.git$/, '') }
}

/**
 * The repository a word names, as gh reads it: a URL (`https://HOST/OWNER/REPO`,
 * `git@HOST:OWNER/REPO.git`) or `[HOST/]OWNER/REPO`. The host is optional and
 * leading, so the owner and the repository are always the last two segments.
 * Taking the first two instead read `github.com/acme/tools` as owner
 * `github.com`, repo `acme` -- a different repository, reported as success.
 *
 * Args:
 *   spec (string): the repository as the line spelled it.
 *
 * Returns:
 *   RepoRef: the owner and repository names.
 */
export function parseRepo(spec: string): RepoRef {
  if (URL_PREFIXES.some((prefix) => spec.startsWith(prefix))) return repoFromUrl(spec)
  const parts = spec.split('/')
  const owner = parts[parts.length - 2]
  const repo = parts[parts.length - 1]
  // One more segment is a host; two is not a repository any spelling reaches.
  if (
    (parts.length !== 2 && parts.length !== 3) ||
    parts.some((part) => part === '') ||
    owner === undefined ||
    repo === undefined
  ) {
    throw new Error(`expected the "[HOST/]OWNER/REPO" format, got "${spec}"`)
  }
  return { owner, repo }
}

export async function login(transport: GitHubTransport): Promise<string> {
  const me = (await transport.get('/user')) as { login?: string }
  return me.login ?? ''
}

/**
 * Run one GraphQL query and return its data, refusing the way gh does.
 *
 * gh names each error with the path of the field that raised it and joins
 * them: `GraphQL: Could not resolve to a Repository with the name 'o/r'.
 * (repository)`.
 */
export async function graphqlData(
  transport: GitHubTransport,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await transport.request('POST', GRAPHQL_PATH, { query, variables })) as {
    data?: Record<string, unknown> | null
    errors?: {
      message?: string
      path?: (string | number)[]
    }[]
  }
  if (response.errors !== undefined && response.errors.length > 0) {
    const messages = response.errors.map((error) => {
      const path = (error.path ?? []).map(String).join('.')
      return path === '' ? (error.message ?? '') : `${error.message ?? ''} (${path})`
    })
    throw new Error(`GraphQL: ${messages.join(', ')}`)
  }
  return response.data ?? {}
}

/**
 * The selected fields of one repository, over GraphQL, as gh reads them for
 * `repo view --json`: one query naming only what was asked for.
 *
 * Args:
 *   transport (GitHubTransport): the API client.
 *   ref (RepoRef): the repository.
 *   selection (string): the GraphQL selection inside `repository { }`.
 */
