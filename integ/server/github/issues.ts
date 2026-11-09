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

import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { API_PREFIXES, DEFAULT_LOGIN } from './config.ts'
import type { C } from './config.ts'
import { isPinned, lockReason, nextNumber, scope } from './store.ts'
import type { RepoRow } from './store.ts'
import {
  authedRoute,
  everywhere,
  fail,
  jsonBodyOf,
  numberParam,
  ordered,
  pagedReply,
  route,
  str,
  withRepo,
} from './http.ts'
import { pullJson, pullRow } from './pulls.ts'
import type { PullRow } from './pulls.ts'
import {
  PROJECTS_CLASSIC_GONE,
  closedNumbers,
  issueNodeId,
  nodeId,
  page,
  pullNodeId,
  reactionGroups,
  userNode,
} from './wire.ts'
import type { PageArgs } from './wire.ts'

// Both timestamps are fixed rather than taken from the clock: a golden renders
// them, so a real one would make every case that files an issue unassertable.
const CREATED_AT = '2026-01-01T00:00:00Z'
const EDITED_AT = '2026-01-01T00:02:00Z'

export interface IssueRow {
  number: number
  title: string
  body: string
  state: string
  user: string
  labelsJson: string
  assigneesJson: string
  stateReason: string
  closedAt: string
  createdAt: string
  updatedAt: string
}

function names(json: string): string[] {
  const parsed = JSON.parse(json) as JsonValue
  return Array.isArray(parsed) ? parsed.map((v) => String(v)) : []
}

// The vendor takes a label or assignee list as bare names and reports it as a
// list of objects, so the column stores the names and each render wraps them.
function nameList(value: JsonValue | undefined): string {
  return JSON.stringify(Array.isArray(value) ? value.map((v) => String(v)) : [])
}

export function issueJson(repo: RepoRow, row: IssueRow): JsonValue {
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    state_reason: row.stateReason === '' ? null : row.stateReason,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    closed_at: row.closedAt === '' ? null : row.closedAt,
    user: { login: row.user },
    assignees: names(row.assigneesJson).map((login) => ({ login })),
    labels: names(row.labelsJson).map((name) => ({ name })),
    html_url: `https://github.com/${repo.fullName}/issues/${String(row.number)}`,
  }
}

export async function issueRow(
  db: C,
  tenant: string,
  repo: RepoRow,
  number: number,
): Promise<IssueRow | null> {
  return (await db.githubIssue.findFirst({
    where: { ...scope(tenant), repo: repo.fullName, number },
  })) as IssueRow | null
}

// A pull request as the issue it also is: its pull request shape, with the
// `pull_request` key a caller tells the two apart by, pointing at the pull
// request under the prefix and run the request came in on.
async function pullAsIssue(ctx: Ctx<C>, repo: RepoRow, row: PullRow): Promise<JsonValue> {
  const json = (await pullJson(ctx, repo, row)) as Record<string, JsonValue>
  const path = ctx.url.pathname.replace(/\/issues(?:\/\d+)?$/, `/pulls/${String(row.number)}`)
  return {
    ...json,
    assignees: [],
    pull_request: {
      url: `${ctx.runPrefix}${path}`,
      html_url: json.html_url ?? null,
      merged_at: json.merged_at ?? null,
    },
  }
}

