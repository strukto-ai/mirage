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
import { combinedStatus } from './actions.ts'
import { commitHistory, rangeOf } from './compare.ts'
import type { Range } from './compare.ts'
import { changeJson, changeType, patchLines } from './diff.ts'
import type { FileChange, PatchLine } from './diff.ts'
import {
  PROJECTS_CLASSIC_GONE,
  closedNumbers,
  commitIdentity,
  commitSha,
  issueNodeId,
  nodeId,
  ownerNode,
  page,
  pullNodeId,
  reactionGroups,
  userNode,
} from './wire.ts'
import type { CommitRow, PageArgs } from './wire.ts'
import {
  allRepos,
  branchFor,
  commitsBySha,
  commitsJson,
  forkOwnedBy,
  nextNumber,
  reachableFrom,
  repoJson,
  resolveRef,
  scope,
} from './store.ts'
import type { RepoRow, Resolved } from './store.ts'
import {
  authedRoute,
  diffReply,
  everywhere,
  fail,
  jsonBodyOf,
  numberParam,
  ordered,
  pagedReply,
  route,
  str,
  validationFailed,
  withRepo,
} from './http.ts'

const CREATED_AT = '2026-01-01T00:00:00Z'
const EDITED_AT = '2026-01-01T00:02:00Z'
const MERGED_AT = '2026-01-01T00:03:00Z'

const CREATE_DOCS = 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request'
const REVIEW_DOCS = 'https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request'
const COMMENT_DOCS =
  'https://docs.github.com/rest/pulls/comments#create-a-review-comment-for-a-pull-request'
export interface PullRow {
  number: number
  title: string
  body: string
  state: string
  user: string
  head: string
  base: string
  draft: boolean
  merged: boolean
  headSha: string
  headRepoSeq: number
  reviewersJson: string
  createdAt: string
  updatedAt: string
}

interface ReviewRow {
  id: number
  user: string
  body: string
  state: string
  commitId: string
  submittedAt: string
}

// The review states the vendor records for the event a caller posts, and the
// refusal it gives an author who reviews their own pull request with one.
const REVIEW_STATES: Record<string, string> = {
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
  COMMENT: 'COMMENTED',
}
const OWN_REVIEW_REFUSALS: Record<string, string> = {
  APPROVE: 'Can not approve your own pull request',
  REQUEST_CHANGES: 'Can not request changes on your own pull request',
}
const REVIEWED_AT = '2026-01-01T00:04:00Z'

/**
 * Where a pull request stands now: its head, which is its branch while that
 * exists and the commit it last named once it does not, its base branch's
 * tip, and the range the head holds past the base. Everything a pull request
 * reports about what it changes is read off that range, the same one a
 * comparison of the two answers. A head that no longer shares history with
 * its base, which only a forced ref move can make, changes nothing. `history`
 * is every commit the head reaches through any parent, which is what a review
 * may name.
 */
interface PullState {
  head: string
  base: string
  history: CommitRow[]
  range: Range
}

const NO_RANGE: Range = { ahead: [], behind: 0, before: '', after: '', changes: [] }

// The branch a head names: `head` is the branch, or `owner:branch` for one a
// fixture states in GitHub's label form.
function headBranch(row: PullRow): string {
  const cut = row.head.indexOf(':')
  return cut < 0 ? row.head : row.head.slice(cut + 1)
}

// The repository a pull request's head lives in: this one, or the fork in its
// network the row names by seq, or whose owner an `owner:` head names. Null
// when that repository is gone, as GitHub then reports the head's repo.
export async function headRepoOf(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  row: PullRow,
): Promise<RepoRow | null> {
  const repos = await allRepos(ctx.db, ctx.tenant)
  if (row.headRepoSeq >= 0) return repos.find((r) => r.seq === row.headRepoSeq) ?? null
  const cut = row.head.indexOf(':')
  const owner = cut < 0 ? repo.owner : row.head.slice(0, cut)
  if (owner.toLowerCase() === repo.owner.toLowerCase()) return repo
  return await forkOwnedBy(ctx.db, ctx.tenant, repo, owner, headBranch(row))
}

async function pullHead(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  row: PullRow,
): Promise<Resolved | null> {
  const home = await headRepoOf(ctx, repo, row)
  const branch = home === null ? null : await branchFor(ctx.db, ctx.tenant, home, headBranch(row))
  if (branch === null && row.headSha === '') return null
  return await resolveRef(
    ctx.db,
    ctx.tenant,
    home ?? repo,
    branch === null ? row.headSha : `refs/heads/${branch}`,
  )
}

async function pullBase(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  row: PullRow,
): Promise<Resolved | null> {
  const branch = await branchFor(ctx.db, ctx.tenant, repo, row.base)
  return branch === null ? null : await resolveRef(ctx.db, ctx.tenant, repo, `refs/heads/${branch}`)
}

