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
import { API_PREFIXES, DEFAULT_LOGIN, REPO_DATE, WRITE_COMMIT_DATE } from './config.ts'
import type { C } from './config.ts'
import { issueJson } from './issues.ts'
import type { IssueRow } from './issues.ts'
import { pullJson } from './pulls.ts'
import type { PullRow } from './pulls.ts'
import { releaseJson } from './releases.ts'
import type { ReleaseRow } from './releases.ts'
import { accountId, simpleUser } from './repos.ts'
import {
  accountOf,
  accountsOf,
  branchCommits,
  branchNames,
  loginsOf,
  metaOf,
  peeled,
  repoIsEmpty,
  repoLanguages,
  scope,
  tagRefs,
} from './store.ts'
import type { RepoRow } from './store.ts'
import { commitIdentity } from './wire.ts'
import type { CommitRow } from './wire.ts'
import { everywhere, pagedReply, route, authedRoute, withRepo } from './http.ts'

// `{language: bytes}`, largest first, as GitHub answers it.
async function languages(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  return {
    status: 200,
    body: Object.fromEntries(await repoLanguages(ctx.db, ctx.tenant, repo)),
  }
}

// The accounts a fixture lists for `stargazers` or `subscribers`, a page at a
// time, each as GitHub lists a user.
function listed(key: string) {
  return async (ctx: Ctx<C>, repo: RepoRow): Promise<Reply> => {
    const users: JsonValue[] = []
    for (const login of loginsOf(repo, key)) {
      users.push(simpleUser(await accountOf(ctx.db, ctx.tenant, login)))
    }
    return pagedReply(ctx, users)
  }
}

// Whoever wrote the default branch's commits, most commits first. A commit
// whose email is no account's is anonymous, and is listed only when `anon`
// asks for it, as GitHub's list does; an empty repository answers 204.
async function contributors(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  if (await repoIsEmpty(ctx.db, ctx.tenant, repo)) return { status: 204 }
  const logins = new Set(
    (await accountsOf(ctx.db, ctx.tenant)).map((account) => account.login.toLowerCase()),
  )
  const known = new Map<string, number>()
  const anonymous = new Map<string, { name: string; count: number }>()
  for (const row of await branchCommits(ctx.db, ctx.tenant, repo, repo.defaultBranch)) {
    const who = commitIdentity(row)
    if (logins.has(who.login.toLowerCase())) {
      known.set(who.login, (known.get(who.login) ?? 0) + 1)
    } else {
      const was = anonymous.get(who.email)
      anonymous.set(who.email, { name: who.name, count: (was?.count ?? 0) + 1 })
    }
  }
  const byCount = <T>(rows: Array<[string, T]>, count: (v: T) => number): Array<[string, T]> =>
    rows.sort(([a, x], [b, y]) => count(y) - count(x) || (a < b ? -1 : 1))
  const out: JsonValue[] = []
  for (const [login, count] of byCount([...known], (n) => n)) {
    const account = await accountOf(ctx.db, ctx.tenant, login)
    out.push({ ...simpleUser(account), contributions: count })
  }
  const anon = ctx.query.get('anon')
  if (anon === '1' || anon === 'true') {
    for (const [email, who] of byCount([...anonymous], (v) => v.count)) {
      out.push({ email, name: who.name, type: 'Anonymous', contributions: who.count })
    }
  }
  return pagedReply(ctx, out)
}

interface Event {
  type: string
  actor: string
  at: string
  payload: JsonValue
}

