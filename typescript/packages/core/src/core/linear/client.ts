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

import { apiRequest } from '../api/client.ts'
import { enoent } from '../../errors/fs.ts'
import {
  COMMENT_CREATE_MUTATION,
  COMMENT_UPDATE_MUTATION,
  ISSUE_COMMENTS_QUERY,
  ISSUE_CREATE_MUTATION,
  ISSUE_LOOKUP_QUERY,
  ISSUE_QUERY,
  ISSUE_SEARCH_QUERY,
  ISSUE_UPDATE_MUTATION,
  TEAM_CYCLES_QUERY,
  TEAM_DOCUMENTS_QUERY,
  TEAM_ISSUES_QUERY,
  TEAM_LABELS_QUERY,
  TEAM_LIST_QUERY,
  TEAM_MEMBERS_QUERY,
  TEAM_PROJECTS_QUERY,
  USER_LOOKUP_QUERY,
} from './queries.ts'

class LinearApiError extends Error {
  constructor(
    message: string,
    public readonly errors: readonly unknown[] = [],
    public readonly status: number | null = null,
  ) {
    super(message)
    this.name = 'LinearApiError'
  }
}

export interface LinearTransport {
  graphql(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>>
}

export interface HttpLinearTransportOptions {
  apiKey: string
  baseUrl?: string
}

interface GraphQLResponse {
  data?: Record<string, unknown>
  errors?: { message?: string }[]
}

function errorMessage(errors: { message?: string }[] | undefined): string | null {
  if (errors === undefined || errors.length === 0) return null
  const first = errors[0]
  return first?.message ?? null
}

function linearError(response: Response, text: string): LinearApiError {
  let errors: { message?: string }[] = []
  try {
    errors = (JSON.parse(text) as GraphQLResponse).errors ?? []
  } catch {
    // a non-JSON error body: fall through to the bare status code
  }
  const msg = errorMessage(errors) ?? `Linear API error: HTTP ${String(response.status)}`
  return new LinearApiError(msg, errors, response.status)
}

export class HttpLinearTransport implements LinearTransport {
  protected readonly fetch: typeof fetch = globalThis.fetch.bind(globalThis)
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(opts: HttpLinearTransportOptions) {
    this.apiKey = opts.apiKey
    this.baseUrl = opts.baseUrl ?? 'https://api.linear.app/graphql'
  }

  async graphql(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const data = ((await apiRequest('POST', this.baseUrl, {
      fetchFn: this.fetch,
      headers: { Authorization: this.apiKey, 'Content-Type': 'application/json' },
      json: { query, variables },
      errorOf: linearError,
    })) ?? {}) as GraphQLResponse
    if (data.errors !== undefined && data.errors.length > 0) {
      const msg = errorMessage(data.errors) ?? 'Linear API error'
      throw new LinearApiError(msg, data.errors)
    }
    return data.data ?? {}
  }
}

interface PageInfo {
  hasNextPage: boolean
  endCursor: string | null
}

interface Connection {
  nodes: Record<string, unknown>[]
  pageInfo: PageInfo
}

function navigate(root: Record<string, unknown>, path: readonly string[]): Connection {
  let cursor: unknown = root
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') {
      throw new LinearApiError(`unexpected GraphQL shape at ${path.join('.')}`)
    }
    cursor = (cursor as Record<string, unknown>)[key]
  }
  if (cursor === null || typeof cursor !== 'object') {
    throw new LinearApiError(`unexpected GraphQL shape at ${path.join('.')}`)
  }
  return cursor as unknown as Connection
}

async function paginate(
  transport: LinearTransport,
  query: string,
  variables: Record<string, unknown>,
  path: readonly string[],
): Promise<Record<string, unknown>[]> {
  const merged: Record<string, unknown> = { first: 50, after: null, ...variables }
  const nodes: Record<string, unknown>[] = []
  for (;;) {
    const data = await transport.graphql(query, merged)
    const conn = navigate(data, path)
    nodes.push(...conn.nodes)
    if (!conn.pageInfo.hasNextPage) return nodes
    merged.after = conn.pageInfo.endCursor
  }
}

