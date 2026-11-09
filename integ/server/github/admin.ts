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
import { createIssue as createIssueRow, issueRow } from './issues.ts'
import type { IssueRow } from './issues.ts'
import { findWorkflowRow, runRow } from './actions.ts'
import { createPull, pullRow, recordPullReview } from './pulls.ts'
import type { PullRow } from './pulls.ts'
import { allRepos, kept, metaOf, nextCommentId, nextNumber, pullExtras, scope } from './store.ts'
import type { RepoRow } from './store.ts'
import {
  authedRoute,
  everywhere,
  fail,
  jsonBodyOf,
  pagedReply,
  param,
  route,
  str,
  withRepo,
} from './http.ts'
import { issueNodeId, nodeId, page } from './wire.ts'
import type { PageArgs } from './wire.ts'

const STAMP = '2026-01-01T00:00:00Z'
const LABELED_REPO = 'integ/repo-cli'
const SEEDED_LABELS = ['bug', 'docs']

interface LabelRow {
  id: string
  name: string
  color: string
  description: string
  url: string
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

function labelRow(repo: string, name: string, color: string, description: string): LabelRow {
  return {
    id: nodeId('05:Label', name),
    name,
    color,
    description,
    url: `https://github.com/${repo}/labels/${name}`,
    isDefault: false,
    createdAt: STAMP,
    updatedAt: STAMP,
  }
}

// The fixture repository starts with the labels its issues carry: `gh` looks a
// name up before it writes and refuses one the repository does not have.
function labelsOf(ctx: { tenant: string; db: C }, repo: string): Map<string, LabelRow> {
  const rows = kept<LabelRow>(ctx, `labels\0${repo}`)
  const seeded = kept<boolean>(ctx, 'labels-seeded')
  if (repo === LABELED_REPO && seeded.get(repo) !== true) {
    seeded.set(repo, true)
    for (const name of SEEDED_LABELS) rows.set(name, labelRow(repo, name, 'ededed', ''))
  }
  return rows
}

export function labelConnection(ctx: { tenant: string; db: C }, repo: RepoRow) {
  return ({
    first,
    after,
    query,
    orderBy,
  }: PageArgs & {
    query?: string | null
    orderBy?: { field: string; direction: string } | null
  }) => {
    let rows = [...labelsOf(ctx, repo.fullName).values()]
    if (query) {
      const needle = query.toLowerCase()
      rows = rows.filter(
        (row) =>
          row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle),
      )
    }
    if (orderBy?.field === 'NAME') rows.sort((a, b) => a.name.localeCompare(b.name))
    if (orderBy?.direction === 'DESC') rows.reverse()
    return page(rows, first, after)
  }
}

export function releaseConnection(ctx: Ctx<C> | { db: C; tenant: string }, repo: RepoRow) {
  return async ({
    first,
    after,
    orderBy,
  }: PageArgs & { orderBy?: { direction: string } | null }) => {
    const rows = (await ctx.db.githubRelease.findMany({
      where: { ...scope(ctx.tenant), repo: repo.fullName },
      orderBy: { seq: 'asc' },
    })) as Array<{
      tagName: string
      name: string
      draft: boolean
      prerelease: boolean
      createdAt: string
    }>
    const newest = [...rows].reverse().find((row) => !row.draft && !row.prerelease)
    const nodes = rows.map((row) => ({
      name: row.name,
      tagName: row.tagName,
      isDraft: row.draft,
      immutable: false,
      isLatest: row === newest,
      isPrerelease: row.prerelease,
      createdAt: row.createdAt,
      publishedAt: row.draft ? null : row.createdAt,
      url: `https://github.com/${repo.fullName}/releases/tag/${row.tagName}`,
    }))
    return page(orderBy?.direction === 'ASC' ? nodes : nodes.reverse(), first, after)
  }
}