async function pullState(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  row: PullRow,
): Promise<PullState> {
  const head = await pullHead(ctx, repo, row)
  const base = await pullBase(ctx, repo, row)
  const home = (await headRepoOf(ctx, repo, row)) ?? repo
  const range =
    head === null || base === null
      ? NO_RANGE
      : ((await rangeOf(ctx.db, ctx.tenant, repo, base, head, home)) ?? NO_RANGE)
  const tip = head?.history[0]?.sha
  return {
    head: tip ?? row.headSha,
    base: base?.history[0]?.sha ?? '',
    history:
      tip === undefined ? [] : reachableFrom(tip, await commitsBySha(ctx.db, ctx.tenant, home)),
    range,
  }
}

// A pull request as the list and every write answer it. The counts and the
// mergeable state are not in it, as GitHub leaves them out of a list; the
// head and base shas are where those refs point now, and each side names its
// repository and its `owner:branch` label, the head's a fork's when it comes
// from one.
export async function pullJson(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  row: PullRow,
): Promise<JsonValue> {
  const head = await pullHead(ctx, repo, row)
  const base = await pullBase(ctx, repo, row)
  const home = await headRepoOf(ctx, repo, row)
  const cut = row.head.indexOf(':')
  const headOwner = home?.owner ?? (cut < 0 ? repo.owner : row.head.slice(0, cut))
  const side = async (owner: string, ref: string, sha: string, at: RepoRow | null) => ({
    label: `${owner}:${ref}`,
    ref,
    sha,
    user: { login: owner },
    repo: at === null ? null : await repoJson(ctx.db, ctx.tenant, at),
  })
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    draft: row.draft,
    user: { login: row.user },
    labels: [],
    base: await side(repo.owner, row.base, base?.history[0]?.sha ?? '', repo),
    head: await side(headOwner, headBranch(row), head?.history[0]?.sha ?? row.headSha, home),
    merged_at: row.merged ? MERGED_AT : null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    html_url: `https://github.com/${repo.fullName}/pull/${String(row.number)}`,
  }
}

// One pull request as `GET /pulls/{number}` answers it: the list shape, and
// the counts of the range its head holds past its base.
async function pullDetail(ctx: Ctx<C>, repo: RepoRow, row: PullRow): Promise<JsonValue> {
  const { range } = await pullState(ctx, repo, row)
  return {
    ...record(await pullJson(ctx, repo, row)),
    merged: row.merged,
    mergeable: true,
    commits: range.ahead.length,
    additions: range.changes.reduce((n, c) => n + c.additions, 0),
    deletions: range.changes.reduce((n, c) => n + c.deletions, 0),
    changed_files: range.changes.length,
  }
}

function record(value: JsonValue): Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

export async function pullRow(
  db: C,
  tenant: string,
  repo: RepoRow,
  number: number,
): Promise<PullRow | null> {
  return (await db.githubPull.findFirst({
    where: { ...scope(tenant), repo: repo.fullName, number },
  })) as PullRow | null
}

async function found(ctx: Ctx<C>, repo: RepoRow): Promise<PullRow | null> {
  const number = numberParam(ctx)
  return number === null ? null : await pullRow(ctx.db, ctx.tenant, repo, number)
}

// `sort` is `created` (the default), `updated`, `popularity`, which is the
// comment count, or `long-running`, which orders by creation; GitHub's further
// narrowing of that one to pull requests open a month and active in the last
// one needs a clock the fake does not keep, so it is not applied. `direction`
// defaults to `desc` for `created` and to `asc` for the rest, as GitHub's does.
async function listPulls(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const rows = (await ctx.db.githubPull.findMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName },
  })) as PullRow[]
  const wanted = ctx.query.get('state') ?? 'open'
  let kept = rows.filter((r) => wanted === 'all' || r.state === wanted)
  const base = ctx.query.get('base') ?? ''
  const head = ctx.query.get('head') ?? ''
  if (base !== '') kept = kept.filter((r) => r.base === base)
  if (head !== '') {
    // `owner:branch`, as GitHub takes it, or a bare branch of this repository.
    const labels = await Promise.all(
      kept.map(async (r) => `${((await headRepoOf(ctx, repo, r)) ?? repo).owner}:${headBranch(r)}`),
    )
    kept = kept.filter((r, i) =>
      head.includes(':')
        ? labels[i] === head
        : headBranch(r) === head && labels[i]?.startsWith(`${repo.owner}:`),
    )
  }
  const sort = ctx.query.get('sort') ?? 'created'
  const direction = ctx.query.get('direction') ?? (sort === 'created' ? 'desc' : 'asc')
  const comments = await ctx.db.githubComment.findMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName },
    select: { issueNumber: true },
  })
  const talk = (row: PullRow): number => comments.filter((c) => c.issueNumber === row.number).length
  const key = (row: PullRow): number | string =>
    sort === 'updated' ? row.updatedAt : sort === 'popularity' ? talk(row) : row.createdAt
  const sorted = ordered(kept, key, direction)
  return pagedReply(ctx, await Promise.all(sorted.map((r) => pullJson(ctx, repo, r))))
}

