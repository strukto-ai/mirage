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

import type { JsonValue, KitRoute } from '../kit/typescript/index.ts'
import { API_PREFIXES, DEFAULT_LOGIN, REPO_DATE } from './config.ts'
import type { C } from './config.ts'
import { commitHistory } from './compare.ts'
import { PROJECTS_CLASSIC_GONE, nodeId, ownerNode, rootCommit } from './wire.ts'
import { createReposAllowed, initRepo } from './seed.ts'
import { commentConnection, issueConnection, issueNode, issueRow } from './issues.ts'
import type { IssueRow, IssuesArgs } from './issues.ts'
import { commitNode, pullRequestConnection, pullRequestNode, pullRow } from './pulls.ts'
import type { PullRequestsArgs, PullRow } from './pulls.ts'
import {
  accountsOf,
  addBranch,
  headOf,
  loginsOf,
  networkNames,
  primaryLanguage,
  repoJson,
  repoLanguages,
  starsOf,
  allRepos,
  delegateFor,
  perRepoModels,
  branchNames,
  commitList,
  commitsBySha,
  commitsJson,
  metaOf,
  repoByName,
  repoIsEmpty,
  resolveRef,
  scope,
  tagObject,
  tagRefs,
  treeOfBranch,
} from './store.ts'
import type { AccountRow, RepoRow } from './store.ts'
import {
  authedRoute as authed,
  everywhere,
  fail,
  jsonBodyOf,
  paged,
  pagedReply,
  param,
  route,
  str,
  withRepo,
} from './http.ts'
import type { Handler } from './http.ts'