export async function listTeams(transport: LinearTransport): Promise<Record<string, unknown>[]> {
  return paginate(transport, TEAM_LIST_QUERY, {}, ['teams'])
}

export async function listTeamMembers(
  transport: LinearTransport,
  teamId: string,
): Promise<Record<string, unknown>[]> {
  return paginate(transport, TEAM_MEMBERS_QUERY, { teamId }, ['team', 'members'])
}

export async function listTeamIssues(
  transport: LinearTransport,
  teamId: string,
): Promise<Record<string, unknown>[]> {
  return paginate(transport, TEAM_ISSUES_QUERY, { teamId }, ['team', 'issues'])
}

export async function listTeamProjects(
  transport: LinearTransport,
  teamId: string,
): Promise<Record<string, unknown>[]> {
  return paginate(transport, TEAM_PROJECTS_QUERY, { teamId }, ['team', 'projects'])
}

export async function listTeamCycles(
  transport: LinearTransport,
  teamId: string,
): Promise<Record<string, unknown>[]> {
  return paginate(transport, TEAM_CYCLES_QUERY, { teamId }, ['team', 'cycles'])
}

export async function listTeamLabels(
  transport: LinearTransport,
  teamId: string,
): Promise<Record<string, unknown>[]> {
  return paginate(transport, TEAM_LABELS_QUERY, { teamId }, ['team', 'labels'])
}

export async function listTeamDocuments(
  transport: LinearTransport,
  teamId: string,
): Promise<Record<string, unknown>[]> {
  return paginate(transport, TEAM_DOCUMENTS_QUERY, { teamId }, ['team', 'documents'])
}

export async function resolveTeam(
  transport: LinearTransport,
  keyOrId: string,
): Promise<Record<string, unknown>> {
  const teams = await listTeams(transport)
  for (const team of teams) {
    if (team.id === keyOrId || team.key === keyOrId) return team
  }
  throw enoent(keyOrId)
}

export async function getIssue(
  transport: LinearTransport,
  issueId: string,
): Promise<Record<string, unknown>> {
  const data = await transport.graphql(ISSUE_QUERY, { issueId })
  const issue = data.issue
  if (issue === null || issue === undefined || typeof issue !== 'object') {
    throw new LinearApiError(`issue not found: ${issueId}`)
  }
  return issue as Record<string, unknown>
}

export async function listIssueComments(
  transport: LinearTransport,
  issueId: string,
): Promise<Record<string, unknown>[]> {
  return paginate(transport, ISSUE_COMMENTS_QUERY, { issueId }, ['issue', 'comments'])
}

export async function resolveIssueId(
  transport: LinearTransport,
  issueId: string | null,
  issueKey: string | null,
): Promise<string> {
  if (issueId !== null && issueId !== '') return issueId
  if (issueKey === null || issueKey === '') {
    throw new Error('issue id or issue key is required')
  }
  const dash = issueKey.indexOf('-')
  if (dash === -1) throw new Error(`invalid issue key: ${issueKey}`)
  const teamKey = issueKey.slice(0, dash)
  const numberStr = issueKey.slice(dash + 1)
  if (!/^\d+$/.test(numberStr)) throw new Error(`invalid issue key: ${issueKey}`)
  const data = await transport.graphql(ISSUE_LOOKUP_QUERY, {
    teamKey,
    number: Number.parseFloat(numberStr),
  })
  const issuesField = data.issues
  const nodes =
    issuesField !== null && typeof issuesField === 'object'
      ? ((issuesField as Record<string, unknown>).nodes as Record<string, unknown>[] | undefined)
      : undefined
  const first = nodes?.[0]
  if (first === undefined) throw enoent(issueKey)
  const id = first.id
  if (typeof id !== 'string') throw enoent(issueKey)
  return id
}