export const MUTATIONS = `
  type Mutation {
    closeIssue(input: CloseIssueInput!): IssuePayload
    closePullRequest(input: ClosePullRequestInput!): PullPayload
    addComment(input: AddCommentInput!): AddCommentPayload
    updateIssueComment(input: UpdateIssueCommentInput!): UpdateCommentPayload
    deleteIssueComment(input: DeleteIssueCommentInput!): Payload
    mergePullRequest(input: MergePullRequestInput!): Payload
    enablePullRequestAutoMerge(input: EnablePullRequestAutoMergeInput!): Payload
    disablePullRequestAutoMerge(input: DisableAutoMergeInput!): Payload
    addPullRequestReview(input: AddPullRequestReviewInput!): Payload
    markPullRequestReadyForReview(input: MarkPullRequestReadyForReviewInput!): PullPayload
    convertPullRequestToDraft(input: ConvertPullRequestToDraftInput!): PullPayload
    updatePullRequestBranch(input: UpdatePullRequestBranchInput!): PullPayload
    revertPullRequest(input: RevertPullRequestInput!): RevertPayload
    pinIssue(input: PinIssueInput!): IssuePayload
    unpinIssue(input: UnpinIssueInput!): IssuePayload
    deleteIssue(input: DeleteIssueInput!): DeletePayload
    transferIssue(input: TransferIssueInput!): TransferPayload
    lockLockable(input: LockLockableInput!): LockPayload
    unlockLockable(input: UnlockLockableInput!): UnlockPayload
    archiveRepository(input: ArchiveRepositoryInput!): RepoPayload
    unarchiveRepository(input: UnarchiveRepositoryInput!): RepoPayload
    createIssue(input: CreateIssueInput!): CreatedIssuePayload
    updateIssue(input: UpdateIssueInput!): Payload
    reopenIssue(input: ReopenIssueInput!): IssuePayload
    createRepository(input: CreateRepositoryInput!): CreatedRepositoryPayload
    createPullRequest(input: CreatePullRequestInput!): CreatedPullPayload
    updatePullRequest(input: UpdatePullRequestInput!): Payload
    reopenPullRequest(input: ReopenPullRequestInput!): PullPayload
    requestReviews(input: RequestReviewsInput!): Payload
    addLabelsToLabelable(input: AddLabelsToLabelableInput!): Payload
    removeLabelsFromLabelable(input: RemoveLabelsFromLabelableInput!): Payload
    replaceActorsForAssignable(input: ReplaceActorsForAssignableInput!): Payload
  }
  input CloseIssueInput { issueId: ID!, stateReason: String }
  input ClosePullRequestInput { pullRequestId: ID! }
  input AddCommentInput { subjectId: ID!, body: String! }
  input UpdateIssueCommentInput { id: ID!, body: String! }
  input DeleteIssueCommentInput { id: ID! }
  input MergePullRequestInput {
    pullRequestId: ID!, mergeMethod: String, commitHeadline: String, commitBody: String,
    expectedHeadOid: String, authorEmail: String
  }
  input EnablePullRequestAutoMergeInput {
    pullRequestId: ID!, mergeMethod: String, commitHeadline: String, commitBody: String,
    expectedHeadOid: String, authorEmail: String
  }
  input DisableAutoMergeInput { pullRequestId: ID! }
  input AddPullRequestReviewInput { pullRequestId: ID!, event: String, body: String }
  input MarkPullRequestReadyForReviewInput { pullRequestId: ID! }
  input ConvertPullRequestToDraftInput { pullRequestId: ID! }
  input UpdatePullRequestBranchInput { pullRequestId: ID!, expectedHeadOid: String, updateMethod: String }
  input RevertPullRequestInput { pullRequestId: ID!, draft: Boolean, title: String, body: String }
  input PinIssueInput { issueId: ID! }
  input UnpinIssueInput { issueId: ID! }
  input DeleteIssueInput { issueId: ID! }
  input TransferIssueInput { issueId: ID!, repositoryId: ID! }
  input LockLockableInput { lockableId: ID!, lockReason: String }
  input UnlockLockableInput { lockableId: ID! }
  input ArchiveRepositoryInput { repositoryId: ID! }
  input UnarchiveRepositoryInput { repositoryId: ID! }
  input CreateIssueInput {
    repositoryId: ID!, title: String!, body: String, assigneeIds: [ID!], labelIds: [ID!],
    milestoneId: ID, projectIds: [ID!], issueTemplate: String
  }
  input UpdateIssueInput {
    id: ID!, title: String, body: String, assigneeIds: [ID!], milestoneId: ID, projectIds: [ID!]
  }
  input ReopenIssueInput { issueId: ID! }
  input CreateRepositoryInput {
    name: String!, visibility: String!, ownerId: ID, teamId: ID, description: String,
    homepageUrl: String, hasIssuesEnabled: Boolean, hasWikiEnabled: Boolean
  }
  type CreatedRepositoryPayload { repository: Repository }
  input CreatePullRequestInput {
    repositoryId: ID!, title: String!, body: String, draft: Boolean, baseRefName: String!,
    headRefName: String!, maintainerCanModify: Boolean
  }
  input UpdatePullRequestInput {
    pullRequestId: ID!, title: String, body: String, baseRefName: String, assigneeIds: [ID!],
    labelIds: [ID!], milestoneId: ID, projectIds: [ID!]
  }
  input ReopenPullRequestInput { pullRequestId: ID! }
  input RequestReviewsInput { pullRequestId: ID!, userIds: [ID!], teamIds: [ID!], union: Boolean }
  input AddLabelsToLabelableInput { labelableId: ID!, labelIds: [ID!]! }
  input RemoveLabelsFromLabelableInput { labelableId: ID!, labelIds: [ID!]! }
  input ReplaceActorsForAssignableInput { assignableId: ID!, actorIds: [ID!]! }
  type CreatedNode { id: ID!, url: String! }
  type CreatedIssuePayload { issue: CreatedNode }
  type CreatedPullPayload { pullRequest: CreatedNode }
  type Payload { clientMutationId: String }
  type IssueId { id: ID! }
  type PullId { id: ID! }
  type RepoId { id: ID! }
  type IssuePayload { issue: IssueId }
  type PullPayload { pullRequest: PullId }
  type RepoPayload { repository: RepoId }
  type DeletePayload { repository: RepoId }
  type CommentNode { url: String! }
  type CommentEdge { node: CommentNode! }
  type AddCommentPayload { commentEdge: CommentEdge }
  type UpdateCommentPayload { issueComment: CommentNode }
  type RevertedPull { id: ID!, number: Int!, url: String! }
  type RevertPayload { pullRequest: PullId, revertPullRequest: RevertedPull }
  type TransferredIssue { url: String! }
  type TransferPayload { issue: TransferredIssue }
  type Locked { locked: Boolean! }
  type LockPayload { lockedRecord: Locked }
  type UnlockPayload { unlockedRecord: Locked }
  enum SearchType { ISSUE ISSUE_ADVANCED REPOSITORY USER DISCUSSION }
  type SearchEdge { node: SearchResult }
  union SearchResult = Issue | PullRequest
  type SearchConnection {
    issueCount: Int!, nodes: [SearchResult], edges: [SearchEdge], pageInfo: PageInfo!
  }
  enum LabelOrderField { NAME CREATED_AT }
  input LabelOrder { field: LabelOrderField!, direction: OrderDirection! }
  enum ReleaseOrderField { CREATED_AT NAME }
  input ReleaseOrder { field: ReleaseOrderField!, direction: OrderDirection! }
  type ReleaseNode {
    name: String, tagName: String!, isDraft: Boolean!, immutable: Boolean!, isLatest: Boolean!,
    isPrerelease: Boolean!, createdAt: String!, publishedAt: String, url: String!
  }
  type ReleaseConnection { nodes: [ReleaseNode!]!, pageInfo: PageInfo! }
  type Gist {
    name: String!, description: String, isPublic: Boolean!, updatedAt: String!, files: [GistFile!]!
  }
  type GistFile { name: String!, text: String }
  enum GistPrivacy { ALL PUBLIC SECRET }
  enum GistOrderField { CREATED_AT UPDATED_AT PUSHED_AT }
  input GistOrder { field: GistOrderField!, direction: OrderDirection! }
  type GistConnection { nodes: [Gist!]!, pageInfo: PageInfo! }
  type OrgNode { login: String! }
  type OrgConnection { totalCount: Int!, nodes: [OrgNode!]!, pageInfo: PageInfo! }
  type RulesetSource { owner: String }
  type RulesetRules { totalCount: Int! }
  type Ruleset {
    databaseId: Int!, name: String!, target: String!, enforcement: String!, source: RulesetOwner!,
    rules: RulesetRules!
  }
  union RulesetOwner = Repository | Organization
  type RulesetConnection { totalCount: Int!, nodes: [Ruleset!]!, pageInfo: PageInfo! }
  type Compare { aheadBy: Int!, behindBy: Int!, status: String! }
  type BranchProtectionRule { requiresStrictStatusChecks: Boolean }
  type BaseRef { compare(headRef: String!): Compare!, branchProtectionRule: BranchProtectionRule }
`

function decoded(id: string): string {
  return Buffer.from(id, 'base64').toString()
}

async function repoBySeq(ctx: { db: C; tenant: string }, seq: number): Promise<RepoRow> {
  const found = (await allRepos(ctx.db, ctx.tenant)).find((repo) => repo.seq === seq)
  if (found === undefined) throw new Error('Could not resolve to a node.')
  return found
}

// `05:Issue3:7` or `011:PullRequest3:7`, the repository's seq and the number.
async function subject(
  ctx: { db: C; tenant: string },
  id: string,
): Promise<{ repo: RepoRow; number: number; pull: boolean }> {
  const text = decoded(id)
  const tail = /(\d+):(\d+)$/.exec(text)
  if (tail === null) throw new Error('Could not resolve to a node.')
  return {
    repo: await repoBySeq(ctx, Number(tail[1])),
    number: Number(tail[2]),
    pull: text.includes('PullRequest'),
  }
}