// An account's id, from its login alone so it is the same on every run:
// FNV-1a, which spreads the bytes and protects nothing, as an id needs.
export function accountId(login: string): number {
  let hash = 0x811c9dc5
  for (const byte of Buffer.from(login)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return hash & 0x7fffffff
}

/**
 * One account as `/users/{login}` reports it. `public_repos` counts the
 * repositories the account owns here.
 */
export function accountJson(account: AccountRow, repos: RepoRow[]): JsonValue {
  const login = account.login
  const api = `https://api.github.com/users/${login}`
  const text = (value: string): string | null => (value === '' ? null : value)
  return {
    login,
    id: accountId(login),
    node_id: nodeId(account.type === 'User' ? '04:User' : '012:Organization', login),
    avatar_url: `https://avatars.githubusercontent.com/u/${String(accountId(login))}?v=4`,
    gravatar_id: '',
    url: api,
    html_url: `https://github.com/${login}`,
    followers_url: `${api}/followers`,
    following_url: `${api}/following{/other_user}`,
    gists_url: `${api}/gists{/gist_id}`,
    starred_url: `${api}/starred{/owner}{/repo}`,
    subscriptions_url: `${api}/subscriptions`,
    organizations_url: `${api}/orgs`,
    repos_url: `${api}/repos`,
    events_url: `${api}/events{/privacy}`,
    received_events_url: `${api}/received_events`,
    type: account.type,
    user_view_type: 'public',
    site_admin: false,
    name: text(account.name),
    company: text(account.company),
    blog: account.blog,
    location: text(account.location),
    email: text(account.email),
    hireable: account.hireable ? true : null,
    bio: text(account.bio),
    twitter_username: text(account.twitterUsername),
    public_repos: repos.filter((repo) => repo.owner.toLowerCase() === login.toLowerCase()).length,
    public_gists: account.publicGists,
    followers: account.followers,
    following: account.following,
    created_at: account.createdAt,
    updated_at: account.updatedAt === '' ? account.createdAt : account.updatedAt,
  }
}

// The fields GitHub lists a user by wherever it lists several: a search, the
// stargazers, the contributors.
const SIMPLE_USER = [
  'login',
  'id',
  'node_id',
  'avatar_url',
  'gravatar_id',
  'url',
  'html_url',
  'followers_url',
  'following_url',
  'gists_url',
  'starred_url',
  'subscriptions_url',
  'organizations_url',
  'repos_url',
  'events_url',
  'received_events_url',
  'type',
  'user_view_type',
  'site_admin',
]

export function simpleUser(account: AccountRow): Record<string, JsonValue> {
  const full = accountJson(account, []) as Record<string, JsonValue>
  return Object.fromEntries(SIMPLE_USER.map((key) => [key, full[key] ?? null]))
}

/** One of a repository's dates, its fixture's or the fresh-repository default. */
export function repoDate(repo: RepoRow, key: string): string {
  const value = metaOf(repo)[key]
  return typeof value === 'string' ? value : REPO_DATE
}

const HEADS = 'refs/heads/'
const TAGS = 'refs/tags/'

/**
 * The object a sha names as GraphQL's `GitObject`: an annotated tag as a `Tag`
 * over what it points at, a tree or blob by its id alone, and anything else as
 * the commit it is.
 */
async function objectNode(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  sha: string,
  type = 'commit',
): Promise<Record<string, unknown>> {
  if (type === 'tree' || type === 'blob')
    return { __typename: type === 'tree' ? 'Tree' : 'Blob', oid: sha }
  const tag = await tagObject(ctx.db, ctx.tenant, repo, sha)
  if (tag !== null)
    return {
      __typename: 'Tag',
      oid: sha,
      name: tag.tag,
      message: tag.message,
      target: () => objectNode(ctx, repo, tag.objectSha, tag.objectType),
    }
  const byId = await commitsBySha(ctx.db, ctx.tenant, repo)
  return commitNode(ctx, [repo], byId.get(sha) ?? rootCommit(sha))
}

/**
 * A ref as GraphQL's `Ref` reads it: its short name, the namespace it lives in
 * and what it points at, a branch's head commit, or null for a branch nothing
 * has been committed to.
 */
function refNode(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  prefix: string,
  name: string,
): Record<string, unknown> {
  return {
    name,
    prefix,
    target: async () => {
      if (prefix === TAGS) {
        const tag = (await tagRefs(ctx.db, ctx.tenant, repo)).find((row) => row.name === name)
        return tag === undefined ? null : await objectNode(ctx, repo, tag.sha)
      }
      const [head] = await commitList(ctx.db, ctx.tenant, repo, name)
      return head === undefined ? null : commitNode(ctx, [repo], head)
    },
  }
}

// `ref(qualifiedName:)`: a fully qualified name in its own namespace, and a
// short one as a branch, then as a tag. A partial prefix such as
// `heads/main` names nothing, and neither does a name no ref has (both
// measured against GitHub, 2026-10-03).
async function namedRef(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  qualifiedName: string,
): Promise<Record<string, unknown> | null> {
  const branches = await branchNames(ctx.db, ctx.tenant, repo)
  const tags = (await tagRefs(ctx.db, ctx.tenant, repo)).map((row) => row.name)
  const tries: [string, string][] = qualifiedName.startsWith(HEADS)
    ? [[HEADS, qualifiedName.slice(HEADS.length)]]
    : qualifiedName.startsWith(TAGS)
      ? [[TAGS, qualifiedName.slice(TAGS.length)]]
      : [
          [HEADS, qualifiedName],
          [TAGS, qualifiedName],
        ]
  for (const [prefix, name] of tries) {
    if ((prefix === HEADS ? branches : tags).includes(name)) return refNode(ctx, repo, prefix, name)
  }
  return null
}

/**
 * The GraphQL `Repository` for one row: the same facts the REST object reports,
 * in GraphQL's spelling, plus what GraphQL alone exposes. A fixture's
 * `metaJson` overrides the fresh-repository defaults field by field, under the
 * REST names both views share (`description`, `stargazers_count`, `topics`,
 * `language`, `private`), so one fixture answers both.
 *
 * Counts and the latest release are read off the fake's own rows, open issues
 * and pull requests counted apart the way GraphQL counts them. `projects`
 * refuses the way the vendor now refuses Projects (classic), and a fork names
 * the repository it was forked from as `parent`.
 */
export async function repositoryNode(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
): Promise<Record<string, unknown>> {
  const meta = metaOf(repo)
  const text = (key: string): string | null =>
    typeof meta[key] === 'string' ? (meta[key] as string) : null
  const count = (key: string): number => (typeof meta[key] === 'number' ? (meta[key] as number) : 0)
  const email = `${DEFAULT_LOGIN}@users.noreply.github.com`
  const where = { ...scope(ctx.tenant), repo: repo.fullName }
  const topics = Array.isArray(meta.topics) ? meta.topics.map(String) : []
  const owned = repo.owner === DEFAULT_LOGIN
  const user = { id: nodeId('04:User', DEFAULT_LOGIN), login: DEFAULT_LOGIN, name: DEFAULT_LOGIN }
  // A fork records its source by seq, the identity a rename keeps, so the
  // parent is found under whatever name it carries now.
  const parentSeq = typeof meta.parent_seq === 'number' ? meta.parent_seq : null
  const parent = async (): Promise<Record<string, unknown> | null> => {
    if (parentSeq === null) return null
    const row = (await allRepos(ctx.db, ctx.tenant)).find((each) => each.seq === parentSeq)
    return row === undefined ? null : repositoryNode(ctx, row)
  }
  const node: Record<string, unknown> = {
    id: nodeId('010:Repository', repo.seq),
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: ownerNode(repo.owner),
    parent,
    templateRepository: null,
    description: text('description'),
    homepageUrl: text('homepage'),
    openGraphImageUrl: `https://opengraph.githubassets.com/1/${repo.fullName}`,
    usesCustomOpenGraphImage: false,
    url: `https://github.com/${repo.fullName}`,
    sshUrl: `git@github.com:${repo.fullName}.git`,
    mirrorUrl: null,
    securityPolicyUrl: null,
    createdAt: repoDate(repo, 'created_at'),
    pushedAt: repoDate(repo, 'pushed_at'),
    updatedAt: repoDate(repo, 'updated_at'),
    archivedAt: meta.archived === true ? repoDate(repo, 'updated_at') : null,
    isBlankIssuesEnabled: true,
    isSecurityPolicyEnabled: false,
    hasIssuesEnabled: meta.has_issues !== false,
    hasProjectsEnabled: meta.has_projects !== false,
    hasDiscussionsEnabled: meta.has_discussions === true,
    hasWikiEnabled: meta.has_wiki !== false,
    mergeCommitAllowed: meta.allow_merge_commit !== false,
    squashMergeAllowed: meta.allow_squash_merge !== false,
    rebaseMergeAllowed: meta.allow_rebase_merge !== false,
    forkCount: count('forks_count'),
    stargazerCount: starsOf(repo),
    watchers: { totalCount: loginsOf(repo, 'subscribers').length },
    codeOfConduct: null,
    contactLinks: [],
    defaultBranchRef: refNode(ctx, repo, HEADS, repo.defaultBranch),
    ref: ({ qualifiedName }: { qualifiedName: string }) => namedRef(ctx, repo, qualifiedName),
    deleteBranchOnMerge: meta.delete_branch_on_merge === true,
    diskUsage: 0,
    fundingLinks: [],
    isArchived: meta.archived === true,
    isEmpty: false,
    isFork: meta.fork === true,
    isInOrganization: !owned,
    isMirror: false,
    isPrivate: meta.private === true,
    isTemplate: meta.is_template === true,
    isUserConfigurationRepository: repo.name === repo.owner,
    licenseInfo: null,
    viewerCanAdminister: true,
    viewerDefaultCommitEmail: email,
    viewerDefaultMergeMethod: 'MERGE',
    viewerHasStarred: false,
    viewerPermission: 'ADMIN',
    viewerPossibleCommitEmails: [email],
    viewerSubscription: owned ? 'SUBSCRIBED' : 'UNSUBSCRIBED',
    visibility:
      typeof meta.visibility === 'string'
        ? meta.visibility.toUpperCase()
        : meta.private === true
          ? 'PRIVATE'
          : 'PUBLIC',
    repositoryTopics: { nodes: topics.map((name) => ({ topic: { name } })) },
    primaryLanguage: async () => {
      const name = await primaryLanguage(ctx.db, ctx.tenant, repo)
      return name === null ? null : { name }
    },
    languages: async ({ first }: { first?: number | null }) => ({
      edges: (await repoLanguages(ctx.db, ctx.tenant, repo))
        .slice(0, first ?? 100)
        .map(([name, size]) => ({ size, node: { name } })),
    }),
    issueTemplates: [],
    pullRequestTemplates: [],
    labels: { nodes: [] },
    milestones: { nodes: [] },
    latestRelease: async () => {
      const rows = await ctx.db.githubRelease.findMany({ where, orderBy: { seq: 'desc' } })
      const row = rows.find((release) => !release.draft && !release.prerelease)
      if (row === undefined) return null
      return {
        name: row.name,
        tagName: row.tagName,
        url: `https://github.com/${repo.fullName}/releases/tag/${row.tagName}`,
        publishedAt: row.createdAt,
      }
    },
    assignableUsers: { nodes: [user] },
    mentionableUsers: { nodes: [user] },
    projects: () => {
      throw new Error(PROJECTS_CLASSIC_GONE)
    },
    projectsV2: { nodes: [] },
  }
  // Issues own the comments on a pull request as on an issue.
  const pull = async (row: PullRow): Promise<Record<string, unknown>> => ({
    ...(await pullRequestNode(ctx, repo, row, node, (other) => repositoryNode(ctx, other))),
    __typename: 'PullRequest',
    comments: commentConnection(ctx, repo, row.number),
  })
  const issue = (row: IssueRow): Promise<Record<string, unknown>> => issueNode(ctx, repo, row, node)
  return Object.assign(node, {
    issueOrPullRequest: async ({ number }: { number: number }) => {
      const found = await issueRow(ctx.db, ctx.tenant, repo, number)
      if (found !== null) return issue(found)
      const row = await pullRow(ctx.db, ctx.tenant, repo, number)
      if (row !== null) return pull(row)
      throw new Error(
        `Could not resolve to an issue or pull request with the number of ${String(number)}.`,
      )
    },
    issue: async ({ number }: { number: number }) => {
      const found = await issueRow(ctx.db, ctx.tenant, repo, number)
      if (found === null) {
        throw new Error(`Could not resolve to an Issue with the number of ${String(number)}.`)
      }
      return issue(found)
    },
    issues: (args: IssuesArgs) => issueConnection(ctx, repo, args, issue),
    pullRequest: async ({ number }: { number: number }) => {
      const row = await pullRow(ctx.db, ctx.tenant, repo, number)
      if (row === null) {
        throw new Error(`Could not resolve to a PullRequest with the number of ${String(number)}.`)
      }
      return pull(row)
    },
    pullRequests: (args: PullRequestsArgs) => pullRequestConnection(ctx, repo, args, pull),
  })
}

/** The value a GraphQL `RepositoryOrder` field sorts one repository by. */
function orderKey(repo: RepoRow, field: string): string | number {
  const meta = metaOf(repo)
  if (field === 'NAME') return repo.name
  if (field === 'STARGAZERS') {
    return typeof meta.stargazers_count === 'number' ? meta.stargazers_count : 0
  }
  if (field === 'CREATED_AT') return repoDate(repo, 'created_at')
  if (field === 'UPDATED_AT') return repoDate(repo, 'updated_at')
  return repoDate(repo, 'pushed_at')
}

interface RepositoriesArgs {
  first: number
  after?: string | null
  privacy?: string | null
  isFork?: boolean | null
  orderBy?: { field: string; direction: string } | null
}

/**
 * The repositories a GraphQL `RepositoryOwner` lists: the owner's own, narrowed
 * by `privacy` and `isFork`, in the `orderBy` asked for, a page at a time.
 * Repositories the order ties are listed by name, so a page is the same page
 * on every request.
 */
export async function ownedRepositories(
  ctx: { db: C; tenant: string },
  login: string,
): Promise<Record<string, unknown>> {
  const owned = (await allRepos(ctx.db, ctx.tenant)).filter((row) => row.owner === login)
  const user = login === DEFAULT_LOGIN
  return {
    __typename: user ? 'User' : 'Organization',
    ...ownerNode(login),
    ...(user ? { name: login } : {}),
    repositories: async ({ first, after, privacy, isFork, orderBy }: RepositoriesArgs) => {
      const rows = owned
        .filter((row) => {
          const meta = metaOf(row)
          if (privacy === 'PUBLIC' && meta.private === true) return false
          if (privacy === 'PRIVATE' && meta.private !== true) return false
          return isFork === null || isFork === undefined || (meta.fork === true) === isFork
        })
        .sort((a, b) => {
          const field = orderBy?.field ?? 'NAME'
          const [x, y] = [orderKey(a, field), orderKey(b, field)]
          const order = x < y ? -1 : x > y ? 1 : 0
          if (order !== 0) return orderBy?.direction === 'DESC' ? -order : order
          return a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0
        })
      const start = after ? Number(Buffer.from(after, 'base64').toString()) : 0
      const page = rows.slice(start, start + first)
      const end = start + page.length
      return {
        nodes: page.map((row) => repositoryNode(ctx, row)),
        totalCount: rows.length,
        pageInfo: {
          hasNextPage: end < rows.length,
          endCursor: page.length > 0 ? Buffer.from(String(end)).toString('base64') : null,
        },
      }
    },
  }
}

async function branchJson(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  branch: string,
): Promise<JsonValue> {
  const list = await commitList(ctx.db, ctx.tenant, repo, branch)
  return { name: branch, commit: { sha: list[0]?.sha ?? '' } }
}

async function nextRepoSeq(db: C, tenant: string): Promise<number> {
  const rows = await allRepos(db, tenant)
  return rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.seq)) + 1
}