// A pull request needs a head and a base that are branches, sharing history,
// a head that holds something its base does not, and no open pull request
// between the same two already. Each refusal is GitHub's. A head may be
// spelled `owner:branch`: this repository's branch when the owner is its own,
// and otherwise that account's fork in this repository's network.
async function createPull(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const body = jsonBodyOf(ctx)
  const title = str(body, 'title')
  const head = str(body, 'head')
  const base = str(body, 'base')
  if (title === '' || head === '' || base === '') return fail(422, 'Validation Failed')
  const cut = head.indexOf(':')
  const owner = cut < 0 ? repo.owner : head.slice(0, cut)
  const named = cut < 0 ? head : head.slice(cut + 1)
  const home =
    owner.toLowerCase() === repo.owner.toLowerCase()
      ? repo
      : await forkOwnedBy(ctx.db, ctx.tenant, repo, owner, named)
  const headName =
    home === null || named === '' ? null : await branchFor(ctx.db, ctx.tenant, home, named)
  const baseBranch = await branchFor(ctx.db, ctx.tenant, repo, base)
  const invalid = [
    ...(baseBranch === null ? [{ resource: 'PullRequest', field: 'base', code: 'invalid' }] : []),
    ...(headName === null ? [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] : []),
  ]
  if (home === null || headName === null || baseBranch === null) {
    return validationFailed(invalid, CREATE_DOCS)
  }
  const cross = home.seq !== repo.seq
  const label = cross ? `${home.owner}:${headName}` : headName
  const custom = (message: string): Reply =>
    validationFailed([{ resource: 'PullRequest', code: 'custom', message }], CREATE_DOCS)
  const headRepoSeq = cross ? home.seq : -1
  const open = await ctx.db.githubPull.findFirst({
    where: {
      ...scope(ctx.tenant),
      repo: repo.fullName,
      head: headName,
      headRepoSeq,
      base: baseBranch,
      state: 'open',
    },
  })
  if (open !== null) {
    return custom(`A pull request already exists for ${home.owner}:${headName}.`)
  }
  const draft: PullRow = {
    number: 0,
    title,
    body: str(body, 'body'),
    state: 'open',
    user: DEFAULT_LOGIN,
    head: headName,
    base: baseBranch,
    draft: body.draft === true,
    merged: false,
    headSha: '',
    headRepoSeq,
    reviewersJson: '[]',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }
  const from = await resolveRef(ctx.db, ctx.tenant, repo, `refs/heads/${baseBranch}`)
  const to = await resolveRef(ctx.db, ctx.tenant, home, `refs/heads/${headName}`)
  const range =
    from === null || to === null ? null : await rangeOf(ctx.db, ctx.tenant, repo, from, to, home)
  if (range === null) {
    return custom(`The ${label} branch has no history in common with ${baseBranch}`)
  }
  if (range.ahead.length === 0) return custom(`No commits between ${baseBranch} and ${label}`)
  const number = await nextNumber(ctx.db, ctx.tenant, repo)
  const row: PullRow = { ...draft, number, headSha: range.after }
  await ctx.db.githubPull.create({
    data: { tenant: ctx.tenant, repo: repo.fullName, ...row, seq: number },
  })
  return { status: 201, body: await pullDetail(ctx, repo, row) }
}

async function getPull(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await found(ctx, repo)
  if (row === null) return fail(404, 'Not Found')
  const diff = diffReply(ctx, (await pullState(ctx, repo, row)).range.changes)
  if (diff !== null) return diff
  return { status: 200, body: await pullDetail(ctx, repo, row) }
}

// The files a pull request changes, a page at a time, each as a comparison
// lists it.
async function listPullFiles(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await found(ctx, repo)
  if (row === null) return fail(404, 'Not Found')
  const { range } = await pullState(ctx, repo, row)
  return pagedReply(
    ctx,
    range.changes.map((c) => changeJson(repo.fullName, c, range.before, range.after)),
  )
}

// The commits a pull request carries, oldest first, as GitHub lists them.
async function listPullCommits(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await found(ctx, repo)
  if (row === null) return fail(404, 'Not Found')
  const { range } = await pullState(ctx, repo, row)
  return pagedReply(ctx, await commitsJson(ctx.db, ctx.tenant, repo, [...range.ahead].reverse()))
}

async function editPull(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await found(ctx, repo)
  if (row === null) return fail(404, 'Not Found')
  const body = jsonBodyOf(ctx)
  const next: PullRow = { ...row, updatedAt: EDITED_AT }
  if ('title' in body) next.title = str(body, 'title')
  if ('body' in body) next.body = str(body, 'body')
  if ('state' in body) next.state = str(body, 'state')
  if ('base' in body) next.base = str(body, 'base')
  await ctx.db.githubPull.updateMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName, number: row.number },
    data: next,
  })
  return { status: 200, body: await pullDetail(ctx, repo, next) }
}