// Issues and pull requests in one list, as GitHub lists them. `state`,
// `creator`, `assignee` and `labels` narrow, `since` keeps what was updated at
// or after it (one that is no date keeps nothing, as `commits` does), and
// `sort` (`created`, `updated`, `comments`) and `direction` (`desc` unless
// asked) order the whole list before it is paged. A pull request has no
// assignees or labels here, so either filter leaves it out.
async function listIssues(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const where = { ...scope(ctx.tenant), repo: repo.fullName }
  const issues = (await ctx.db.githubIssue.findMany({ where })) as IssueRow[]
  const pulls = (await ctx.db.githubPull.findMany({ where })) as PullRow[]
  const comments = await ctx.db.githubComment.findMany({ where, select: { issueNumber: true } })
  interface Listed {
    number: number
    state: string
    user: string
    assignees: string[]
    labels: string[]
    createdAt: string
    updatedAt: string
    json: () => Promise<JsonValue>
  }
  const listed: Listed[] = [
    ...issues.map((r) => ({
      number: r.number,
      state: r.state,
      user: r.user,
      assignees: names(r.assigneesJson),
      labels: names(r.labelsJson),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      json: () => Promise.resolve(issueJson(repo, r)),
    })),
    ...pulls.map((r) => ({
      number: r.number,
      state: r.state,
      user: r.user,
      assignees: [],
      labels: [],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      json: () => pullAsIssue(ctx, repo, r),
    })),
  ]
  const wanted = ctx.query.get('state') ?? 'open'
  const creator = ctx.query.get('creator') ?? ''
  const assignee = ctx.query.get('assignee') ?? ''
  const labels = (ctx.query.get('labels') ?? '').split(',').filter((v) => v !== '')
  const since = ctx.query.get('since')
  const kept = listed.filter(
    (r) =>
      (wanted === 'all' || r.state === wanted) &&
      (creator === '' || r.user === creator) &&
      (assignee === '' || r.assignees.includes(assignee)) &&
      labels.every((want) => r.labels.includes(want)) &&
      (since === null || Date.parse(r.updatedAt) >= Date.parse(since)),
  )
  const sort = ctx.query.get('sort') ?? 'created'
  const talk = (r: Listed): number => comments.filter((c) => c.issueNumber === r.number).length
  const key = (r: Listed): number | string =>
    sort === 'updated' ? r.updatedAt : sort === 'comments' ? talk(r) : r.createdAt
  const sorted = ordered(kept, key, ctx.query.get('direction') ?? 'desc')
  return pagedReply(ctx, await Promise.all(sorted.map((r) => r.json())))
}

export async function createIssue(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const body = jsonBodyOf(ctx)
  const title = str(body, 'title').trim()
  if (title === '') return fail(422, 'Invalid request.\n\n"title" wasn\'t supplied.')
  const number = await nextNumber(ctx.db, ctx.tenant, repo)
  const row: IssueRow = {
    number,
    title,
    body: str(body, 'body'),
    state: 'open',
    user: DEFAULT_LOGIN,
    labelsJson: nameList(body.labels),
    assigneesJson: nameList(body.assignees),
    stateReason: '',
    closedAt: '',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }
  await ctx.db.githubIssue.create({
    data: { tenant: ctx.tenant, repo: repo.fullName, ...row, seq: number },
  })
  return { status: 201, body: issueJson(repo, row) }
}

// Reading issue N when N is a pull request answers the pull as an issue, which
// is what the vendor does: every pull request is an issue, and the extra
// `pull_request` key is how a caller tells the two apart.
async function getIssue(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const number = numberParam(ctx)
  if (number === null) return fail(404, 'Not Found')
  const row = await issueRow(ctx.db, ctx.tenant, repo, number)
  if (row !== null) return { status: 200, body: issueJson(repo, row) }
  const pull = await pullRow(ctx.db, ctx.tenant, repo, number)
  if (pull === null) return fail(404, 'Not Found')
  // `pull_request.url` is a reference the client follows, so it carries the
  // run the request came in on. Without it, resolving a pull request from a
  // scoped issue read queries the default run and can answer from another
  // repository state.
  return { status: 200, body: await pullAsIssue(ctx, repo, pull) }
}

async function editIssue(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const number = numberParam(ctx)
  if (number === null) return fail(404, 'Not Found')
  const row = await issueRow(ctx.db, ctx.tenant, repo, number)
  if (row === null) return fail(404, 'Not Found')
  const body = jsonBodyOf(ctx)
  const next: IssueRow = { ...row, updatedAt: EDITED_AT }
  if ('title' in body) next.title = str(body, 'title')
  if ('body' in body) next.body = str(body, 'body')
  if ('state' in body) next.state = str(body, 'state')
  // The vendor records why on every close (completed unless the caller
  // says otherwise) and on every reopen, and when the issue last closed.
  if (next.state === 'closed' && row.state !== 'closed') {
    next.stateReason = str(body, 'state_reason') || 'completed'
    next.closedAt = EDITED_AT
  } else if (next.state === 'open' && row.state === 'closed') {
    next.stateReason = 'reopened'
    next.closedAt = ''
  }
  if ('labels' in body) next.labelsJson = nameList(body.labels)
  if ('assignees' in body) next.assigneesJson = nameList(body.assignees)
  await ctx.db.githubIssue.updateMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName, number },
    data: next,
  })
  return { status: 200, body: issueJson(repo, next) }
}