function urlOf(repo: RepoRow, pull: boolean, number: number): string {
  return `https://github.com/${repo.fullName}/${pull ? 'pull' : 'issues'}/${String(number)}`
}

async function commentWhere(ctx: { db: C; tenant: string }, id: string) {
  const [, seq, number] = /IssueComment(\d+):(\d+)$/.exec(decoded(id)) ?? []
  const repo = await repoBySeq(ctx, Number(seq))
  return { ...scope(ctx.tenant), repo: repo.fullName, id: Number(number) }
}

function matchesWords(row: { title: string; body: string }, words: string[]): boolean {
  return words.every((word) =>
    `${row.title} ${row.body}`.toLowerCase().includes(word.toLowerCase()),
  )
}

function terms(query: string): { words: string[]; qualifiers: Map<string, string[]> } {
  const words: string[] = []
  const qualifiers = new Map<string, string[]>()
  for (const match of query.matchAll(/([\w-]+):"([^"]*)"|([\w-]+):(\S+)|"([^"]*)"|(\S+)/g)) {
    const key = match[1] ?? match[3]
    if (key !== undefined) {
      const list = qualifiers.get(key) ?? []
      list.push(match[2] ?? match[4] ?? '')
      qualifiers.set(key, list)
    } else {
      const word = match[5] ?? match[6] ?? ''
      if (!['(', ')', 'OR', 'AND'].includes(word)) words.push(word)
    }
  }
  return { words, qualifiers }
}

// A label's name or an actor's login, out of the node id it travels as.
function nameIn(id: string): string {
  return decoded(id).replace(/^0\d+:(?:Label|User|Bot)/, '')
}

// What a REST handler answered, or the GraphQL error its failure reads as.
function replied(reply: Reply): Record<string, JsonValue> {
  const body = reply.body as Record<string, JsonValue>
  if (reply.status < 400) return body
  const first = (body.errors as Array<Record<string, JsonValue>> | undefined)?.[0]
  throw new Error(String(first?.message ?? body.message))
}

function me(name: string): string {
  return name === '@me' ? DEFAULT_LOGIN : name
}