// A merge takes an optional expected head sha, and refuses when it does not
// match: that is how the vendor reports a branch that moved under the caller.
async function mergePull(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await found(ctx, repo)
  if (row === null) return fail(404, 'Not Found')
  const expected = str(jsonBodyOf(ctx), 'sha')
  const head = (await pullState(ctx, repo, row)).head
  if (expected !== '' && expected !== head) return fail(409, 'Head branch was modified')
  await ctx.db.githubPull.updateMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName, number: row.number },
    data: { state: 'closed', merged: true },
  })
  return {
    status: 200,
    body: {
      sha: commitSha('merge'),
      merged: true,
      message: 'Pull Request successfully merged',
    },
  }
}

function reviewJson(repo: RepoRow, number: number, row: ReviewRow): JsonValue {
  return {
    id: row.id,
    node_id: nodeId('017:PullRequestReview', row.id),
    user: { login: row.user },
    body: row.body,
    state: row.state,
    html_url: `https://github.com/${repo.fullName}/pull/${String(number)}#pullrequestreview-${String(row.id)}`,
    commit_id: row.commitId,
    submitted_at: row.submittedAt,
    author_association: 'NONE',
  }
}

interface ReviewCommentRow {
  id: number
  reviewId: number
  inReplyTo: number
  user: string
  body: string
  path: string
  line: number
  side: string
  startLine: number
  startSide: string
  subjectType: string
  commitId: string
  diffHunk: string
  createdAt: string
}

const COMMENTED_AT = '2026-01-01T00:05:00Z'

// GitHub's refusal of a request it parsed and would not carry out, which
// names each reason as a sentence.
function unprocessable(reason: string, documentation = 'https://docs.github.com/rest'): Reply {
  return {
    status: 422,
    body: { message: 'Unprocessable Entity', errors: [reason], documentation_url: documentation },
  }
}

// How GitHub refuses a comment on a line its diff does not show, taken from
// its documented reply rather than measured.
const OFF_THE_DIFF =
  "Pull request review thread line must be part of the diff and Pull request review thread diff hunk can't be blank"

// Review commits must be reachable from the head, independently of the base's
// current position. An advancing base removes commits from the diff range,
// but cannot remove them from the head's ancestry. The default head follows
// the same validation as an explicit sha; refusal wording is not measured.
function reviewedCommit(state: PullState, body: Record<string, JsonValue>): string | null {
  const named = str(body, 'commit_id') || state.head
  return state.history.some((c) => c.sha === named) ? named : null
}

type Placement = Pick<
  ReviewCommentRow,
  'path' | 'line' | 'side' | 'startLine' | 'startSide' | 'subjectType' | 'diffHunk'
>

// Where one requested comment lands in a pull request's diff. The file must
// be one the pull request changes. A file comment needs nothing more; a line
// comment names a line the patch shows on the side it names (RIGHT, the new
// file, unless it says LEFT), or the deprecated `position`, counted from the
// file's first hunk header. A range starts at `start_line`, which must come
// first. `diff_hunk` is the hunk's header down to the commented line, as
// GitHub quotes it. Null for anything the diff does not show.
function place(state: PullState, spec: Record<string, JsonValue>): Placement | null {
  const path = str(spec, 'path')
  const change = state.range.changes.find((c) => c.filename === path)
  if (change === undefined) return null
  const none = { line: 0, side: '', startLine: 0, startSide: '', diffHunk: '' }
  if (str(spec, 'subject_type') === 'file') return { path, subjectType: 'file', ...none }
  const lines = patchLines(change)
  const at = (side: string, line: JsonValue | undefined): PatchLine | undefined =>
    typeof line === 'number'
      ? lines.find((l) => (side === 'LEFT' ? l.old : l.new) === line)
      : undefined
  let side = str(spec, 'side') || 'RIGHT'
  let hit = at(side, spec.line)
  if (spec.line === undefined && typeof spec.position === 'number') {
    hit = lines.find((l) => l.position === spec.position && l.kind !== '@')
    side = hit?.kind === '-' ? 'LEFT' : 'RIGHT'
  }
  const line = side === 'LEFT' ? hit?.old : hit?.new
  if (hit === undefined || line === null || line === undefined) return null
  const startSide = spec.start_line === undefined ? '' : str(spec, 'start_side') || side
  const start = spec.start_line === undefined ? undefined : at(startSide, spec.start_line)
  if (spec.start_line !== undefined && (start === undefined || start.position > hit.position)) {
    return null
  }
  const diffHunk = lines
    .filter((l) => l.position >= hit.header && l.position <= hit.position)
    .map((l) => l.text)
    .join('\n')
  return {
    path,
    line,
    side,
    startLine: start === undefined ? 0 : ((startSide === 'LEFT' ? start.old : start.new) ?? 0),
    startSide,
    subjectType: 'line',
    diffHunk,
  }
}

