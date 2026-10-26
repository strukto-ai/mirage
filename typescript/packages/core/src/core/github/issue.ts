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
import { GRAPHQL_PATH } from './constants.ts'
import { githubPages } from './paginate.ts'
import { graphqlData, type RepoRef } from './repo.ts'

function path(ref: RepoRef, tail = ''): string {
  return `/repos/${ref.owner}/${ref.repo}/issues${tail}`
}

function onlyIssue(value: unknown, number: number): unknown {
  if (value !== null && typeof value === 'object' && 'pull_request' in value) {
    throw new Error(`#${String(number)} is a pull request, not an issue`)
  }
  return value
}

export async function listIssues(
  transport: GitHubTransport,
  ref: RepoRef,
  params: Record<string, string>,
  limit: number,
): Promise<Record<string, unknown>[]> {
  return githubPages(transport, path(ref), {
    params,
    limit,
    include: (row) => !('pull_request' in row),
  })
}

export async function getIssue(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
): Promise<unknown> {
  return onlyIssue(await transport.get(path(ref, `/${String(number)}`)), number)
}

export function createIssue(
  transport: GitHubTransport,
  ref: RepoRef,
  body: Record<string, unknown>,
): Promise<unknown> {
  return transport.request('POST', path(ref), body)
}

export async function editIssue(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  body: Record<string, unknown>,
): Promise<unknown> {
  await getIssue(transport, ref, number)
  return transport.request('PATCH', path(ref, `/${String(number)}`), body)
}

export async function commentIssue(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  body: string,
): Promise<unknown> {
  await getIssue(transport, ref, number)
  return transport.request('POST', path(ref, `/${String(number)}/comments`), { body })
}