export function adminRoot(
  ctx: Ctx<C>,
  nodes: {
    issue: (repo: RepoRow, row: IssueRow) => Promise<Record<string, unknown>>
    pull: (repo: RepoRow, row: PullRow) => Promise<Record<string, unknown>>
  },
): Record<string, unknown> {
  const whereOf = (repo: RepoRow, number: number) => ({
    ...scope(ctx.tenant),
    repo: repo.fullName,
    number,
  })
  const key = (repo: RepoRow, number: number): string => `${repo.fullName}#${String(number)}`
  const repoOf = (id: string): Promise<RepoRow> =>
    repoBySeq(ctx, Number(/(\d+)$/.exec(decoded(id))?.[1] ?? 0))
  const editNames = async (
    id: string,
    kind: 'assignees' | 'labels',
    change: (now: string[]) => string[],
  ): Promise<void> => {
    const { repo, number, pull } = await subject(ctx, id)
    if (pull) {
      const rows = kept<string[]>(ctx, `pull-${kind}\0${repo.fullName}`)
      rows.set(String(number), change(rows.get(String(number)) ?? []))
      return
    }
    const column = kind === 'labels' ? 'labelsJson' : 'assigneesJson'
    const row = await issueRow(ctx.db, ctx.tenant, repo, number)
    if (row === null) throw new Error('Could not resolve to a node.')
    const now = JSON.parse(row[column]) as string[]
    await ctx.db.githubIssue.updateMany({
      where: whereOf(repo, number),
      data: { [column]: JSON.stringify(change(now)) },
    })
  }
  return {
    node: async ({ id }: { id: string }) => {
      const { repo, number, pull } = await subject(ctx, id)
      if (pull) {
        const row = await pullRow(ctx.db, ctx.tenant, repo, number)
        return row === null ? null : { __typename: 'PullRequest', ...(await nodes.pull(repo, row)) }
      }
      const row = await issueRow(ctx.db, ctx.tenant, repo, number)
      return row === null ? null : { __typename: 'Issue', ...(await nodes.issue(repo, row)) }
    },
    search: async ({
      query,
      first,
      last,
      after,
    }: {
      query: string
      first?: number
      last?: number
      after?: string
    }) => {
      const { words, qualifiers } = terms(query)
      const one = (name: string): string | undefined => qualifiers.get(name)?.[0]
      const repos = (await allRepos(ctx.db, ctx.tenant)).filter(
        (repo) => one('repo') === undefined || repo.fullName === one('repo'),
      )
      const type = one('type') ?? (qualifiers.get('is')?.includes('pr') ? 'pr' : undefined)
      const labels = qualifiers.get('label') ?? []
      const found: Record<string, unknown>[] = []
      for (const repo of repos) {
        if (type !== 'pr') {
          const rows = (await ctx.db.githubIssue.findMany({
            where: { ...scope(ctx.tenant), repo: repo.fullName },
            orderBy: { seq: 'desc' },
          })) as IssueRow[]
          for (const row of rows) {
            const names = JSON.parse(row.labelsJson) as string[]
            const people = JSON.parse(row.assigneesJson) as string[]
            if (one('state') !== undefined && row.state !== one('state')) continue
            if (one('author') !== undefined && row.user !== me(one('author') ?? '')) continue
            if (one('assignee') !== undefined && !people.includes(me(one('assignee') ?? '')))
              continue
            if (!labels.every((label) => names.includes(label))) continue
            if (!matchesWords(row, words)) continue
            found.push({ ...(await nodes.issue(repo, row)), __typename: 'Issue' })
          }
        }
        if (type !== 'issue') {
          const rows = (await ctx.db.githubPull.findMany({
            where: { ...scope(ctx.tenant), repo: repo.fullName },
            orderBy: { seq: 'desc' },
          })) as PullRow[]
          for (const row of rows) {
            const state = row.merged ? 'merged' : row.state
            const wanted = one('state')
            if (
              wanted !== undefined &&
              !(wanted === 'closed' ? state !== 'open' : state === wanted)
            )
              continue
            if (qualifiers.get('is')?.includes('merged') === true && !row.merged) continue
            if (one('author') !== undefined && row.user !== me(one('author') ?? '')) continue
            if (one('base') !== undefined && row.base !== one('base')) continue
            if (one('head') !== undefined && !row.head.endsWith(one('head') ?? '')) continue
            if (one('draft') !== undefined && String(row.draft) !== one('draft')) continue
            const extras = (key: string) => pullExtras(ctx, repo.fullName, row.number, key)
            if (
              one('assignee') !== undefined &&
              !extras('assignees').includes(me(one('assignee') ?? ''))
            )
              continue
            if (!labels.every((label) => extras('labels').includes(label))) continue
            if (one('review-requested') !== undefined) {
              const asked = JSON.parse(row.reviewersJson) as string[]
              if (!asked.includes(me(one('review-requested') ?? ''))) continue
            }
            if (!matchesWords(row, words)) continue
            found.push({ ...(await nodes.pull(repo, row)), __typename: 'PullRequest' })
          }
        }
      }
      const slice = page(found, first ?? last ?? 100, after)
      return {
        issueCount: found.length,
        nodes: slice.nodes,
        edges: slice.nodes.map((node) => ({ node })),
        pageInfo: slice.pageInfo,
      }
    },
    user: ({ login }: { login: string }) => ({
      login,
      organizations: ({ first, after }: PageArgs) => {
        const rows = [...kept<{ login: string }>(ctx, 'orgs').values()]
        return page(rows, first, after)
      },
    }),
    organization: ({ login }: { login: string }) => ({ login, rulesets: rulesetPage(ctx, login) }),
    closeIssue: async ({ input }: { input: { issueId: string; stateReason?: string } }) => {
      const { repo, number } = await subject(ctx, input.issueId)
      await ctx.db.githubIssue.updateMany({
        where: whereOf(repo, number),
        data: {
          state: 'closed',
          stateReason: (input.stateReason ?? 'completed').toLowerCase(),
          closedAt: STAMP,
        },
      })
      return { issue: { id: input.issueId } }
    },
    createIssue: async ({
      input,
    }: {
      input: {
        repositoryId: string
        title: string
        body?: string
        assigneeIds?: string[]
        labelIds?: string[]
      }
    }) => {
      const repo = await repoOf(input.repositoryId)
      const made = replied(
        await createIssueRow(
          {
            ...ctx,
            json: () => ({
              title: input.title,
              body: input.body ?? '',
              labels: (input.labelIds ?? []).map(nameIn),
              assignees: (input.assigneeIds ?? []).map(nameIn),
            }),
          },
          repo,
        ),
      )
      return { issue: { id: issueNodeId(repo.seq, Number(made.number)), url: made.html_url } }
    },
    updateIssue: async ({
      input,
    }: {
      input: { id: string; title?: string; body?: string; assigneeIds?: string[] }
    }) => {
      const { repo, number } = await subject(ctx, input.id)
      const data: Record<string, string> = {}
      if (typeof input.title === 'string') data.title = input.title
      if (typeof input.body === 'string') data.body = input.body
      if (input.assigneeIds) data.assigneesJson = JSON.stringify(input.assigneeIds.map(nameIn))
      if (Object.keys(data).length > 0) {
        await ctx.db.githubIssue.updateMany({ where: whereOf(repo, number), data })
      }
      return { clientMutationId: null }
    },
    reopenIssue: async ({ input }: { input: { issueId: string } }) => {
      const { repo, number } = await subject(ctx, input.issueId)
      await ctx.db.githubIssue.updateMany({
        where: whereOf(repo, number),
        data: { state: 'open', stateReason: 'reopened', closedAt: '' },
      })
      return { issue: { id: input.issueId } }
    },
    createPullRequest: async ({
      input,
    }: {
      input: {
        repositoryId: string
        title: string
        body?: string
        draft?: boolean
        baseRefName: string
        headRefName: string
      }
    }) => {
      const repo = await repoOf(input.repositoryId)
      const made = replied(
        await createPull(
          {
            ...ctx,
            json: () => ({
              title: input.title,
              body: input.body ?? '',
              draft: input.draft === true,
              base: input.baseRefName,
              head: input.headRefName,
            }),
          },
          repo,
        ),
      )
      return {
        pullRequest: {
          id: nodeId('011:PullRequest', `${String(repo.seq)}:${String(made.number)}`),
          url: made.html_url,
        },
      }
    },
    updatePullRequest: async ({
      input,
    }: {
      input: {
        pullRequestId: string
        title?: string
        body?: string
        baseRefName?: string
        assigneeIds?: string[]
        labelIds?: string[]
      }
    }) => {
      const { repo, number } = await subject(ctx, input.pullRequestId)
      const data: Record<string, string> = {}
      if (typeof input.title === 'string') data.title = input.title
      if (typeof input.body === 'string') data.body = input.body
      if (typeof input.baseRefName === 'string') data.base = input.baseRefName
      if (Object.keys(data).length > 0) {
        await ctx.db.githubPull.updateMany({ where: whereOf(repo, number), data })
      }
      if (input.assigneeIds) {
        const given = input.assigneeIds.map(nameIn)
        await editNames(input.pullRequestId, 'assignees', () => given)
      }
      if (input.labelIds) {
        const given = input.labelIds.map(nameIn)
        await editNames(input.pullRequestId, 'labels', (now) => [...new Set([...now, ...given])])
      }
      return { clientMutationId: null }
    },
    reopenPullRequest: async ({ input }: { input: { pullRequestId: string } }) => {
      const { repo, number } = await subject(ctx, input.pullRequestId)
      await ctx.db.githubPull.updateMany({ where: whereOf(repo, number), data: { state: 'open' } })
      return { pullRequest: { id: input.pullRequestId } }
    },
    requestReviews: async ({ input }: { input: { pullRequestId: string; userIds?: string[] } }) => {
      const { repo, number } = await subject(ctx, input.pullRequestId)
      const row = await pullRow(ctx.db, ctx.tenant, repo, number)
      if (row === null) throw new Error('Could not resolve to a node.')
      const given = (input.userIds ?? []).map(nameIn)
      const now = JSON.parse(row.reviewersJson) as string[]
      await ctx.db.githubPull.updateMany({
        where: whereOf(repo, number),
        data: { reviewersJson: JSON.stringify([...new Set([...now, ...given])]) },
      })
      return { clientMutationId: null }
    },
    addLabelsToLabelable: async ({
      input,
    }: {
      input: { labelableId: string; labelIds: string[] }
    }) => {
      const given = input.labelIds.map(nameIn)
      await editNames(input.labelableId, 'labels', (now) => [...new Set([...now, ...given])])
      return { clientMutationId: null }
    },
    removeLabelsFromLabelable: async ({
      input,
    }: {
      input: { labelableId: string; labelIds: string[] }
    }) => {
      const given = input.labelIds.map(nameIn)
      await editNames(input.labelableId, 'labels', (now) => now.filter((n) => !given.includes(n)))
      return { clientMutationId: null }
    },
    replaceActorsForAssignable: async ({
      input,
    }: {
      input: { assignableId: string; actorIds: string[] }
    }) => {
      const given = input.actorIds.map(nameIn)
      await editNames(input.assignableId, 'assignees', () => given)
      return { clientMutationId: null }
    },
    closePullRequest: async ({ input }: { input: { pullRequestId: string } }) => {
      const { repo, number } = await subject(ctx, input.pullRequestId)
      await ctx.db.githubPull.updateMany({
        where: whereOf(repo, number),
        data: { state: 'closed' },
      })
      return { pullRequest: { id: input.pullRequestId } }
    },
    addComment: async ({ input }: { input: { subjectId: string; body: string } }) => {
      const { repo, number } = await subject(ctx, input.subjectId)
      const id = await nextCommentId(ctx.db, ctx.tenant, repo)
      await ctx.db.githubComment.create({
        data: {
          tenant: ctx.tenant,
          repo: repo.fullName,
          issueNumber: number,
          id,
          body: input.body,
          user: DEFAULT_LOGIN,
          createdAt: STAMP,
          seq: id,
        },
      })
      return {
        commentEdge: {
          node: { url: `${urlOf(repo, false, number)}#issuecomment-${String(id)}` },
        },
      }
    },
    updateIssueComment: async ({ input }: { input: { id: string; body: string } }) => {
      const where = await commentWhere(ctx, input.id)
      const row = (await ctx.db.githubComment.findFirst({ where })) as {
        repo: string
        issueNumber: number
      } | null
      if (row === null) throw new Error('Could not resolve to a node.')
      await ctx.db.githubComment.updateMany({ where, data: { body: input.body } })
      return {
        issueComment: {
          url: `https://github.com/${row.repo}/issues/${String(row.issueNumber)}#issuecomment-${String(where.id)}`,
        },
      }
    },
    deleteIssueComment: async ({ input }: { input: { id: string } }) => {
      await ctx.db.githubComment.deleteMany({ where: await commentWhere(ctx, input.id) })
      return { clientMutationId: null }
    },
    mergePullRequest: async ({ input }: { input: { pullRequestId: string } }) => {
      const { repo, number } = await subject(ctx, input.pullRequestId)
      await ctx.db.githubPull.updateMany({
        where: whereOf(repo, number),
        data: { state: 'closed', merged: true },
      })
      return { clientMutationId: null }
    },
    enablePullRequestAutoMerge: async ({
      input,
    }: {
      input: { pullRequestId: string; mergeMethod?: string }
    }) => {
      const { repo, number } = await subject(ctx, input.pullRequestId)
      kept<string>(ctx, 'auto').set(key(repo, number), input.mergeMethod ?? 'MERGE')
      return { clientMutationId: null }
    },
    disablePullRequestAutoMerge: async ({ input }: { input: { pullRequestId: string } }) => {
      const { repo, number } = await subject(ctx, input.pullRequestId)
      kept<string>(ctx, 'auto').delete(key(repo, number))
      return { clientMutationId: null }
    },
    addPullRequestReview: async ({
      input,
    }: {
      input: { pullRequestId: string; event?: string; body?: string }
    }) => {
      const { repo, number } = await subject(ctx, input.pullRequestId)
      const row = await pullRow(ctx.db, ctx.tenant, repo, number)
      if (row === null) throw new Error('Could not resolve to a node.')
      await recordPullReview(ctx, repo, row, input.event ?? 'COMMENT', input.body ?? '')
      return { clientMutationId: null }
    },
    markPullRequestReadyForReview: async ({ input }: { input: { pullRequestId: string } }) => {
      const { repo, number } = await subject(ctx, input.pullRequestId)
      await ctx.db.githubPull.updateMany({ where: whereOf(repo, number), data: { draft: false } })
      return { pullRequest: { id: input.pullRequestId } }
    },
    convertPullRequestToDraft: async ({ input }: { input: { pullRequestId: string } }) => {
      const { repo, number } = await subject(ctx, input.pullRequestId)
      await ctx.db.githubPull.updateMany({ where: whereOf(repo, number), data: { draft: true } })
      return { pullRequest: { id: input.pullRequestId } }
    },
    updatePullRequestBranch: ({ input }: { input: { pullRequestId: string } }) => ({
      pullRequest: { id: input.pullRequestId },
    }),
    revertPullRequest: async ({
      input,
    }: {
      input: { pullRequestId: string; draft?: boolean; title?: string; body?: string }
    }) => {
      const { repo, number } = await subject(ctx, input.pullRequestId)
      const row = await pullRow(ctx.db, ctx.tenant, repo, number)
      if (row === null) throw new Error('Could not resolve to a node.')
      const made = await nextNumber(ctx.db, ctx.tenant, repo)
      const { pk: _pk, ...data } = (await ctx.db.githubPull.findFirst({
        where: whereOf(repo, number),
      })) as PullRow & { pk: number; tenant: string; repo: string; seq: number }
      await ctx.db.githubPull.create({
        data: {
          ...data,
          number: made,
          seq: made,
          title: input.title ?? `Revert "${row.title}"`,
          body: input.body ?? `Reverts ${repo.fullName}#${String(number)}`,
          state: 'open',
          merged: false,
          draft: input.draft === true,
        },
      })
      return {
        pullRequest: { id: input.pullRequestId },
        revertPullRequest: {
          id: nodeId('011:PullRequest', `${String(repo.seq)}:${String(made)}`),
          number: made,
          url: urlOf(repo, true, made),
        },
      }
    },
    pinIssue: async ({ input }: { input: { issueId: string } }) => {
      const { repo, number } = await subject(ctx, input.issueId)
      kept<boolean>(ctx, 'pinned').set(key(repo, number), true)
      return { issue: { id: input.issueId } }
    },
    unpinIssue: async ({ input }: { input: { issueId: string } }) => {
      const { repo, number } = await subject(ctx, input.issueId)
      kept<boolean>(ctx, 'pinned').delete(key(repo, number))
      return { issue: { id: input.issueId } }
    },
    deleteIssue: async ({ input }: { input: { issueId: string } }) => {
      const { repo, number } = await subject(ctx, input.issueId)
      await ctx.db.githubIssue.deleteMany({ where: whereOf(repo, number) })
      await ctx.db.githubComment.deleteMany({
        where: { ...scope(ctx.tenant), repo: repo.fullName, issueNumber: number },
      })
      return { repository: { id: String(repo.seq) } }
    },
    transferIssue: async ({ input }: { input: { issueId: string; repositoryId: string } }) => {
      const { repo, number } = await subject(ctx, input.issueId)
      const seq = Number(/(\d+)$/.exec(decoded(input.repositoryId))?.[1] ?? 0)
      const destination = await repoBySeq(ctx, seq)
      const made = await nextNumber(ctx.db, ctx.tenant, destination)
      await ctx.db.githubIssue.updateMany({
        where: whereOf(repo, number),
        data: { repo: destination.fullName, number: made },
      })
      const moved = (await ctx.db.githubComment.findMany({
        where: { ...scope(ctx.tenant), repo: repo.fullName, issueNumber: number },
        orderBy: { seq: 'asc' },
      })) as { pk: number }[]
      let id = await nextCommentId(ctx.db, ctx.tenant, destination)
      for (const comment of moved) {
        await ctx.db.githubComment.updateMany({
          where: { pk: comment.pk },
          data: { repo: destination.fullName, issueNumber: made, id, seq: id },
        })
        id += 1
      }
      return { issue: { url: urlOf(destination, false, made) } }
    },
    lockLockable: async ({ input }: { input: { lockableId: string; lockReason?: string } }) => {
      const { repo, number } = await subject(ctx, input.lockableId)
      kept<{ reason: string | null }>(ctx, 'locked').set(key(repo, number), {
        reason: input.lockReason ?? null,
      })
      return { lockedRecord: { locked: true } }
    },
    unlockLockable: async ({ input }: { input: { lockableId: string } }) => {
      const { repo, number } = await subject(ctx, input.lockableId)
      kept(ctx, 'locked').delete(key(repo, number))
      return { unlockedRecord: { locked: false } }
    },
    archiveRepository: async ({ input }: { input: { repositoryId: string } }) =>
      setArchived(ctx, input.repositoryId, true),
    unarchiveRepository: async ({ input }: { input: { repositoryId: string } }) =>
      setArchived(ctx, input.repositoryId, false),
  }
}