function reviewCommentJson(repo: RepoRow, number: number, row: ReviewCommentRow): JsonValue {
  const file = row.subjectType === 'file'
  const start = row.startLine === 0 ? null : row.startLine
  return {
    id: row.id,
    node_id: nodeId('024:PullRequestReviewComment', row.id),
    pull_request_review_id: row.reviewId,
    diff_hunk: row.diffHunk,
    path: row.path,
    commit_id: row.commitId,
    original_commit_id: row.commitId,
    user: { login: row.user },
    body: row.body,
    created_at: row.createdAt,
    updated_at: row.createdAt,
    html_url: `https://github.com/${repo.fullName}/pull/${String(number)}#discussion_r${String(row.id)}`,
    pull_request_url: `https://api.github.com/repos/${repo.fullName}/pulls/${String(number)}`,
    author_association: 'NONE',
    start_line: start,
    original_start_line: start,
    start_side: row.startSide === '' ? null : row.startSide,
    line: file ? null : row.line,
    original_line: file ? null : row.line,
    side: file ? null : row.side,
    subject_type: row.subjectType,
    ...(row.inReplyTo === 0 ? {} : { in_reply_to_id: row.inReplyTo }),
  }
}

async function reviewCommentRows(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  number: number,
): Promise<ReviewCommentRow[]> {
  return (await ctx.db.githubReviewComment.findMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName, pullNumber: number },
    orderBy: { seq: 'asc' },
  })) as ReviewCommentRow[]
}

// Record a review and the comments it carries, all placed already.
async function recordReview(
  ctx: Ctx<C>,
  repo: RepoRow,
  pull: PullRow,
  review: Omit<ReviewRow, 'id'>,
  comments: Array<Placement & { body: string; inReplyTo: number }>,
): Promise<{ review: ReviewRow; comments: ReviewCommentRow[] }> {
  const seq = (await reviewRows(ctx, repo, pull.number)).length + 1
  const made: ReviewRow = { id: 8000 + pull.number * 100 + seq, ...review }
  await ctx.db.githubReview.create({
    data: { tenant: ctx.tenant, repo: repo.fullName, pullNumber: pull.number, ...made, seq },
  })
  const first = (await reviewCommentRows(ctx, repo, pull.number)).length + 1
  const rows = comments.map((comment, i): ReviewCommentRow => ({
    id: 900_000 + pull.number * 1000 + first + i,
    reviewId: made.id,
    user: made.user,
    commitId: made.commitId,
    createdAt: COMMENTED_AT,
    ...comment,
  }))
  for (const [i, row] of rows.entries()) {
    await ctx.db.githubReviewComment.create({
      data: {
        tenant: ctx.tenant,
        repo: repo.fullName,
        pullNumber: pull.number,
        ...row,
        seq: first + i,
      },
    })
  }
  return { review: made, comments: rows }
}

async function listReviewComments(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await found(ctx, repo)
  if (row === null) return fail(404, 'Not Found')
  const rows = await reviewCommentRows(ctx, repo, row.number)
  return pagedReply(
    ctx,
    rows.map((comment) => reviewCommentJson(repo, row.number, comment)),
  )
}

// One comment outside a review, which GitHub files under a COMMENTED review
// of its own. A reply, by `in_reply_to` or the replies route, takes the place
// of the comment it answers.
async function createReviewComment(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await found(ctx, repo)
  if (row === null) return fail(404, 'Not Found')
  const body = jsonBodyOf(ctx)
  const text = str(body, 'body')
  if (text === '') return fail(422, 'Validation Failed')
  const replyTo =
    ctx.params.comment ?? (typeof body.in_reply_to === 'number' ? String(body.in_reply_to) : '')
  const state = await pullState(ctx, repo, row)
  let placed: Placement | null
  let inReplyTo = 0
  if (replyTo !== '') {
    const parent = (await reviewCommentRows(ctx, repo, row.number)).find(
      (c) => String(c.id) === replyTo,
    )
    if (parent === undefined) return fail(404, 'Not Found')
    placed = pick(parent)
    inReplyTo = parent.inReplyTo === 0 ? parent.id : parent.inReplyTo
  } else {
    placed = place(state, body)
  }
  if (placed === null) return unprocessable(OFF_THE_DIFF, COMMENT_DOCS)
  const commitId = reviewedCommit(state, body)
  if (commitId === null) {
    return validationFailed(
      [{ resource: 'PullRequestReviewComment', code: 'invalid', field: 'commit_id' }],
      COMMENT_DOCS,
    )
  }
  const { comments } = await recordReview(
    ctx,
    repo,
    row,
    {
      user: DEFAULT_LOGIN,
      body: '',
      state: 'COMMENTED',
      commitId,
      submittedAt: COMMENTED_AT,
    },
    [{ ...placed, body: text, inReplyTo }],
  )
  const [made] = comments
  if (made === undefined) throw new Error('github fake: a recorded review comment went missing')
  return { status: 201, body: reviewCommentJson(repo, row.number, made) }
}

// The place a reply inherits, without the rest of the comment it answers.
function pick(from: Placement): Placement {
  const { path, line, side, startLine, startSide, subjectType, diffHunk } = from
  return { path, line, side, startLine, startSide, subjectType, diffHunk }
}