export function repoRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    route<C>(
      'GET',
      `${p}/user`,
      authed(() => ({
        status: 200,
        body: { login: DEFAULT_LOGIN, name: DEFAULT_LOGIN, type: 'User' },
      })),
    ),
    // One account, by login in any case, the way GitHub reads one.
    route<C>(
      'GET',
      `${p}/users/:owner`,
      authed(async (ctx) => {
        const login = param(ctx, 'owner').toLowerCase()
        const found = (await accountsOf(ctx.db, ctx.tenant)).find(
          (account) => account.login.toLowerCase() === login,
        )
        if (found === undefined) return fail(404, 'Not Found')
        const repos = await allRepos(ctx.db, ctx.tenant)
        return { status: 200, body: accountJson(found, repos) }
      }),
    ),
    // The API root, so a client probing it gets "this is a GitHub API" rather
    // than a 404, which reads as the host not being there at all.
    // The python fake registers the root as "/" bare and as "/api/v3/" with a
    // trailing slash, and the kit router matches a path exactly, so the two
    // spellings are not interchangeable.
    // The URL map is built from the bare origin at BOTH spellings: the python
    // fake answers its own base URL, which never carried the Enterprise prefix,
    // and a template that suddenly gained one would send a client somewhere it
    // was not sent before.
    route<C>('GET', p === '' ? '/' : `${p}/`, (ctx) => {
      const host = ctx.headers.host ?? '127.0.0.1'
      // Every url in this map is one the client is expected to follow, so the
      // run rides them too. This is the API root: a scoped client that starts
      // here and follows current_user_repositories_url would otherwise walk
      // straight into the default run and read another world's repositories.
      // runPrefix is '' for an unscoped request, so the map is unchanged for
      // one, which is what the Enterprise-prefix note below is about.
      const base = `http://${String(host)}${ctx.runPrefix}`
      return {
        status: 200,
        body: {
          current_user_url: `${base}/user`,
          current_user_repositories_url: `${base}/user/repos`,
          user_url: `${base}/users/{user}`,
          repository_url: `${base}/repos/{owner}/{repo}`,
          repository_search_url: `${base}/search/repositories?q={query}`,
          code_search_url: `${base}/search/code?q={query}`,
        },
      }
    }),
    route<C>('GET', `${p}/user/repos`, authed(listRepos)),
    route<C>('GET', `${p}/users/:owner/repos`, authed(listRepos)),
    route<C>('GET', `${p}/orgs/:owner/repos`, authed(listRepos)),
    route<C>('POST', `${p}/user/repos`, authed(createRepo), { write: true }),
    route<C>('POST', `${p}/orgs/:owner/repos`, authed(createRepo), { write: true }),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo`,
      authed(withRepo(async (c, r) => ({ status: 200, body: await repoJson(c.db, c.tenant, r) }))),
    ),
    route<C>('PATCH', `${p}/repos/:owner/:repo`, authed(updateRepo), { write: true }),
    route<C>('GET', `${p}/repos/:owner/:repo/topics`, repoTopics),
    route<C>('PUT', `${p}/repos/:owner/:repo/topics`, setRepoTopics, { write: true }),
    route<C>('DELETE', `${p}/repos/:owner/:repo`, authed(deleteRepo), { write: true }),
    route<C>('POST', `${p}/repos/:owner/:repo/forks`, authed(forkRepo), { write: true }),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/branches`,
      authed(
        withRepo(async (ctx, repo) => {
          const names = await branchNames(ctx.db, ctx.tenant, repo)
          const out: JsonValue[] = []
          for (const b of names) out.push(await branchJson(ctx, repo, b))
          return { status: 200, body: out }
        }),
      ),
    ),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/branches/:branch`,
      authed(
        withRepo(async (ctx, repo) => {
          const name = param(ctx, 'branch')
          const names = await branchNames(ctx.db, ctx.tenant, repo)
          if (!names.includes(name)) return fail(404, 'Branch not found')
          return { status: 200, body: await branchJson(ctx, repo, name) }
        }),
      ),
    ),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/commits`,
      authed(
        // `sha` is "SHA or branch to start listing commits from", so a commit,
        // full or abbreviated, starts the list at itself. One that names
        // nothing is 404, measured against GitHub (2026-09-29); listing the
        // default branch instead answered a question nobody asked. The list
        // is every commit reachable through any parent, newest first, so a
        // merged branch's commits are on it; it is filtered, then paged the
        // way the repository list is.
        withRepo(async (ctx, repo) => {
          if (await repoIsEmpty(ctx.db, ctx.tenant, repo)) {
            return fail(409, 'Git Repository is empty.')
          }
          const at = await resolveRef(ctx.db, ctx.tenant, repo, ctx.query.get('sha') ?? '')
          if (at === null) return fail(404, 'Not Found')
          const head = at.history[0]
          if (head === undefined) return fail(409, 'Git Repository is empty.')
          const byId = await commitsBySha(ctx.db, ctx.tenant, repo)
          const page = paged(
            ctx,
            await commitHistory(ctx.db, ctx.tenant, repo, head.sha, byId, {
              since: ctx.query.get('since'),
              until: ctx.query.get('until'),
              author: ctx.query.get('author') ?? '',
              path: ctx.query.get('path') ?? '',
            }),
          )
          if (page === null) return fail(422, 'Validation Failed')
          const body = await commitsJson(ctx.db, ctx.tenant, repo, page.items)
          return { status: 200, body, headers: page.headers }
        }),
      ),
    ),
  ])
}

