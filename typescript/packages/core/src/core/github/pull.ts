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

import type { GitHubTransport } from './client.ts'
import { githubPages } from './paginate.ts'
import { graphqlData, type RepoRef } from './repo.ts'

function path(ref: RepoRef, tail = ''): string {
  return `/repos/${ref.owner}/${ref.repo}/pulls${tail}`
}

export function listPulls(
  transport: GitHubTransport,
  ref: RepoRef,
  params: Record<string, string>,
  limit: number,
  include?: (row: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
  return githubPages(transport, path(ref), {
    params,
    limit,
    ...(include === undefined ? {} : { include }),
  })
}

export function getPull(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
): Promise<unknown> {
  return transport.get(path(ref, `/${String(number)}`))
}

/**
 * The selected fields of one pull request, over GraphQL, as gh's
 * PullRequestByNumber asks for them for `pr view --json`: one query naming
 * only what was asked for. A selection that reads the page of a connection
 * after `$endCursor` is given that cursor as `endCursor`.
 *
 * Args:
 *   transport (GitHubTransport): the API client.
 *   ref (RepoRef): the repository.
 *   number (number): the pull request.
 *   selection (string): the GraphQL selection inside `pullRequest { }`.
 *   endCursor (string | undefined): the cursor `$endCursor` carries.
 */
export async function pullRequestFields(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  selection: string,
  endCursor?: string,
): Promise<Record<string, unknown>> {
  const variables: Record<string, unknown> = { owner: ref.owner, repo: ref.repo, pr_number: number }
  if (endCursor !== undefined) variables.endCursor = endCursor
  const cursor = endCursor === undefined ? '' : ', $endCursor: String'
  const data = await graphqlData(
    transport,
    `query PullRequestByNumber($owner: String!, $repo: String!, $pr_number: Int!${cursor}) {\n` +
      '    repository(owner: $owner, name: $repo) {\n' +
      `      pullRequest(number: $pr_number) {${selection}}\n` +
      '    }\n  }',
    variables,
  )
  const repository = data.repository as { pullRequest?: unknown } | null | undefined
  const pull = repository?.pullRequest
  return pull !== null && typeof pull === 'object' ? (pull as Record<string, unknown>) : {}
}

/** The narrowing `gh pr list` applies before it lists. */
export interface PullListFilter {
  readonly states: readonly string[]
  readonly base?: string | undefined
  readonly head?: string | undefined
}

const PULL_LIST =
  '    query PullRequestList(\n      $owner: String!,\n      $repo: String!,\n' +
  '      $limit: Int!,\n      $endCursor: String,\n      $baseBranch: String,\n' +
  '      $headBranch: String,\n      $state: [PullRequestState!] = OPEN\n    ) {\n' +
  '      repository(owner: $owner, name: $repo) {\n        pullRequests(\n' +
  '          states: $state,\n          baseRefName: $baseBranch,\n' +
  '          headRefName: $headBranch,\n          first: $limit,\n' +
  '          after: $endCursor,\n          orderBy: {field: CREATED_AT, direction: DESC}\n' +
  '        ) {\n          totalCount\n          nodes {\n            ...pr\n' +
  '          }\n          pageInfo {\n            hasNextPage\n            endCursor\n' +
  '          }\n        }\n      }\n    }'

/**
 * The selected fields of a repository's pull requests, over GraphQL, as
 * gh's PullRequestList asks for them for `pr list --json`: newest first, a
 * page of up to 100 at a time until `limit`. A pull request a later page
 * repeats is listed once, which gh can only tell when the line asked for
 * `number`.
 *
 * Args:
 *   transport (GitHubTransport): the API client.
 *   ref (RepoRef): the repository.
 *   filter (PullListFilter): the states and the base and head branches.
 *   limit (number): how many pull requests at most.
 *   selection (string): the GraphQL selection for each pull request.
 */
export async function listPullRequestFields(
  transport: GitHubTransport,
  ref: RepoRef,
  filter: PullListFilter,
  limit: number,
  selection: string,
): Promise<Record<string, unknown>[]> {
  const query = `fragment pr on PullRequest{${selection}}\n${PULL_LIST}`
  const rows: Record<string, unknown>[] = []
  const seen = new Set<number>()
  let cursor: string | null = null
  let pageLimit = Math.min(limit, 100)
  while (rows.length < limit) {
    const variables: Record<string, unknown> = {
      owner: ref.owner,
      repo: ref.repo,
      limit: pageLimit,
      state: filter.states,
    }
    if (filter.base !== undefined && filter.base !== '') variables.baseBranch = filter.base
    if (filter.head !== undefined && filter.head !== '') variables.headBranch = filter.head
    if (cursor !== null) variables.endCursor = cursor
    const data = await graphqlData(transport, query, variables)
    const page = (
      data.repository as {
        pullRequests?: {
          nodes?: Record<string, unknown>[]
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
        }
      } | null
    )?.pullRequests
    for (const node of page?.nodes ?? []) {
      const number = node.number
      if (typeof number === 'number' && number > 0) {
        if (seen.has(number)) continue
        seen.add(number)
      }
      rows.push(node)
      if (rows.length === limit) break
    }
    const next = page?.pageInfo?.endCursor ?? null
    if (page?.pageInfo?.hasNextPage !== true || next === null || next === cursor) break
    cursor = next
    pageLimit = Math.min(pageLimit, limit - rows.length)
  }
  return rows
}

export function createPull(
  transport: GitHubTransport,
  ref: RepoRef,
  body: Record<string, unknown>,
): Promise<unknown> {
  return transport.request('POST', path(ref), body)
}

export function editPull(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  body: Record<string, unknown>,
): Promise<unknown> {
  return transport.request('PATCH', path(ref, `/${String(number)}`), body)
}

export function mergePull(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  body: Record<string, unknown>,
): Promise<unknown> {
  return transport.request(
    'PUT',
    path(ref, `/${String(number)}/merge`),
    Object.keys(body).length === 0 ? undefined : body,
  )
}

export async function commentPull(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  body: string,
): Promise<unknown> {
  await getPull(transport, ref, number)
  return transport.request(
    'POST',
    `/repos/${ref.owner}/${ref.repo}/issues/${String(number)}/comments`,
    { body },
  )
}

export async function diffPull(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
): Promise<string> {
  const value = await transport.request(
    'GET',
    path(ref, `/${String(number)}`),
    undefined,
    undefined,
    { Accept: 'application/vnd.github.v3.diff' },
  )
  return typeof value === 'string' ? value : ''
}

const STATUS_CONCLUSIONS = ['error', 'failure', 'success']

function statusCheck(row: Record<string, unknown>): Record<string, unknown> {
  const state = typeof row.state === 'string' ? row.state : ''
  const done = STATUS_CONCLUSIONS.includes(state)
  return {
    name: row.context ?? '',
    status: done ? 'completed' : state,
    conclusion: done ? state : null,
    details_url: row.target_url ?? '',
    output: { summary: row.description ?? '' },
    started_at: row.created_at ?? null,
    completed_at: row.updated_at ?? null,
  }
}

export async function commitStatuses(
  transport: GitHubTransport,
  ref: RepoRef,
  sha: string,
): Promise<Record<string, unknown>[]> {
  const value = (await transport.get(`/repos/${ref.owner}/${ref.repo}/commits/${sha}/status`)) as {
    statuses?: unknown
  } | null
  const rows = value?.statuses
  if (!Array.isArray(rows)) return []
  return rows.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  )
}

export async function pullChecks(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  limit = 100,
): Promise<Record<string, unknown>[]> {
  const pull = (await getPull(transport, ref, number)) as { head?: { sha?: unknown } }
  const sha = pull.head?.sha
  if (typeof sha !== 'string') return []
  const runs = await githubPages(
    transport,
    `/repos/${ref.owner}/${ref.repo}/commits/${sha}/check-runs`,
    { limit, key: 'check_runs' },
  )
  const statuses = await commitStatuses(transport, ref, sha)
  return [...runs, ...statuses.map(statusCheck)]
}