export async function resolveUserId(
  transport: LinearTransport,
  assigneeId: string | null,
  assigneeEmail: string | null,
): Promise<string> {
  if (assigneeId !== null && assigneeId !== '') return assigneeId
  if (assigneeEmail === null || assigneeEmail === '') {
    throw new Error('assignee id or assignee email is required')
  }
  const data = await transport.graphql(USER_LOOKUP_QUERY, { email: assigneeEmail })
  const usersField = data.users
  const nodes =
    usersField !== null && typeof usersField === 'object'
      ? ((usersField as Record<string, unknown>).nodes as Record<string, unknown>[] | undefined)
      : undefined
  const first = nodes?.[0]
  if (first === undefined) throw enoent(assigneeEmail)
  const id = first.id
  if (typeof id !== 'string') throw enoent(assigneeEmail)
  return id
}

export interface IssueCreateInput {
  teamId: string
  title: string
  description?: string | null
}

export async function issueCreate(
  transport: LinearTransport,
  input: IssueCreateInput,
): Promise<Record<string, unknown>> {
  if (input.teamId === '') {
    throw new Error('teamId is required')
  }
  const payload: Record<string, unknown> = { title: input.title, teamId: input.teamId }
  if (input.description !== undefined && input.description !== null && input.description !== '') {
    payload.description = input.description
  }
  const data = await transport.graphql(ISSUE_CREATE_MUTATION, { input: payload })
  const created = data.issueCreate as { issue?: { id?: string } } | undefined
  const id = created?.issue?.id
  if (id === undefined) throw new LinearApiError('issueCreate returned no id')
  return getIssue(transport, id)
}

export interface IssueUpdateInput {
  issueId: string
  title?: string | null
  description?: string | null
  stateId?: string | null
  assigneeId?: string | null
  priority?: number | null
  projectId?: string | null
  labelIds?: readonly string[] | null
}

export async function issueUpdate(
  transport: LinearTransport,
  input: IssueUpdateInput,
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {}
  if (input.title !== undefined && input.title !== null) payload.title = input.title
  if (input.description !== undefined && input.description !== null) {
    payload.description = input.description
  }
  if (input.stateId !== undefined && input.stateId !== null) payload.stateId = input.stateId
  if (input.assigneeId !== undefined && input.assigneeId !== null) {
    payload.assigneeId = input.assigneeId
  }
  if (input.priority !== undefined && input.priority !== null) payload.priority = input.priority
  if (input.projectId !== undefined && input.projectId !== null) {
    payload.projectId = input.projectId
  }
  if (input.labelIds !== undefined && input.labelIds !== null) {
    payload.labelIds = [...input.labelIds]
  }
  if (Object.keys(payload).length === 0) {
    throw new Error('no updates provided')
  }
  await transport.graphql(ISSUE_UPDATE_MUTATION, { id: input.issueId, input: payload })
  return getIssue(transport, input.issueId)
}

export async function commentCreate(
  transport: LinearTransport,
  issueId: string,
  body: string,
): Promise<Record<string, unknown>> {
  await transport.graphql(COMMENT_CREATE_MUTATION, { input: { issueId, body } })
  const comments = await listIssueComments(transport, issueId)
  const last = comments[comments.length - 1]
  if (last === undefined) {
    throw new LinearApiError('comment was created but no comments were returned')
  }
  return last
}

export async function commentUpdate(
  transport: LinearTransport,
  commentId: string,
  body: string,
): Promise<Record<string, unknown>> {
  const data = await transport.graphql(COMMENT_UPDATE_MUTATION, {
    id: commentId,
    input: { body },
  })
  const updated = data.commentUpdate as
    | { comment?: { id?: string; issue?: { id?: string } } }
    | undefined
  const comment = updated?.comment ?? {}
  const issueId = comment.issue?.id
  if (issueId !== undefined) {
    const comments = await listIssueComments(transport, issueId)
    for (const item of comments) {
      if (item.id === commentId) return item
    }
  }
  return comment as Record<string, unknown>
}

export async function searchIssues(
  transport: LinearTransport,
  query: string,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const data = await transport.graphql(ISSUE_SEARCH_QUERY, { term: query, first: limit })
  const search = data.searchIssues
  if (search === null || typeof search !== 'object') return []
  const nodes = (search as Record<string, unknown>).nodes
  return Array.isArray(nodes) ? (nodes as Record<string, unknown>[]) : []
}