const listRepos: Handler = async (ctx) => {
  const owner = ctx.params.owner ?? DEFAULT_LOGIN
  const repos = await allRepos(ctx.db, ctx.tenant)
  const owned = repos
    .filter((r) => r.owner === owner)
    .sort((a, b) => (a.fullName < b.fullName ? -1 : 1))
  const items = await Promise.all(owned.map((r) => repoJson(ctx.db, ctx.tenant, r)))
  return pagedReply(ctx, items)
}

const createRepo: Handler = async (ctx) => {
  if (!(await createReposAllowed(ctx.db, ctx.tenant))) {
    return fail(403, 'Resource not accessible by personal access token')
  }
  const body = jsonBodyOf(ctx)
  const name = str(body, 'name').trim()
  if (name === '') return fail(422, 'Repository creation failed.')
  const owner = ctx.params.owner ?? DEFAULT_LOGIN
  const fullName = `${owner}/${name}`
  if ((await repoByName(ctx.db, ctx.tenant, fullName)) !== null) {
    return fail(422, 'Repository creation failed.')
  }
  const priv = body.private === true
  const meta: Record<string, JsonValue> = {
    description: body.description ?? null,
    homepage: body.homepage ?? null,
    private: priv,
    visibility: priv ? 'private' : 'public',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',
  }
  const created = (await ctx.db.githubRepo.create({
    data: {
      tenant: ctx.tenant,
      fullName,
      owner,
      name,
      defaultBranch: 'main',
      metaJson: JSON.stringify(meta),
      seq: await nextRepoSeq(ctx.db, ctx.tenant),
    },
  })) as RepoRow
  await initRepo(ctx.db, ctx.tenant, created)
  if (body.auto_init === true) {
    await ctx.db.githubFile.create({
      data: {
        tenant: ctx.tenant,
        repo: fullName,
        branch: 'main',
        path: 'README.md',
        data: new Uint8Array(Buffer.from(`# ${name}\n`, 'utf8')),
        seq: 0,
      },
    })
  }
  return { status: 201, body: await repoJson(ctx.db, ctx.tenant, created) }
}