async function setArchived(
  ctx: Ctx<C>,
  id: string,
  archived: boolean,
): Promise<{ repository: { id: string } }> {
  const seq = Number(/(\d+)$/.exec(decoded(id))?.[1] ?? 0)
  const repo = await repoBySeq(ctx, seq)
  await ctx.db.githubRepo.updateMany({
    where: { ...scope(ctx.tenant), fullName: repo.fullName },
    data: { metaJson: JSON.stringify({ ...metaOf(repo), archived }) },
  })
  return { repository: { id } }
}

export function rulesetPage(ctx: { tenant: string; db: C }, owner: string) {
  return ({ first, after }: PageArgs) => {
    const rows = [...kept<Record<string, JsonValue>>(ctx, `rulesets\0${owner}`).values()].map(
      (row) => ({
        databaseId: row.id,
        name: row.name,
        target: 'BRANCH',
        enforcement: String(row.enforcement).toUpperCase(),
        source: { __typename: 'Repository', nameWithOwner: owner },
        rules: { totalCount: Array.isArray(row.rules) ? row.rules.length : 0 },
      }),
    )
    return page(rows, first, after)
  }
}

export function gistPage(ctx: { tenant: string; db: C }) {
  return ({ first, after, privacy }: PageArgs & { privacy?: string | null }) => {
    const rows = [...kept<GistRow>(ctx, 'gists').values()]
      .filter((row) => privacy !== 'SECRET' || !row.public)
      .filter((row) => privacy !== 'PUBLIC' || row.public)
      .map((row) => ({
        name: row.id,
        description: row.description,
        isPublic: row.public,
        updatedAt: STAMP,
        files: Object.entries(row.files).map(([name, content]) => ({ name, text: content })),
      }))
    return page(rows.reverse(), first, after)
  }
}