// A comment hangs off a number that may name either an issue or a pull, and
// the id counts every comment in the repository rather than in the thread.
async function createComment(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const number = numberParam(ctx)
  if (number === null) return fail(404, 'Not Found')
  const issue = await issueRow(ctx.db, ctx.tenant, repo, number)
  const pull = issue === null ? await pullRow(ctx.db, ctx.tenant, repo, number) : null
  if (issue === null && pull === null) return fail(404, 'Not Found')
  const where = { ...scope(ctx.tenant), repo: repo.fullName }
  const id = (await ctx.db.githubComment.count({ where })) + 1
  const body = str(jsonBodyOf(ctx), 'body')
  await ctx.db.githubComment.create({
    data: {
      tenant: ctx.tenant,
      repo: repo.fullName,
      issueNumber: number,
      id,
      body,
      user: DEFAULT_LOGIN,
      createdAt: CREATED_AT,
      seq: id,
    },
  })
  return {
    status: 201,
    body: {
      id,
      body,
      user: { login: DEFAULT_LOGIN },
      html_url: `https://github.com/${repo.fullName}/issues/${String(number)}#issuecomment-${String(id)}`,
    },
  }
}

/**
 * Every comment on one issue, oldest first.
 *
 * Oldest first is the vendor's order and it is the whole of what a caller
 * reads this for: `comments[-1]` is "what was said last", which is how a
 * grader asks whether the reply it wanted is the reply that landed. Sorting
 * the other way would leave every such check reading the opening comment.
 *
 * The shape matches what `createComment` returns, plus `created_at`, so a
 * caller that posts and then lists sees one comment described one way.
 */
async function listComments(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const number = numberParam(ctx)
  if (number === null) return fail(404, 'Not Found')
  const issue = await issueRow(ctx.db, ctx.tenant, repo, number)
  const pull = issue === null ? await pullRow(ctx.db, ctx.tenant, repo, number) : null
  if (issue === null && pull === null) return fail(404, 'Not Found')
  const rows = await ctx.db.githubComment.findMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName, issueNumber: number },
    orderBy: { seq: 'asc' },
  })
  return pagedReply(
    ctx,
    rows.map((row) => ({
      id: row.id,
      body: row.body,
      created_at: row.createdAt,
      updated_at: row.createdAt,
      node_id: Buffer.from(`012:IssueComment${String(repo.seq)}:${String(row.id)}`).toString(
        'base64',
      ),
      author_association: 'NONE',
      user: { login: row.user },
      html_url: `https://github.com/${repo.fullName}/issues/${String(number)}#issuecomment-${String(row.id)}`,
    })),
  )
}

function commentCursor(id: number): string {
  return Buffer.from(`comment:${id}`).toString('base64')
}

/**
 * The GraphQL `comments` connection of one issue or pull request: the rows
 * `issues/{n}/comments` wrote, oldest first, a page at a time.
 */
export function commentConnection(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  number: number,
): (args: {
  first?: number | null
  last?: number | null
  after?: string | null
}) => Promise<Record<string, unknown>> {
  return async ({ first, last, after }) => {
    const size = last ?? first ?? 0
    if (size < 1 || size > 100) throw new Error('first must be between 1 and 100')
    const rows = await ctx.db.githubComment.findMany({
      where: { ...scope(ctx.tenant), repo: repo.fullName, issueNumber: number },
      orderBy: { seq: 'asc' },
    })
    const start = after ? rows.findIndex((row) => commentCursor(row.id) === after) + 1 : 0
    if (after && start === 0) throw new Error('Invalid cursor')
    const from = typeof last === 'number' ? Math.max(rows.length - last, 0) : start
    const page = rows.slice(from, from + size)
    return {
      nodes: page.map((row) => ({
        id: Buffer.from(`012:IssueComment${String(repo.seq)}:${String(row.id)}`).toString('base64'),
        author: userNode(row.user),
        authorAssociation: 'NONE',
        body: row.body,
        createdAt: row.createdAt,
        includesCreatedEdit: false,
        isMinimized: false,
        minimizedReason: null,
        reactionGroups: [],
        url: `https://github.com/${repo.fullName}/issues/${number}#issuecomment-${row.id}`,
        viewerDidAuthor: row.user === DEFAULT_LOGIN,
        ...(JSON.parse(row.metaJson) as Record<string, JsonValue>),
      })),
      totalCount: rows.length,
      pageInfo: {
        hasNextPage: from + size < rows.length,
        endCursor: page.length ? commentCursor(page[page.length - 1]!.id) : null,
      },
    }
  }
}

/** A pull request as GraphQL references it from an issue it closes. */
function pullReference(
  repo: RepoRow,
  row: PullRow,
  repository: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: pullNodeId(repo.seq, row.number),
    number: row.number,
    url: `https://github.com/${repo.fullName}/pull/${String(row.number)}`,
    repository,
  }
}

