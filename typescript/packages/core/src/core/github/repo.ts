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

import { GitHubApiError, type GitHubTransport } from './client.ts'
import { GRAPHQL_PATH } from './constants.ts'
import { decodeBase64 } from '../../utils/base64.ts'
import { stripSlash } from '../../utils/slash.ts'
import { githubPages } from './paginate.ts'

export interface RepoRef {
  owner: string
  repo: string
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

export function viewRepo(transport: GitHubTransport, ref: RepoRef): Promise<unknown> {
  return transport.get(`/repos/${ref.owner}/${ref.repo}`)
}

interface GraphQLErrorRow {
  message?: string
  path?: (string | number)[]
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
    errors?: GraphQLErrorRow[]
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
export async function repositoryFields(
  transport: GitHubTransport,
  ref: RepoRef,
  selection: string,
): Promise<Record<string, unknown>> {
  const data = await graphqlData(
    transport,
    `query RepositoryInfo($owner: String!, $name: String!) {\n` +
      `    repository(owner: $owner, name: $name) {${selection}}\n  }`,
    { owner: ref.owner, name: ref.repo },
  )
  return (data.repository ?? {}) as Record<string, unknown>
}

/**
 * The selected fields of an owner's repositories, over GraphQL, as gh reads
 * them for `repo list --json`: the owner's own, most recently pushed first, a
 * page of up to 100 at a time until `limit`. No owner means the viewer.
 *
 * Args:
 *   transport (GitHubTransport): the API client.
 *   owner (string | undefined): the user or organization, or the viewer.
 *   limit (number): how many repositories at most.
 *   selection (string): the GraphQL selection for each repository.
 */
export async function listRepositoryFields(
  transport: GitHubTransport,
  owner: string | undefined,
  limit: number,
  selection: string,
): Promise<Record<string, unknown>[]> {
  const head =
    owner === undefined
      ? 'query RepositoryList($perPage:Int!,$endCursor:String,$privacy:RepositoryPrivacy,' +
        '$fork:Boolean) {\n    repositoryOwner: viewer {'
      : 'query RepositoryList($perPage:Int!,$endCursor:String,$privacy:RepositoryPrivacy,' +
        '$fork:Boolean,$owner:String!) {\n    repositoryOwner(login: $owner) {'
  const query =
    `${head}\n      login\n      repositories(first: $perPage, after: $endCursor, ` +
    'privacy: $privacy, isFork: $fork, ownerAffiliations: OWNER, orderBy: { field: ' +
    `PUSHED_AT, direction: DESC }) {\n        nodes{${selection}}\n        totalCount\n` +
    '        pageInfo{hasNextPage,endCursor}\n      }\n    }\n  }'
  const rows: Record<string, unknown>[] = []
  let cursor: string | null = null
  while (rows.length < limit) {
    const variables: Record<string, unknown> = { perPage: Math.min(limit, 100) }
    if (owner !== undefined) variables.owner = owner
    if (cursor !== null) variables.endCursor = cursor
    const data = await graphqlData(transport, query, variables)
    const page = (
      data.repositoryOwner as {
        repositories?: {
          nodes?: Record<string, unknown>[]
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
        }
      } | null
    )?.repositories
    rows.push(...(page?.nodes ?? []))
    const next = page?.pageInfo?.endCursor ?? null
    if (page?.pageInfo?.hasNextPage !== true || next === null || next === cursor) break
    cursor = next
  }
  return rows.slice(0, limit)
}

/**
 * The repository's README as text, or null when it has none.
 */
export async function readReadme(transport: GitHubTransport, ref: RepoRef): Promise<string | null> {
  let data: unknown
  try {
    data = await transport.get(`/repos/${ref.owner}/${ref.repo}/readme`)
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return null
    throw err
  }
  const content = (data as { content?: unknown } | null)?.content
  if (typeof content !== 'string') return null
  return new TextDecoder().decode(decodeBase64(content))
}

/** Fork a repository: `body` carries the request's `name`, `organization` and `default_branch_only`. */
export function forkRepo(
  transport: GitHubTransport,
  ref: RepoRef,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  return transport.request('POST', `/repos/${ref.owner}/${ref.repo}/forks`, body)
}

/** Change a repository's settings: the one `PATCH` `gh repo edit` sends. */
export function editRepo(
  transport: GitHubTransport,
  ref: RepoRef,
  body: Record<string, unknown>,
): Promise<unknown> {
  return transport.request('PATCH', `/repos/${ref.owner}/${ref.repo}`, body)
}

/** A repository's topics, which GitHub keeps and replaces as one list. */
export async function repoTopics(transport: GitHubTransport, ref: RepoRef): Promise<string[]> {
  const data = (await transport.get(`/repos/${ref.owner}/${ref.repo}/topics`)) as {
    names?: unknown
  } | null
  const names = data?.names
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
}

export function setRepoTopics(
  transport: GitHubTransport,
  ref: RepoRef,
  names: readonly string[],
): Promise<unknown> {
  return transport.request('PUT', `/repos/${ref.owner}/${ref.repo}/topics`, { names })
}

export function deleteRepo(transport: GitHubTransport, ref: RepoRef): Promise<unknown> {
  return transport.request('DELETE', `/repos/${ref.owner}/${ref.repo}`)
}

export function renameRepo(
  transport: GitHubTransport,
  ref: RepoRef,
  name: string,
): Promise<unknown> {
  return transport.request('PATCH', `/repos/${ref.owner}/${ref.repo}`, { name })
}

export async function listRepos(
  transport: GitHubTransport,
  owner: string | undefined,
  limit: number,
): Promise<Record<string, unknown>[]> {
  let path = '/user/repos'
  if (owner !== undefined) {
    const account = (await transport.get(`/users/${owner}`)) as { type?: unknown }
    const prefix = account.type === 'Organization' ? 'orgs' : 'users'
    path = `/${prefix}/${owner}/repos`
  }
  return githubPages(transport, path, { params: { sort: 'pushed' }, limit })
}

export async function createRepo(
  transport: GitHubTransport,
  owner: string | undefined,
  body: Record<string, unknown>,
): Promise<unknown> {
  const personal =
    owner === undefined || owner.toLowerCase() === (await login(transport)).toLowerCase()
  const path = personal ? '/user/repos' : `/orgs/${owner}/repos`
  return transport.request('POST', path, body)
}