interface GistRow {
  id: string
  description: string
  public: boolean
  files: Record<string, string>
}

function gistJson(row: GistRow): JsonValue {
  return {
    id: row.id,
    description: row.description,
    public: row.public,
    html_url: `https://gist.github.com/${row.id}`,
    owner: { login: DEFAULT_LOGIN },
    updated_at: STAMP,
    files: Object.fromEntries(
      Object.entries(row.files).map(([name, content]) => [
        name,
        { filename: name, type: 'text/plain', content, truncated: false },
      ]),
    ),
  }
}

function collection(
  kind: string,
  named: (row: Record<string, JsonValue>) => string,
  key?: string,
): {
  list: (ctx: Ctx<C>, repo: RepoRow) => Reply
  add: (ctx: Ctx<C>, repo: RepoRow) => Reply
  one: (ctx: Ctx<C>, repo: RepoRow) => Reply
  drop: (ctx: Ctx<C>, repo: RepoRow) => Reply
} {
  const rows = (ctx: Ctx<C>, repo: RepoRow) =>
    kept<Record<string, JsonValue>>(ctx, `${kind}\0${repo.fullName}`)
  return {
    list: (ctx, repo) => pagedReply(ctx, [...rows(ctx, repo).values()], key),
    add: (ctx, repo) => {
      const body = jsonBodyOf(ctx)
      const made = { ...body, id: rows(ctx, repo).size + 1, created_at: STAMP, updated_at: STAMP }
      rows(ctx, repo).set(named(made), made)
      return { status: 201, body: made }
    },
    one: (ctx, repo) => {
      const row = rows(ctx, repo).get(param(ctx, 'item'))
      return row === undefined ? fail(404, 'Not Found') : { status: 200, body: row }
    },
    drop: (ctx, repo) =>
      rows(ctx, repo).delete(param(ctx, 'item'))
        ? { status: 204, body: null }
        : fail(404, 'Not Found'),
  }
}

const KEYS = collection('keys', (row) => String(row.id))
const AUTOLINKS = collection('autolinks', (row) => String(row.id))
const CACHES = collection('caches', (row) => String(row.id), 'actions_caches')
const RULESETS = collection('rulesets', (row) => String(row.id))

async function bump(
  ctx: Ctx<C>,
  repo: RepoRow,
  column: 'assigneesJson' | 'labelsJson',
  key: string,
  sign: 1 | -1,
): Promise<Reply> {
  const number = Number(param(ctx, 'number'))
  const where = { ...scope(ctx.tenant), repo: repo.fullName, number }
  const body = jsonBodyOf(ctx)
  const given = (body[key] ?? [param(ctx, 'name')]) as string[]
  const row = await issueRow(ctx.db, ctx.tenant, repo, number)
  if (row === null) {
    const rows = kept<string[]>(ctx, `pull-${key}\0${repo.fullName}`)
    const now = rows.get(String(number)) ?? []
    rows.set(
      String(number),
      sign > 0 ? [...new Set([...now, ...given])] : now.filter((name) => !given.includes(name)),
    )
    return { status: 200, body: {} }
  }
  const now = JSON.parse(row[column]) as string[]
  const next =
    sign > 0 ? [...new Set([...now, ...given])] : now.filter((name) => !given.includes(name))
  await ctx.db.githubIssue.updateMany({ where, data: { [column]: JSON.stringify(next) } })
  return { status: 200, body: {} }
}

async function pullPeople(ctx: Ctx<C>, repo: RepoRow, sign: 1 | -1): Promise<Reply> {
  const number = Number(param(ctx, 'number'))
  const row = await pullRow(ctx.db, ctx.tenant, repo, number)
  if (row === null) return fail(404, 'Not Found')
  const body = jsonBodyOf(ctx)
  const given = [...((body.reviewers ?? []) as string[])]
  const now = JSON.parse(row.reviewersJson) as string[]
  const next =
    sign > 0 ? [...new Set([...now, ...given])] : now.filter((name) => !given.includes(name))
  await ctx.db.githubPull.updateMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName, number },
    data: { reviewersJson: JSON.stringify(next) },
  })
  return { status: 200, body: {} }
}