async function reviewRows(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  number: number,
): Promise<ReviewRow[]> {
  return (await ctx.db.githubReview.findMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName, pullNumber: number },
    orderBy: { seq: 'asc' },
  })) as ReviewRow[]
}

async function listReviews(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await found(ctx, repo)
  if (row === null) return fail(404, 'Not Found')
  const rows = await reviewRows(ctx, repo, row.number)
  return pagedReply(
    ctx,
    rows.map((review) => reviewJson(repo, row.number, review)),
  )
}

// A review names an event and, for any but an approval, a body. The author
// of a pull request may comment on it but neither approve it nor ask for
// changes, which is the vendor's rule for the one account the fake has.
async function createReview(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await found(ctx, repo)
  if (row === null) return fail(404, 'Not Found')
  const body = jsonBodyOf(ctx)
  const event = str(body, 'event')
  const state = REVIEW_STATES[event]
  const text = str(body, 'body')
  if (state === undefined || (event !== 'APPROVE' && text === '')) {
    return fail(422, 'Unprocessable Entity')
  }
  const refusal = row.user === DEFAULT_LOGIN ? OWN_REVIEW_REFUSALS[event] : undefined
  if (refusal !== undefined) return unprocessable(refusal)
  const pull = await pullState(ctx, repo, row)
  const asked = Array.isArray(body.comments) ? body.comments : []
  const comments: Array<Placement & { body: string; inReplyTo: number }> = []
  for (const spec of asked) {
    const placed = place(pull, record(spec))
    if (placed === null) return unprocessable(OFF_THE_DIFF)
    comments.push({ ...placed, body: str(record(spec), 'body'), inReplyTo: 0 })
  }
  const commitId = reviewedCommit(pull, body)
  if (commitId === null) {
    return validationFailed(
      [{ resource: 'PullRequestReview', code: 'invalid', field: 'commit_id' }],
      REVIEW_DOCS,
    )
  }
  const { review } = await recordReview(
    ctx,
    repo,
    row,
    {
      user: DEFAULT_LOGIN,
      body: text,
      state,
      commitId,
      submittedAt: REVIEWED_AT,
    },
    comments,
  )
  return { status: 200, body: reviewJson(repo, row.number, review) }
}

// The vendor refuses a review request of the pull request's own author, and
// records every other login once, in the order asked.
async function requestReviewers(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await found(ctx, repo)
  if (row === null) return fail(404, 'Not Found')
  const asked = jsonBodyOf(ctx).reviewers
  const logins = Array.isArray(asked) ? asked.filter((l): l is string => typeof l === 'string') : []
  if (logins.includes(row.user)) {
    return fail(422, 'Review cannot be requested from pull request author.')
  }
  const reviewers = [...new Set([...(JSON.parse(row.reviewersJson) as string[]), ...logins])]
  const next: PullRow = { ...row, reviewersJson: JSON.stringify(reviewers) }
  await ctx.db.githubPull.updateMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName, number: row.number },
    data: { reviewersJson: next.reviewersJson },
  })
  return { status: 201, body: await pullDetail(ctx, repo, next) }
}

function reviewNode(repo: RepoRow, number: number, row: ReviewRow): Record<string, unknown> {
  return {
    id: nodeId('017:PullRequestReview', row.id),
    author: userNode(row.user),
    authorAssociation: 'NONE',
    body: row.body,
    state: row.state,
    submittedAt: row.submittedAt,
    commit: { oid: row.commitId },
    reactionGroups: reactionGroups(),
    url: `https://github.com/${repo.fullName}/pull/${String(number)}#pullrequestreview-${String(row.id)}`,
  }
}

/** The arguments GraphQL's `Commit.history` is read with. */
interface HistoryArgs extends PageArgs {
  path?: string | null
  since?: string | null
  until?: string | null
}

/**
 * One commit as GraphQL's `Commit` reports it: its headline and body, who
 * wrote it and when, the checks and statuses set on it in the repositories
 * named, rolled up (the base's, and the fork's for a pull request from one,
 * since its head commit's CI may report to either), and its history, the
 * listing `GET /commits` answers from it, filtered and paged the same way.
 */