// Validate every accepted field before writing metadata or moving repository
// keys. A malformed default_branch must not leave a successful rename behind.
const EDITABLE: Record<string, 'string' | 'nullable' | 'boolean' | 'object'> = {
  name: 'string',
  default_branch: 'string',
  description: 'nullable',
  homepage: 'nullable',
  private: 'boolean',
  visibility: 'string',
  is_template: 'boolean',
  has_issues: 'boolean',
  has_projects: 'boolean',
  has_wiki: 'boolean',
  has_discussions: 'boolean',
  allow_squash_merge: 'boolean',
  allow_merge_commit: 'boolean',
  allow_rebase_merge: 'boolean',
  allow_auto_merge: 'boolean',
  allow_update_branch: 'boolean',
  allow_forking: 'boolean',
  delete_branch_on_merge: 'boolean',
  use_squash_pr_title_as_default: 'boolean',
  web_commit_signoff_required: 'boolean',
  archived: 'boolean',
  squash_merge_commit_title: 'string',
  squash_merge_commit_message: 'string',
  merge_commit_title: 'string',
  merge_commit_message: 'string',
  security_and_analysis: 'object',
}

const VISIBILITIES = ['public', 'private', 'internal']

function editType(kind: string, value: JsonValue): string | null {
  if (kind === 'boolean') return typeof value === 'boolean' ? null : 'boolean'
  if (kind === 'object') {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? null : 'object'
  }
  if (typeof value === 'string' || (kind === 'nullable' && value === null)) return null
  return kind === 'nullable' ? 'string or null' : 'string'
}