const COMMENTS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      ... on Issue {
        comments(first: 100, after: $cursor) {
          nodes { ...CommentFields }
          pageInfo { hasNextPage endCursor }
        }
      }
      ... on PullRequest {
        comments(first: 100, after: $cursor) {
          nodes { ...CommentFields }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
}
fragment CommentFields on IssueComment {
  id
  author { login }
  authorAssociation
  body
  createdAt
  includesCreatedEdit
  isMinimized
  minimizedReason
  reactionGroups { content users { totalCount } }
  url
  viewerDidAuthor
}`

export async function issueComments(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  let cursor: string | null = null
  for (;;) {
    const response = (await transport.request('POST', GRAPHQL_PATH, {
      query: COMMENTS_QUERY,
      variables: { owner: ref.owner, repo: ref.repo, number, cursor },
    })) as {
      errors?: { message: string }[]
      data?: {
        repository: {
          issueOrPullRequest: {
            comments: {
              nodes: Record<string, unknown>[]
              pageInfo: { hasNextPage: boolean; endCursor: string | null }
            }
          } | null
        } | null
      }
    }
    if (response.errors?.length) throw new Error(response.errors.map((e) => e.message).join('; '))
    const comments = response.data?.repository?.issueOrPullRequest?.comments
    if (!comments) throw new Error('Could not resolve comments for this issue or pull request')
    for (const item of comments.nodes) rows.push(item)
    if (!comments.pageInfo.hasNextPage) return rows
    const next = comments.pageInfo.endCursor
    if (!next || next === cursor) throw new Error('GitHub returned a non-advancing comments cursor')
    cursor = next
  }
}

/** The selection for each half of gh's IssueByNumber; an empty one is left out. */
export interface IssueSelections {
  readonly issue: string
  readonly pull: string
}

/**
 * The selected fields of one issue, over GraphQL, as gh's IssueByNumber asks
 * for them for `issue view --json`: the number read as an issue or as a pull
 * request, each half with its own selection. A selection that reads a later
 * page of a connection is given that cursor as `endCursor`.
 *
 * Args:
 *   transport (GitHubTransport): the API client.
 *   ref (RepoRef): the repository.
 *   number (number): the issue or pull request.
 *   selections (IssueSelections): what to read of each.
 *   endCursor (string | undefined): the cursor `$endCursor` carries.
 */
export async function issueFields(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  selections: IssueSelections,
  endCursor?: string,
): Promise<Record<string, unknown>> {
  const variables: Record<string, unknown> = { owner: ref.owner, repo: ref.repo, number }
  if (endCursor !== undefined) variables.endCursor = endCursor
  const cursor = endCursor === undefined ? '' : ', $endCursor: String'
  const halves =
    (selections.issue === '' ? '' : `\n        ...on Issue{${selections.issue}}`) +
    (selections.pull === '' ? '' : `\n        ...on PullRequest{${selections.pull}}`)
  const data = await graphqlData(
    transport,
    `query IssueByNumber($owner: String!, $repo: String!, $number: Int!${cursor}) {\n` +
      '    repository(owner: $owner, name: $repo) {\n      hasIssuesEnabled\n' +
      `      issue: issueOrPullRequest(number: $number) {\n        __typename${halves}\n` +
      '      }\n    }\n  }',
    variables,
  )
  const repository = data.repository as
    | { hasIssuesEnabled?: unknown; issue?: unknown }
    | null
    | undefined
  const issue = repository?.issue
  if (issue !== null && typeof issue === 'object') return issue as Record<string, unknown>
  if (repository?.hasIssuesEnabled === false) {
    throw new Error(`the '${ref.owner}/${ref.repo}' repository has disabled issues`)
  }
  throw new Error('issue was not found but GraphQL reported no error')
}

/** The narrowing `gh issue list` applies before it lists. */
export interface IssueListFilter {
  readonly states: readonly string[]
  readonly assignee?: string | undefined
  readonly author?: string | undefined
  readonly labels?: readonly string[]
}

/**
 * The selected fields of a repository's issues, over GraphQL, as gh's
 * IssueList asks for them for `issue list --json`: newest first, a page of
 * up to 100 at a time until `limit`. gh reaches for search to narrow by
 * label; the connection's own `labels` filter narrows to the same issues.
 *
 * Args:
 *   transport (GitHubTransport): the API client.
 *   ref (RepoRef): the repository.
 *   filter (IssueListFilter): the states, assignee, author and labels.
 *   limit (number): how many issues at most.
 *   selection (string): the GraphQL selection for each issue.
 */
export async function listIssueFields(
  transport: GitHubTransport,
  ref: RepoRef,
  filter: IssueListFilter,
  limit: number,
  selection: string,
): Promise<Record<string, unknown>[]> {
  const query =
    `fragment issue on Issue {${selection}}\n` +
    '\tquery IssueList($owner: String!, $repo: String!, $limit: Int, $endCursor: String, ' +
    '$states: [IssueState!] = OPEN, $assignee: String, $author: String, $mention: String, ' +
    '$labels: [String!]) {\n\t\trepository(owner: $owner, name: $repo) {\n' +
    '\t\t\thasIssuesEnabled\n\t\t\tissues(first: $limit, after: $endCursor, orderBy: ' +
    '{field: CREATED_AT, direction: DESC}, states: $states, filterBy: {assignee: $assignee, ' +
    'createdBy: $author, mentioned: $mention, labels: $labels}) {\n\t\t\t\ttotalCount\n' +
    '\t\t\t\tnodes {\n\t\t\t\t\t...issue\n\t\t\t\t}\n\t\t\t\tpageInfo {\n' +
    '\t\t\t\t\thasNextPage\n\t\t\t\t\tendCursor\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n\t'
  const rows: Record<string, unknown>[] = []
  let cursor: string | null = null
  let pageLimit = Math.min(limit, 100)
  while (rows.length < limit) {
    const variables: Record<string, unknown> = {
      owner: ref.owner,
      repo: ref.repo,
      states: filter.states,
      limit: pageLimit,
    }
    if (filter.assignee !== undefined && filter.assignee !== '')
      variables.assignee = filter.assignee
    if (filter.author !== undefined && filter.author !== '') variables.author = filter.author
    if (filter.labels !== undefined && filter.labels.length > 0) variables.labels = filter.labels
    if (cursor !== null) variables.endCursor = cursor
    const data = await graphqlData(transport, query, variables)
    const repository = data.repository as {
      hasIssuesEnabled?: unknown
      issues?: {
        nodes?: Record<string, unknown>[]
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      }
    } | null
    if (repository?.hasIssuesEnabled === false) {
      throw new Error(`the '${ref.owner}/${ref.repo}' repository has disabled issues`)
    }
    const page = repository?.issues
    for (const node of page?.nodes ?? []) {
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