export function commitNode(
  ctx: { db: C; tenant: string },
  repos: RepoRow[],
  row: CommitRow,
): Record<string, unknown> {
  const where = {
    ...scope(ctx.tenant),
    repo: { in: repos.map((r) => r.fullName) },
    sha: row.sha,
  }
  const who = commitIdentity(row)
  const [headline = '', ...rest] = row.message.split('\n')
  return {
    __typename: 'Commit',
    oid: row.sha,
    messageHeadline: headline,
    messageBody: rest.join('\n').replace(/^\n+/, ''),
    committedDate: who.committed,
    authoredDate: who.authored,
    authors: {
      nodes: [
        { name: who.name, email: who.email, user: who.login === '' ? null : userNode(who.login) },
      ],
    },
    statusCheckRollup: {
      contexts: async ({ first, after }: PageArgs) => {
        const checks = await ctx.db.githubCheck.findMany({ where, orderBy: { pk: 'asc' } })
        const statuses = (await combinedStatus(ctx, repos, row.sha)).rows
        const contexts = [
          ...checks.map((check) => ({
            __typename: 'CheckRun',
            name: check.name,
            status: check.status.toUpperCase(),
            conclusion: check.conclusion === '' ? null : check.conclusion.toUpperCase(),
            startedAt: check.startedAt,
            completedAt: check.completedAt,
            detailsUrl: check.detailsUrl,
            checkSuite: { workflowRun: { event: 'pull_request', workflow: { name: 'CI' } } },
          })),
          ...statuses.map((status) => ({
            __typename: 'StatusContext',
            context: status.context,
            state: status.state.toUpperCase(),
            targetUrl: status.targetUrl,
            createdAt: status.createdAt,
            description: status.description,
          })),
        ]
        return page(contexts, first, after)
      },
    },
    history: async ({ first, after, path, since, until }: HistoryArgs) => {
      const [home] = repos
      if (home === undefined) return page([], first, after)
      const byId = await commitsBySha(ctx.db, ctx.tenant, home)
      const listed = await commitHistory(ctx.db, ctx.tenant, home, row.sha, byId, {
        since: since ?? null,
        until: until ?? null,
        author: '',
        path: path ?? '',
      })
      const paged = page(listed, first, after)
      return { ...paged, nodes: paged.nodes.map((at) => commitNode(ctx, repos, at)) }
    },
  }
}

/**
 * One pull request as GraphQL's `PullRequest` reports it, for every field
 * `gh pr view --json` and `gh pr list --json` read. The comments come from
 * the caller, since issues own them; `repository` is the GraphQL node of the
 * repository the pull request lives in, which is also its head's, as the fake
 * opens every pull request between two of one repository's branches.
 */
export async function pullRequestNode(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  row: PullRow,
  repository: Record<string, unknown>,
  nodeOf: (other: RepoRow) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const home = await headRepoOf(ctx, repo, row)
  const cross = home !== null && home.seq !== repo.seq
  const headOwner = home?.owner ?? repo.owner
  const state = row.merged ? 'MERGED' : row.state === 'closed' ? 'CLOSED' : 'OPEN'
  const open = state === 'OPEN'
  // Read once, and only by a query that asks for a field that needs it.
  let loaded: Promise<PullState> | undefined
  const now = (): Promise<PullState> => (loaded ??= pullState(ctx, repo, row))
  const changes = async (): Promise<FileChange[]> => (await now()).range.changes
  const reviews = await reviewRows(ctx, repo, row.number)
  const latest = new Map<string, ReviewRow>()
  for (const review of reviews) if (review.user !== row.user) latest.set(review.user, review)
  const referenced = closedNumbers(row.body)
  const closing = (
    await ctx.db.githubIssue.findMany({
      where: { ...scope(ctx.tenant), repo: repo.fullName, number: { in: referenced } },
      orderBy: { seq: 'asc' },
    })
  ).map((issue) => ({
    id: issueNodeId(repo.seq, issue.number),
    number: issue.number,
    url: `https://github.com/${repo.fullName}/issues/${String(issue.number)}`,
    repository,
  }))
  return {
    id: pullNodeId(repo.seq, row.number),
    fullDatabaseId: String(3_000_000 + repo.seq * 1000 + row.number),
    number: row.number,
    title: row.title,
    body: row.body,
    state,
    closed: !open,
    url: `https://github.com/${repo.fullName}/pull/${String(row.number)}`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: open ? null : row.merged ? MERGED_AT : row.updatedAt,
    mergedAt: row.merged ? MERGED_AT : null,
    baseRefName: row.base,
    baseRefOid: async () => (await now()).base,
    headRefName: headBranch(row),
    headRefOid: async () => (await now()).head,
    isDraft: row.draft,
    isCrossRepository: cross,
    maintainerCanModify: false,
    mergeable: open ? 'MERGEABLE' : 'UNKNOWN',
    mergeStateStatus: !open ? 'UNKNOWN' : row.draft ? 'DRAFT' : 'CLEAN',
    reviewDecision: null,
    additions: async () => (await changes()).reduce((n, c) => n + c.additions, 0),
    deletions: async () => (await changes()).reduce((n, c) => n + c.deletions, 0),
    changedFiles: async () => (await changes()).length,
    author: userNode(row.user),
    mergedBy: row.merged ? userNode(DEFAULT_LOGIN) : null,
    repository,
    headRepository: home === null ? null : cross ? await nodeOf(home) : repository,
    headRepositoryOwner: {
      __typename: headOwner === DEFAULT_LOGIN ? 'User' : 'Organization',
      ...ownerNode(headOwner),
      name: headOwner === DEFAULT_LOGIN ? headOwner : null,
    },
    autoMergeRequest: null,
    mergeCommit: row.merged ? { oid: commitSha('merge') } : null,
    potentialMergeCommit: open ? { oid: commitSha(`merge:${String(row.number)}`) } : null,
    milestone: null,
    assignees: ({ first, after }: PageArgs) => page([], first, after),
    labels: ({ first, after }: PageArgs) => page([], first, after),
    reactionGroups: reactionGroups(),
    reviews: ({ first, after }: PageArgs) =>
      page(
        reviews.map((review) => reviewNode(repo, row.number, review)),
        first,
        after,
      ),
    latestReviews: ({ first, after }: PageArgs) =>
      page(
        [...latest.values()].map((review) => reviewNode(repo, row.number, review)),
        first,
        after,
      ),
    reviewRequests: ({ first, after }: PageArgs) =>
      page(
        (JSON.parse(row.reviewersJson) as string[]).map((login) => ({
          requestedReviewer: userNode(login),
        })),
        first,
        after,
      ),
    files: async ({ first, after }: PageArgs) =>
      page(
        (await changes()).map((c) => ({
          path: c.filename,
          additions: c.additions,
          deletions: c.deletions,
          changeType: changeType(c),
        })),
        first,
        after,
      ),
    // Oldest first, as GitHub lists them; `last` is the newest few, which is
    // how `gh pr checks` reaches the head commit's rollup. The page starts
    // where those few do, so its cursors count from the oldest commit.
    commits: async ({ first, last, after }: PageArgs & { last?: number | null }) => {
      const nodes = [...(await now()).range.ahead]
        .reverse()
        .map((commit) => ({ commit: commitNode(ctx, cross ? [repo, home] : [repo], commit) }))
      if (typeof last !== 'number') return page(nodes, first, after)
      const from = after ? Number(Buffer.from(after, 'base64').toString()) : 0
      const start = Math.max(from, nodes.length - last)
      return page(nodes, last, Buffer.from(String(start)).toString('base64'))
    },
    closingIssuesReferences: ({ first, after }: PageArgs) => page(closing, first, after),
    projectCards: () => {
      throw new Error(PROJECTS_CLASSIC_GONE)
    },
    projectItems: ({ first, after }: PageArgs) => page([], first, after),
  }
}