// A rename has to carry the content with it rather than leave an empty
// repository behind under the new name, which is what a fork-then-rename does.
const updateRepo: Handler = authed(
  withRepo(async (ctx, repo) => {
    const body = jsonBodyOf(ctx)
    const edits: Record<string, JsonValue> = {}
    for (const [key, kind] of Object.entries(EDITABLE)) {
      const value = body[key]
      if (value === undefined) continue
      const wanted = editType(kind, value)
      if (wanted !== null) {
        return fail(
          422,
          `Invalid request.\n\nFor 'properties/${key}', ${JSON.stringify(value)} is not a ${wanted}.`,
        )
      }
      edits[key] = value
    }
    if (typeof edits.visibility === 'string') {
      if (!VISIBILITIES.includes(edits.visibility)) return fail(422, 'Validation Failed')
      edits.private = edits.visibility !== 'public'
    } else if (typeof edits.private === 'boolean') {
      edits.visibility = edits.private ? 'private' : 'public'
    }
    const name = str(edits, 'name').trim()
    const branch = str(edits, 'default_branch').trim()
    delete edits.name
    delete edits.default_branch
    let current = repo
    if (name !== '' && name !== repo.name) {
      const target = `${repo.owner}/${name}`
      if ((await repoByName(ctx.db, ctx.tenant, target)) !== null) {
        return fail(422, 'Repository creation failed.')
      }
      current = (await renameRepo(ctx.db, ctx.tenant, repo, name)) as RepoRow
    }
    const data: { defaultBranch?: string; metaJson?: string } = {}
    if (branch !== '') data.defaultBranch = branch
    if (Object.keys(edits).length > 0) {
      data.metaJson = JSON.stringify({ ...metaOf(current), ...edits })
    }
    if (Object.keys(data).length > 0) {
      current = (await ctx.db.githubRepo.update({
        where: { tenant_fullName: { tenant: ctx.tenant, fullName: current.fullName } },
        data,
      })) as RepoRow
    }
    return { status: 200, body: await repoJson(ctx.db, ctx.tenant, current) }
  }),
)