// A repository's activity, newest first, derived from what the fake holds, as
// GitHub records it: a push for each commit a branch received, a branch or
// tag created, an issue or a pull request opened and closed, a comment made
// and a release published. The dates are the ones those rows carry; equal
// ones keep the order the activity happened in, newest first.
async function events(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const where = { ...scope(ctx.tenant), repo: repo.fullName }
  const out: Event[] = []
  const pushed = new Set<string>()
  const branches = await branchNames(ctx.db, ctx.tenant, repo)
  for (const branch of branches) {
    const history = await branchCommits(ctx.db, ctx.tenant, repo, branch)
    if (branch !== repo.defaultBranch) {
      out.push({
        type: 'CreateEvent',
        actor: DEFAULT_LOGIN,
        at: history[0] === undefined ? REPO_DATE : commitIdentity(history[0]).committed,
        payload: createPayload(repo, branch, 'branch'),
      })
    }
    for (const row of [...history].reverse()) {
      if (row.treeSha === '' || pushed.has(row.sha)) continue
      pushed.add(row.sha)
      out.push(pushEvent(repo, branch, row))
    }
  }
  for (const tag of await tagRefs(ctx.db, ctx.tenant, repo)) {
    const sha = await peeled(ctx.db, ctx.tenant, repo, tag.sha)
    const commit = (await branchCommits(ctx.db, ctx.tenant, repo, repo.defaultBranch)).find(
      (row) => row.sha === sha,
    )
    out.push({
      type: 'CreateEvent',
      actor: DEFAULT_LOGIN,
      at: commit === undefined ? WRITE_COMMIT_DATE : commitIdentity(commit).committed,
      payload: createPayload(repo, tag.name, 'tag'),
    })
  }
  const issues = (await ctx.db.githubIssue.findMany({
    where,
    orderBy: { seq: 'asc' },
  })) as IssueRow[]
  for (const row of issues) {
    const issue = issueJson(repo, row)
    out.push({
      type: 'IssuesEvent',
      actor: row.user,
      at: row.createdAt,
      payload: { action: 'opened', issue },
    })
    if (row.state === 'closed') {
      out.push({
        type: 'IssuesEvent',
        actor: DEFAULT_LOGIN,
        at: row.closedAt === '' ? row.updatedAt : row.closedAt,
        payload: { action: 'closed', issue },
      })
    }
  }
  const pulls = (await ctx.db.githubPull.findMany({ where, orderBy: { seq: 'asc' } })) as PullRow[]
  for (const row of pulls) {
    const pull = await pullJson(ctx, repo, row)
    const opened = { action: 'opened', number: row.number, pull_request: pull }
    out.push({ type: 'PullRequestEvent', actor: row.user, at: row.createdAt, payload: opened })
    if (row.state === 'closed') {
      out.push({
        type: 'PullRequestEvent',
        actor: DEFAULT_LOGIN,
        at: row.updatedAt,
        payload: { action: 'closed', number: row.number, pull_request: pull },
      })
    }
  }
  const comments = await ctx.db.githubComment.findMany({ where, orderBy: { seq: 'asc' } })
  for (const row of comments) {
    out.push({
      type: 'IssueCommentEvent',
      actor: row.user,
      at: row.createdAt,
      payload: {
        action: 'created',
        issue: { number: row.issueNumber },
        comment: {
          id: row.id,
          body: row.body,
          user: { login: row.user },
          created_at: row.createdAt,
        },
      },
    })
  }
  const releases = (await ctx.db.githubRelease.findMany({
    where,
    orderBy: { seq: 'asc' },
  })) as ReleaseRow[]
  for (const row of releases) {
    if (row.draft) continue
    out.push({
      type: 'ReleaseEvent',
      actor: DEFAULT_LOGIN,
      at: row.createdAt,
      payload: { action: 'published', release: releaseJson(repo, row) },
    })
  }
  const newest = out
    .map((event, order) => ({ event, order }))
    .sort((a, b) =>
      a.event.at < b.event.at ? 1 : a.event.at > b.event.at ? -1 : b.order - a.order,
    )
  const repoId = typeof metaOf(repo).id === 'number' ? metaOf(repo).id : repo.seq
  return pagedReply(
    ctx,
    newest.map(({ event, order }) => ({
      id: String(40_000_000_000 + repo.seq * 100_000 + order),
      type: event.type,
      actor: {
        id: accountId(event.actor),
        login: event.actor,
        display_login: event.actor,
        gravatar_id: '',
        url: `https://api.github.com/users/${event.actor}`,
        avatar_url: `https://avatars.githubusercontent.com/u/${String(accountId(event.actor))}?`,
      },
      repo: {
        id: repoId ?? repo.seq,
        name: repo.fullName,
        url: `https://api.github.com/repos/${repo.fullName}`,
      },
      payload: event.payload,
      public: metaOf(repo).private !== true,
      created_at: event.at,
    })),
  )
}

function createPayload(repo: RepoRow, ref: string, kind: string): JsonValue {
  const description = metaOf(repo).description
  return {
    ref,
    ref_type: kind,
    master_branch: repo.defaultBranch,
    description: typeof description === 'string' ? description : null,
    pusher_type: 'user',
  }
}

function pushEvent(repo: RepoRow, branch: string, row: CommitRow): Event {
  const who = commitIdentity(row)
  return {
    type: 'PushEvent',
    actor: DEFAULT_LOGIN,
    at: who.committed,
    payload: {
      repository_id: repo.seq,
      push_id: row.seq,
      size: 1,
      distinct_size: 1,
      ref: `refs/heads/${branch}`,
      head: row.sha,
      before: row.parentSha,
      commits: [
        {
          sha: row.sha,
          author: { email: who.email, name: who.name },
          message: row.message,
          distinct: true,
          url: `https://api.github.com/repos/${repo.fullName}/commits/${row.sha}`,
        },
      ],
    },
  }
}

// The limits an authenticated caller is given, and an anonymous one's, which
// GitHub answers without a token too. Nothing here is ever spent, and the
// reset is an hour past the fake's pinned stamp.
function rateLimit(ctx: Ctx<C>): Reply {
  const signed = (ctx.headers.authorization ?? '') !== ''
  const reset = Date.parse(WRITE_COMMIT_DATE) / 1000 + 3600
  const limit = (resource: string, allowed: number): JsonValue => ({
    limit: allowed,
    used: 0,
    remaining: allowed,
    reset,
    resource,
  })
  const core = limit('core', signed ? 5000 : 60)
  return {
    status: 200,
    body: {
      resources: {
        core,
        search: limit('search', signed ? 30 : 10),
        graphql: limit('graphql', signed ? 5000 : 0),
        code_search: limit('code_search', signed ? 10 : 0),
        integration_manifest: limit('integration_manifest', 5000),
      },
      rate: core,
    },
  }
}

export function insightRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    route<C>('GET', `${p}/rate_limit`, rateLimit),
    route<C>('GET', `${p}/repos/:owner/:repo/languages`, authedRoute(withRepo(languages))),
    route<C>('GET', `${p}/repos/:owner/:repo/contributors`, authedRoute(withRepo(contributors))),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/stargazers`,
      authedRoute(withRepo(listed('stargazers'))),
    ),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/subscribers`,
      authedRoute(withRepo(listed('subscribers'))),
    ),
    route<C>('GET', `${p}/repos/:owner/:repo/events`, authedRoute(withRepo(events))),
  ])
}