export interface PullRequestsArgs extends PageArgs {
  states?: string[] | null
  baseRefName?: string | null
  headRefName?: string | null
}

/**
 * The pull requests GraphQL's `pullRequests` lists: narrowed by state and by
 * base and head branch, newest first, a page at a time. `nodes` turns each row
 * into its node, which the caller composes with what it owns.
 */
export async function pullRequestConnection(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  args: PullRequestsArgs,
  nodes: (row: PullRow) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const rows = (await ctx.db.githubPull.findMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName },
    orderBy: { seq: 'desc' },
  })) as PullRow[]
  const states = args.states ?? ['OPEN', 'CLOSED', 'MERGED']
  const kept = rows.filter((row) => {
    const state = row.merged ? 'MERGED' : row.state === 'closed' ? 'CLOSED' : 'OPEN'
    if (!states.includes(state)) return false
    if (args.baseRefName && row.base !== args.baseRefName) return false
    return !args.headRefName || headBranch(row) === args.headRefName
  })
  const connection = page(kept, args.first ?? 0, args.after)
  return { ...connection, nodes: await Promise.all(connection.nodes.map(nodes)) }
}

export function pullRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    route<C>('GET', `${p}/repos/:owner/:repo/pulls`, authedRoute(withRepo(listPulls))),
    route<C>('POST', `${p}/repos/:owner/:repo/pulls`, authedRoute(withRepo(createPull)), {
      write: true,
    }),
    route<C>('GET', `${p}/repos/:owner/:repo/pulls/:number`, authedRoute(withRepo(getPull))),
    route<C>('PATCH', `${p}/repos/:owner/:repo/pulls/:number`, authedRoute(withRepo(editPull)), {
      write: true,
    }),
    route<C>(
      'PUT',
      `${p}/repos/:owner/:repo/pulls/:number/merge`,
      authedRoute(withRepo(mergePull)),
      {
        write: true,
      },
    ),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/pulls/:number/files`,
      authedRoute(withRepo(listPullFiles)),
    ),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/pulls/:number/commits`,
      authedRoute(withRepo(listPullCommits)),
    ),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/pulls/:number/comments`,
      authedRoute(withRepo(listReviewComments)),
    ),
    route<C>(
      'POST',
      `${p}/repos/:owner/:repo/pulls/:number/comments`,
      authedRoute(withRepo(createReviewComment)),
      { write: true },
    ),
    route<C>(
      'POST',
      `${p}/repos/:owner/:repo/pulls/:number/comments/:comment/replies`,
      authedRoute(withRepo(createReviewComment)),
      { write: true },
    ),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/pulls/:number/reviews`,
      authedRoute(withRepo(listReviews)),
    ),
    route<C>(
      'POST',
      `${p}/repos/:owner/:repo/pulls/:number/reviews`,
      authedRoute(withRepo(createReview)),
      { write: true },
    ),
    route<C>(
      'POST',
      `${p}/repos/:owner/:repo/pulls/:number/requested_reviewers`,
      authedRoute(withRepo(requestReviewers)),
      { write: true },
    ),
  ])
}