// The topics `gh repo edit --add-topic` reads and replaces whole: GitHub keeps
// them as one list, and `PUT` sets that list.
const repoTopics: Handler = authed(
  withRepo((_ctx, repo) => {
    const topics = metaOf(repo).topics
    return { status: 200, body: { names: Array.isArray(topics) ? topics : [] } }
  }),
)

const setRepoTopics: Handler = authed(
  withRepo(async (ctx, repo) => {
    const names = jsonBodyOf(ctx).names
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
      return fail(422, 'Invalid request.\n\n"names" wasn\'t supplied.')
    }
    await ctx.db.githubRepo.update({
      where: { tenant_fullName: { tenant: ctx.tenant, fullName: repo.fullName } },
      data: { metaJson: JSON.stringify({ ...metaOf(repo), topics: names }) },
    })
    return { status: 200, body: { names } }
  }),
)

// Every child row keys on the repository's full name, so a rename is a rename
// of that key everywhere, not just on the repository row.
async function renameRepo(db: C, tenant: string, repo: RepoRow, name: string): Promise<RepoRow> {
  const to = `${repo.owner}/${name}`
  const from = repo.fullName
  const created = (await db.githubRepo.create({
    data: {
      tenant,
      fullName: to,
      owner: repo.owner,
      name,
      defaultBranch: repo.defaultBranch,
      metaJson: repo.metaJson,
      truncated: repo.truncated,
      sourceDir: repo.sourceDir,
      sourceBranch: repo.sourceBranch,
      pagesJson: repo.pagesJson,
      seq: repo.seq,
    },
  })) as RepoRow
  // Derived from the schema, not listed here. Every relation to GithubRepo is
  // required and none cascades, so a table left behind is not a silent orphan,
  // it is a 500 on the delete below. That list went stale twice, once for
  // GithubStagedTree and once for GithubBranch, so it is no longer written
  // down: `perRepoModels` reads the DMMF, and a model added to the schema is
  // moved without anyone remembering to say so.
  for (const model of perRepoModels()) {
    await delegateFor(db, model).updateMany({ where: { tenant, repo: from }, data: { repo: to } })
  }
  await db.githubRepo.delete({ where: { tenant_fullName: { tenant, fullName: from } } })
  return created
}

const deleteRepo: Handler = authed(
  withRepo(async (ctx, repo) => {
    await dropRepo(ctx.db, ctx.tenant, repo)
    return { status: 204 }
  }),
)

// The objects a network shares move to the oldest surviving fork when the
// repository holding them is deleted, and that fork takes the deleted one's
// place as parent of the rest, as GitHub hands a network to a fork. Without
// it the forks kept heads naming commits and trees that no longer existed.
async function handOff(db: C, tenant: string, repo: RepoRow): Promise<void> {
  const network = await networkNames(db, tenant, repo)
  const rest = (await allRepos(db, tenant))
    .filter((r) => network.includes(r.fullName) && r.seq !== repo.seq)
    .sort((a, b) => a.seq - b.seq)
  const heir = rest[0]
  if (heir === undefined) return
  const moved = { tenant, repo: repo.fullName }
  await db.githubCommit.updateMany({ where: moved, data: { repo: heir.fullName } })
  await db.githubStagedTree.updateMany({ where: moved, data: { repo: heir.fullName } })
  await db.githubStagedEntry.updateMany({ where: moved, data: { repo: heir.fullName } })
  await db.githubStagedDir.updateMany({ where: moved, data: { repo: heir.fullName } })
  await db.githubTag.updateMany({ where: moved, data: { repo: heir.fullName } })
  await db.githubBlob.updateMany({ where: moved, data: { repo: heir.fullName } })
  const up = metaOf(repo).parent_seq
  for (const row of rest) {
    const meta = metaOf(row)
    if (meta.parent_seq !== repo.seq) continue
    const { parent_seq: _was, ...kept } = meta
    const next =
      row.seq === heir.seq
        ? typeof up === 'number'
          ? { ...kept, parent_seq: up }
          : kept
        : { ...kept, parent_seq: heir.seq }
    await db.githubRepo.updateMany({
      where: { tenant, fullName: row.fullName },
      data: { metaJson: JSON.stringify(next) },
    })
  }
}