function variables(ctx: Ctx<C>, repo: RepoRow): Map<string, Record<string, JsonValue>> {
  return kept(ctx, `variables\0${repo.fullName}`)
}

function secrets(ctx: Ctx<C>, repo: RepoRow): Map<string, Record<string, JsonValue>> {
  return kept(ctx, `secrets\0${repo.fullName}`)
}

export function adminRoutes(): KitRoute<C>[] {
  const repoRoute =
    (
      method: string,
      path: string,
      fn: (ctx: Ctx<C>, repo: RepoRow) => Promise<Reply> | Reply,
      write = method !== 'GET',
    ) =>
    (p: string) =>
      route<C>(
        method as 'GET',
        `${p}/repos/:owner/:repo${path}`,
        authedRoute(withRepo(fn)),
        write ? { write: true } : {},
      )
  const makers = [
    repoRoute('POST', '/labels', (ctx, repo) => {
      const body = jsonBodyOf(ctx)
      const name = str(body, 'name')
      const rows = labelsOf(ctx, repo.fullName)
      if (rows.has(name)) {
        return {
          status: 422,
          body: {
            message: 'Validation Failed',
            errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }],
          },
        }
      }
      rows.set(name, labelRow(repo.fullName, name, str(body, 'color'), str(body, 'description')))
      return { status: 201, body: { name } }
    }),
    repoRoute('PATCH', '/labels/:name', (ctx, repo) => {
      const rows = labelsOf(ctx, repo.fullName)
      const name = param(ctx, 'name')
      const row = rows.get(name)
      if (row === undefined) return fail(404, 'Not Found')
      const body = jsonBodyOf(ctx)
      if (typeof body.color === 'string') row.color = body.color
      if (typeof body.description === 'string') row.description = body.description
      if (typeof body.new_name === 'string') {
        rows.delete(name)
        row.name = body.new_name
        rows.set(row.name, row)
      }
      return { status: 200, body: { name: row.name } }
    }),
    repoRoute('DELETE', '/labels/:name', (ctx, repo) =>
      labelsOf(ctx, repo.fullName).delete(param(ctx, 'name'))
        ? { status: 204, body: null }
        : fail(404, 'Not Found'),
    ),
    repoRoute('GET', '/actions/caches', CACHES.list),
    repoRoute('POST', '/actions/caches', CACHES.add),
    repoRoute('DELETE', '/actions/caches/:item', CACHES.drop),
    repoRoute('GET', '/actions/variables', (ctx, repo) =>
      pagedReply(ctx, [...variables(ctx, repo).values()], 'variables'),
    ),
    repoRoute('POST', '/actions/variables', (ctx, repo) => {
      const body = jsonBodyOf(ctx)
      const name = str(body, 'name')
      if (variables(ctx, repo).has(name)) return fail(409, 'Already exists')
      variables(ctx, repo).set(name, {
        name,
        value: str(body, 'value'),
        created_at: STAMP,
        updated_at: STAMP,
      })
      return { status: 201, body: {} }
    }),
    repoRoute('GET', '/actions/variables/:item', (ctx, repo) => {
      const row = variables(ctx, repo).get(param(ctx, 'item'))
      return row === undefined ? fail(404, 'Not Found') : { status: 200, body: row }
    }),
    repoRoute('PATCH', '/actions/variables/:item', (ctx, repo) => {
      const row = variables(ctx, repo).get(param(ctx, 'item'))
      if (row === undefined) return fail(404, 'Not Found')
      row.value = str(jsonBodyOf(ctx), 'value')
      return { status: 204, body: null }
    }),
    repoRoute('DELETE', '/actions/variables/:item', (ctx, repo) =>
      variables(ctx, repo).delete(param(ctx, 'item'))
        ? { status: 204, body: null }
        : fail(404, 'Not Found'),
    ),
    repoRoute('GET', '/actions/secrets', (ctx, repo) =>
      pagedReply(ctx, [...secrets(ctx, repo).values()], 'secrets'),
    ),
    repoRoute('PUT', '/actions/secrets/:item', (ctx, repo) => {
      const name = param(ctx, 'item')
      secrets(ctx, repo).set(name, { name, created_at: STAMP, updated_at: STAMP })
      return { status: 201, body: {} }
    }),
    repoRoute('DELETE', '/actions/secrets/:item', (ctx, repo) =>
      secrets(ctx, repo).delete(param(ctx, 'item'))
        ? { status: 204, body: null }
        : fail(404, 'Not Found'),
    ),
    repoRoute('DELETE', '/git/refs/*ref', async (ctx, repo) => {
      const ref = param(ctx, 'ref')
      const where = { ...scope(ctx.tenant), repo: repo.fullName }
      const gone = ref.startsWith('tags/')
        ? await ctx.db.githubTagRef.deleteMany({
            where: { ...where, name: ref.slice('tags/'.length) },
          })
        : await ctx.db.githubBranch.deleteMany({
            where: { ...where, name: ref.replace(/^heads\//, '') },
          })
      return gone.count > 0 ? { status: 204, body: null } : fail(422, 'Reference does not exist')
    }),
    repoRoute('POST', '/issues/:number/assignees', (ctx, repo) =>
      bump(ctx, repo, 'assigneesJson', 'assignees', 1),
    ),
    repoRoute('DELETE', '/issues/:number/assignees', (ctx, repo) =>
      bump(ctx, repo, 'assigneesJson', 'assignees', -1),
    ),
    repoRoute('POST', '/issues/:number/labels', (ctx, repo) =>
      bump(ctx, repo, 'labelsJson', 'labels', 1),
    ),
    repoRoute('DELETE', '/issues/:number/labels/:name', (ctx, repo) =>
      bump(ctx, repo, 'labelsJson', 'labels', -1),
    ),
    repoRoute('DELETE', '/pulls/:number/requested_reviewers', (ctx, repo) =>
      pullPeople(ctx, repo, -1),
    ),
    repoRoute('GET', '/keys', KEYS.list),
    repoRoute('POST', '/keys', KEYS.add),
    repoRoute('DELETE', '/keys/:item', KEYS.drop),
    repoRoute('GET', '/autolinks', (ctx, repo) => ({
      status: 200,
      body: [...kept<JsonValue>(ctx, `autolinks\0${repo.fullName}`).values()],
    })),
    repoRoute('POST', '/autolinks', AUTOLINKS.add),
    repoRoute('GET', '/autolinks/:item', AUTOLINKS.one),
    repoRoute('DELETE', '/autolinks/:item', AUTOLINKS.drop),
    repoRoute('POST', '/rulesets', RULESETS.add),
    repoRoute('GET', '/rulesets/:item', (ctx, repo) => {
      const row = kept<Record<string, JsonValue>>(ctx, `rulesets\0${repo.fullName}`).get(
        param(ctx, 'item'),
      )
      return row === undefined
        ? fail(404, 'Not Found')
        : {
            status: 200,
            body: { ...row, source: repo.fullName, source_type: 'Repository' },
          }
    }),
    repoRoute('GET', '/rules/branches/:branch', (ctx, repo) => ({
      status: 200,
      body: [
        ...kept<Record<string, JsonValue>>(ctx, `rulesets\0${repo.fullName}`).values(),
      ].flatMap((row) => (Array.isArray(row.rules) ? row.rules : [])),
    })),
    repoRoute('POST', '/actions/runs/:run/cancel', async (ctx, repo) =>
      (await runRow(ctx, repo, Number(param(ctx, 'run')))) === null
        ? fail(404, 'Not Found')
        : { status: 202, body: {} },
    ),
    repoRoute('POST', '/actions/runs/:run/force-cancel', async (ctx, repo) =>
      (await runRow(ctx, repo, Number(param(ctx, 'run')))) === null
        ? fail(404, 'Not Found')
        : { status: 202, body: {} },
    ),
    repoRoute('DELETE', '/actions/runs/:run', async (ctx, repo) => {
      if ((await runRow(ctx, repo, Number(param(ctx, 'run')))) === null)
        return fail(404, 'Not Found')
      await ctx.db.githubRun.deleteMany({
        where: { ...scope(ctx.tenant), repo: repo.fullName, id: Number(param(ctx, 'run')) },
      })
      return { status: 204, body: null }
    }),
    repoRoute('PUT', '/actions/workflows/:workflow/enable', async (ctx, repo) => {
      const row = await findWorkflowRow(ctx, repo, param(ctx, 'workflow'))
      if (row === null) return fail(404, 'Not Found')
      await ctx.db.githubWorkflow.updateMany({
        where: { ...scope(ctx.tenant), repo: repo.fullName, id: row.id },
        data: { state: 'active' },
      })
      return { status: 204, body: null }
    }),
    repoRoute('PUT', '/actions/workflows/:workflow/disable', async (ctx, repo) => {
      const row = await findWorkflowRow(ctx, repo, param(ctx, 'workflow'))
      if (row === null) return fail(404, 'Not Found')
      await ctx.db.githubWorkflow.updateMany({
        where: { ...scope(ctx.tenant), repo: repo.fullName, id: row.id },
        data: { state: 'disabled_manually' },
      })
      return { status: 204, body: null }
    }),
    repoRoute('POST', '/merge-upstream', (ctx) => ({
      status: 200,
      body: {
        message: 'ok',
        merge_type: 'fast-forward',
        base_branch: str(jsonBodyOf(ctx), 'branch'),
      },
    })),
    repoRoute('PATCH', '/releases/:release', async (ctx, repo) => {
      const id = Number(param(ctx, 'release'))
      const body = jsonBodyOf(ctx)
      const data: Record<string, unknown> = {}
      if (typeof body.name === 'string') data.name = body.name
      if (typeof body.body === 'string') data.body = body.body
      if (typeof body.draft === 'boolean') data.draft = body.draft
      if (typeof body.prerelease === 'boolean') data.prerelease = body.prerelease
      if (typeof body.tag_name === 'string') data.tagName = body.tag_name
      await ctx.db.githubRelease.updateMany({
        where: { ...scope(ctx.tenant), repo: repo.fullName, id },
        data,
      })
      const tag = typeof body.tag_name === 'string' ? body.tag_name : ''
      return {
        status: 200,
        body: { id, html_url: `https://github.com/${repo.fullName}/releases/tag/${tag}` },
      }
    }),
    repoRoute('DELETE', '/releases/:release', async (ctx, repo) => {
      await ctx.db.githubRelease.deleteMany({
        where: { ...scope(ctx.tenant), repo: repo.fullName, id: Number(param(ctx, 'release')) },
      })
      return { status: 204, body: null }
    }),
  ]
  const gists = (ctx: Ctx<C>): Map<string, GistRow> => kept<GistRow>(ctx, 'gists')
  return everywhere<C>(API_PREFIXES, (p) => [
    ...makers.map((make) => make(p)),
    route<C>(
      'POST',
      `${p}/gists`,
      authedRoute((ctx) => {
        const body = jsonBodyOf(ctx)
        const id = `gist${String(gists(ctx).size + 1)}`
        const files = Object.fromEntries(
          Object.entries((body.files ?? {}) as Record<string, { content: string }>).map(
            ([name, file]) => [name, file.content],
          ),
        )
        const row: GistRow = {
          id,
          description: str(body, 'description'),
          public: body.public === true,
          files,
        }
        gists(ctx).set(id, row)
        return { status: 201, body: gistJson(row) }
      }),
      { write: true },
    ),
    route<C>(
      'GET',
      `${p}/gists/:gist`,
      authedRoute((ctx) => {
        const row = gists(ctx).get(param(ctx, 'gist'))
        return row === undefined ? fail(404, 'Not Found') : { status: 200, body: gistJson(row) }
      }),
    ),
    route<C>(
      'POST',
      `${p}/gists/:gist`,
      authedRoute((ctx) => {
        const row = gists(ctx).get(param(ctx, 'gist'))
        if (row === undefined) return fail(404, 'Not Found')
        const body = jsonBodyOf(ctx)
        if (typeof body.description === 'string') row.description = body.description
        const files = (body.files ?? {}) as Record<
          string,
          { content?: string; filename?: string } | null
        >
        for (const [name, file] of Object.entries(files)) {
          if (file === null || file.content === '') {
            Reflect.deleteProperty(row.files, name)
          } else {
            Reflect.deleteProperty(row.files, name)
            row.files[file.filename ?? name] = file.content ?? ''
          }
        }
        return { status: 200, body: gistJson(row) }
      }),
      { write: true },
    ),
    route<C>(
      'DELETE',
      `${p}/gists/:gist`,
      authedRoute((ctx) =>
        gists(ctx).delete(param(ctx, 'gist'))
          ? { status: 204, body: null }
          : fail(404, 'Not Found'),
      ),
      { write: true },
    ),
    route<C>(
      'GET',
      `${p}/gitignore/templates`,
      authedRoute(() => ({ status: 200, body: ['Go', 'Rust'] })),
    ),
    route<C>(
      'GET',
      `${p}/gitignore/templates/:name`,
      authedRoute((ctx) => {
        const name = param(ctx, 'name')
        return name === 'Go' || name === 'Rust'
          ? { status: 200, body: { name, source: `# ${name}\n` } }
          : fail(404, 'Not Found')
      }),
    ),
    route<C>(
      'GET',
      `${p}/licenses`,
      authedRoute(() => ({
        status: 200,
        body: [{ key: 'mit', spdx_id: 'MIT', name: 'MIT License' }],
      })),
    ),
    route<C>(
      'GET',
      `${p}/licenses/:name`,
      authedRoute((ctx) =>
        param(ctx, 'name') === 'mit'
          ? { status: 200, body: { key: 'mit', name: 'MIT License', body: 'MIT text\n' } }
          : fail(404, 'Not Found'),
      ),
    ),
  ])
}