/**
 * One issue as GraphQL's `Issue` reports it, for every field `gh issue
 * view --json` and `gh issue list --json` read: its labels and assignees
 * from the names the REST side stores, the pull requests whose body says
 * they close it, and its comments. `repository` is the GraphQL node of the
 * repository it lives in.
 */
export async function issueNode(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  row: IssueRow,
  repository: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const closed = row.state === 'closed'
  const pulls = (await ctx.db.githubPull.findMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName },
    orderBy: { seq: 'asc' },
  })) as PullRow[]
  const closers = pulls.filter((pull) => closedNumbers(pull.body).includes(row.number))
  return {
    __typename: 'Issue',
    id: issueNodeId(repo.seq, row.number),
    number: row.number,
    title: row.title,
    body: row.body,
    url: `https://github.com/${repo.fullName}/issues/${String(row.number)}`,
    state: closed ? 'CLOSED' : 'OPEN',
    stateReason: row.stateReason === '' ? null : row.stateReason.toUpperCase(),
    closed,
    closedAt: row.closedAt === '' ? null : row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    author: userNode(row.user),
    assignees: ({ first, after }: PageArgs) =>
      page(names(row.assigneesJson).map(userNode), first, after),
    assignedActors: ({ first, after }: PageArgs) =>
      page(names(row.assigneesJson).map(userNode), first, after),
    labels: ({ first, after }: PageArgs) =>
      page(
        names(row.labelsJson).map((name) => ({
          id: nodeId('05:Label', `${String(repo.seq)}:${name}`),
          name,
          description: null,
          color: 'ededed',
        })),
        first,
        after,
      ),
    milestone: null,
    reactionGroups: reactionGroups(),
    isPinned: isPinned(ctx, repo.fullName, row.number),
    locked: lockReason(ctx, repo.fullName, row.number).locked,
    activeLockReason: lockReason(ctx, repo.fullName, row.number).reason,
    repository,
    comments: commentConnection(ctx, repo, row.number),
    projectCards: () => {
      throw new Error(PROJECTS_CLASSIC_GONE)
    },
    projectItems: ({ first, after }: PageArgs) => page([], first, after),
    closedByPullRequestsReferences: ({ first, after }: PageArgs) =>
      page(
        closers.map((pull) => pullReference(repo, pull, repository)),
        first,
        after,
      ),
  }
}

/** The arguments GraphQL's `issues` connection narrows by. */
export interface IssuesArgs extends PageArgs {
  states?: string[] | null
  filterBy?: {
    assignee?: string | null
    createdBy?: string | null
    mentioned?: string | null
    labels?: string[] | null
  } | null
}

/**
 * The issues GraphQL's `issues` lists: narrowed by state, assignee, author
 * and labels (every one of them), newest first, a page at a time. `nodes`
 * turns each row into its node.
 */
export async function issueConnection(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  args: IssuesArgs,
  nodes: (row: IssueRow) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const rows = (await ctx.db.githubIssue.findMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName },
    orderBy: { seq: 'desc' },
  })) as IssueRow[]
  const states = args.states ?? ['OPEN', 'CLOSED']
  const filter = args.filterBy ?? {}
  const kept = rows.filter((row) => {
    if (!states.includes(row.state === 'closed' ? 'CLOSED' : 'OPEN')) return false
    if (filter.assignee && !names(row.assigneesJson).includes(filter.assignee)) return false
    if (filter.createdBy && row.user !== filter.createdBy) return false
    const labels = new Set(names(row.labelsJson))
    return (filter.labels ?? []).every((label) => labels.has(label))
  })
  const connection = page(kept, args.first ?? 0, args.after)
  return { ...connection, nodes: await Promise.all(connection.nodes.map(nodes)) }
}

export function issueRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    route<C>('GET', `${p}/repos/:owner/:repo/issues`, authedRoute(withRepo(listIssues))),
    route<C>('POST', `${p}/repos/:owner/:repo/issues`, authedRoute(withRepo(createIssue)), {
      write: true,
    }),
    route<C>('GET', `${p}/repos/:owner/:repo/issues/:number`, authedRoute(withRepo(getIssue))),
    route<C>('PATCH', `${p}/repos/:owner/:repo/issues/:number`, authedRoute(withRepo(editIssue)), {
      write: true,
    }),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/issues/:number/comments`,
      authedRoute(withRepo(listComments)),
    ),
    route<C>(
      'POST',
      `${p}/repos/:owner/:repo/issues/:number/comments`,
      authedRoute(withRepo(createComment)),
      { write: true },
    ),
  ])
}