async function dropRepo(db: C, tenant: string, repo: RepoRow): Promise<void> {
  await handOff(db, tenant, repo)
  const fullName = repo.fullName
  const where = { tenant, repo: fullName }
  // In dependency order, deepest first, for the same reason the kit's own
  // scoped reset derives its order rather than declaring one. A staged entry
  // and a staged directory carry their repository, so the walk reaches them
  // too, and never another repository's rows under the same tree sha.
  for (const model of perRepoModels()) {
    await delegateFor(db, model).deleteMany({ where })
  }
  await db.githubRepo.delete({ where: { tenant_fullName: { tenant, fullName } } })
}

const forkRepo: Handler = authed(
  withRepo(async (ctx, source) => {
    const body = jsonBodyOf(ctx)
    const name = str(body, 'name').trim() === '' ? source.name : str(body, 'name').trim()
    // `organization` forks into that account instead of the caller's, and
    // `default_branch_only` copies the default branch alone.
    const owner =
      str(body, 'organization').trim() === '' ? DEFAULT_LOGIN : str(body, 'organization').trim()
    const onlyDefault = body.default_branch_only === true
    const fullName = `${owner}/${name}`
    const existing = await repoByName(ctx.db, ctx.tenant, fullName)
    if (existing !== null)
      return { status: 202, body: await repoJson(ctx.db, ctx.tenant, existing) }
    const fork = (await ctx.db.githubRepo.create({
      data: {
        tenant: ctx.tenant,
        fullName,
        owner,
        name,
        defaultBranch: source.defaultBranch,
        metaJson: JSON.stringify({
          ...metaOf(source),
          fork: true,
          parent_seq: source.seq,
        }),
        seq: await nextRepoSeq(ctx.db, ctx.tenant),
      },
    })) as RepoRow
    // The defaults, not the source's: the python fork built a fresh FakeRepo and
    // copied only the branch trees, submodules and metadata onto it, so a fork
    // does not inherit the source's issues, releases or runs.
    await initRepo(ctx.db, ctx.tenant, fork)
    // Each branch at the commit its source's points at, and each tag, since
    // a fork shares its network's history and objects: a pull request from
    // it then has a merge base with its parent.
    for (const branch of await branchNames(ctx.db, ctx.tenant, source)) {
      if (onlyDefault && branch !== source.defaultBranch) continue
      await addBranch(ctx.db, ctx.tenant, fullName, branch)
      const head = await headOf(ctx.db, ctx.tenant, source, branch)
      if (head !== '') {
        await ctx.db.githubBranch.updateMany({
          where: { tenant: ctx.tenant, repo: fullName, name: branch },
          data: { headSha: head },
        })
      }
      const tree = await treeOfBranch(ctx.db, ctx.tenant, source, branch)
      let seq = 0
      for (const [path, data] of tree) {
        await ctx.db.githubFile.create({
          data: {
            tenant: ctx.tenant,
            repo: fullName,
            branch,
            path,
            data: new Uint8Array(data),
            seq,
          },
        })
        seq += 1
      }
    }
    for (const tag of await tagRefs(ctx.db, ctx.tenant, source)) {
      const count = await ctx.db.githubTagRef.count({
        where: { tenant: ctx.tenant, repo: fullName },
      })
      await ctx.db.githubTagRef.create({
        data: { tenant: ctx.tenant, repo: fullName, name: tag.name, sha: tag.sha, seq: count },
      })
    }
    const subs = await ctx.db.githubSubmodule.findMany({
      where: { tenant: ctx.tenant, repo: source.fullName },
      orderBy: { path: 'asc' },
    })
    for (const s of subs) {
      await ctx.db.githubSubmodule.create({
        data: { tenant: ctx.tenant, repo: fullName, path: s.path },
      })
    }
    return { status: 202, body: await repoJson(ctx.db, ctx.tenant, fork) }
  }),
)
