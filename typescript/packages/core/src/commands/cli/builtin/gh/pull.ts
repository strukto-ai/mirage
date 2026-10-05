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

import { DIFF_HEADER } from './constants.ts'
import { commentsFor, commentsText } from './issue.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import type { GitHubTransport } from '../../../../core/github/client.ts'
import {
  commentPull,
  createPull,
  diffPull,
  editPull,
  getPull,
  listPullRequestFields,
  listPulls,
  mergePull,
  pullChecks,
  pullRequestFields,
} from '../../../../core/github/pull.ts'
import type { RepoRef } from '../../../../core/github/repo.ts'
import {
  bodyValue,
  camel,
  ghBool,
  ghTransport,
  jsonFields,
  repoFor,
  repoNumber,
  textOut,
  textValue,
  typedOut,
} from './accessor.ts'
import {
  LOGIN,
  SHARED_FIELDS,
  connection,
  exportedNode,
  nodes,
  nodesOf,
  paged,
  plain,
  readRest,
  record,
  references,
  selection,
  type Connection,
  type Field,
  type Node,
} from './fields.ts'
import { exported, orNull, pointer, struct } from './shape.ts'

const OID = pointer(['oid', 'string'])
// Its `url` is `omitempty`, and gh never asks for it, so it never prints.
const REVIEW = struct(
  ['id', 'string'],
  ['author', LOGIN],
  ['authorAssociation', 'string'],
  ['body', 'string'],
  ['submittedAt', 'raw'],
  ['includesCreatedEdit', 'bool'],
  ['reactionGroups', 'reactions'],
  ['state', 'string'],
  ['commit', struct(['oid', 'string'])],
)
const FILE = struct(['path', 'string'], ['additions', 'int'], ['deletions', 'int'])

const REVIEWS = (after: string): string =>
  `reviews(first: 100${after}) {nodes {id,author{login},authorAssociation,submittedAt,body,` +
  'state,commit{oid},reactionGroups{content,users{totalCount}}}' +
  'pageInfo{hasNextPage,endCursor}totalCount}'
const CHECKS = (after: string): string =>
  'statusCheckRollup: commits(last: 1) {nodes {commit {statusCheckRollup ' +
  `{contexts(first:100${after}) {nodes {__typename...on StatusContext {context,state,` +
  'targetUrl,createdAt,description},...on CheckRun {name,checkSuite{workflowRun{workflow' +
  '{name}}},status,conclusion,startedAt,completedAt,detailsUrl}},' +
  'pageInfo{hasNextPage,endCursor}}}}}}'

/** The context connection of the one commit a status rollup reads. */
function contexts(node: Node): Connection {
  const commit = nodesOf(node.statusCheckRollup)[0]
  return connection(record(record(record(commit).commit).statusCheckRollup).contexts)
}

function commitsOf(node: Node): unknown[] {
  return nodesOf(node.commits).map((item) => {
    const commit = record(record(item).commit)
    return {
      authoredDate: exported(commit.authoredDate, 'time'),
      authors: nodesOf(commit.authors).map((author) => {
        const row = record(author)
        const user = record(row.user)
        return {
          email: exported(row.email, 'string'),
          id: exported(user.id, 'string'),
          login: exported(user.login, 'string'),
          name: exported(row.name, 'string'),
        }
      }),
      committedDate: exported(commit.committedDate, 'time'),
      messageBody: exported(commit.messageBody, 'string'),
      messageHeadline: exported(commit.messageHeadline, 'string'),
      oid: exported(commit.oid, 'string'),
    }
  })
}

// A status rollup with no commit behind it is null; one whose commit carries
// no rollup is an empty list, since gh builds that list before reading it.
function checksOf(node: Node): unknown[] | null {
  if (nodesOf(node.statusCheckRollup).length === 0) return null
  return nodesOf(contexts(node)).map((item) => {
    const row = record(item)
    if (row.__typename === 'CheckRun') {
      const workflow = record(record(record(row.checkSuite).workflowRun).workflow)
      return {
        __typename: 'CheckRun',
        completedAt: exported(row.completedAt, 'time'),
        conclusion: exported(row.conclusion, 'string'),
        detailsUrl: exported(row.detailsUrl, 'string'),
        name: exported(row.name, 'string'),
        startedAt: exported(row.startedAt, 'time'),
        status: exported(row.status, 'string'),
        workflowName: exported(workflow.name, 'string'),
      }
    }
    return {
      __typename: exported(row.__typename, 'string'),
      context: exported(row.context, 'string'),
      startedAt: exported(row.createdAt, 'time'),
      state: exported(row.state, 'string'),
      targetUrl: exported(row.targetUrl, 'string'),
    }
  })
}

// Only users and teams are listed; a team prints as `org/slug`.
function requestsOf(node: Node): unknown[] {
  const requests: unknown[] = []
  for (const item of nodesOf(node.reviewRequests)) {
    const reviewer = record(record(item).requestedReviewer)
    if (reviewer.__typename === 'User') {
      requests.push({ __typename: 'User', login: exported(reviewer.login, 'string') })
    } else if (reviewer.__typename === 'Team') {
      const org = textValue(record(reviewer.organization).login)
      requests.push({
        __typename: 'Team',
        name: exported(reviewer.name, 'string'),
        slug: `${org}/${textValue(reviewer.slug)}`,
      })
    }
  }
  return requests
}

/**
 * Every field `gh pr view --json` and `gh pr list --json` accept in gh 2.85:
 * the ones issues share, and the ones only a pull request has. `pr view`
 * never asks github.com for `projectCards`, which is gone there, so the
 * field prints null.
 */
const PULL_FIELD_TABLE: ReadonlyMap<string, Field> = new Map<string, Field>([
  ...SHARED_FIELDS.map(([name, spec]): readonly [string, Field] =>
    name === 'projectCards' ? [name, { ...spec, view: 'never' }] : [name, spec],
  ),
  plain('additions', 'int'),
  plain(
    'autoMergeRequest',
    pointer(
      ['authorEmail', 'raw'],
      ['commitBody', 'raw'],
      ['commitHeadline', 'raw'],
      ['mergeMethod', 'string'],
      ['enabledAt', 'time'],
      ['enabledBy', 'author'],
    ),
    'autoMergeRequest {authorEmail,commitBody,commitHeadline,mergeMethod,enabledAt,' +
      'enabledBy{login,...on User{id,name}}}',
  ),
  plain('baseRefName', 'string'),
  plain('baseRefOid', 'string'),
  plain('changedFiles', 'int'),
  references('closingIssuesReferences'),
  [
    'commits',
    {
      select:
        'commits(first: 100) {nodes {commit {authors(first:100) {nodes {name,email,' +
        'user{id,login}}},messageHeadline,messageBody,oid,committedDate,authoredDate}}}',
      export: commitsOf,
    },
  ],
  plain('deletions', 'int'),
  nodes('files', 'files(first: 100) {nodes {additions,deletions,path}}', FILE),
  plain('fullDatabaseId', 'string'),
  plain('headRefName', 'string'),
  plain('headRefOid', 'string'),
  plain(
    'headRepository',
    pointer(['id', 'string'], ['name', 'string'], ['nameWithOwner', 'string']),
    'headRepository{id,name}',
  ),
  plain('headRepositoryOwner', 'owner', 'headRepositoryOwner{id,login,...on User{name}}'),
  plain('isCrossRepository', 'bool'),
  plain('isDraft', 'bool'),
  nodes(
    'latestReviews',
    'latestReviews(first: 100) {nodes {author{login},authorAssociation,submittedAt,body,state}}',
    REVIEW,
  ),
  plain('maintainerCanModify', 'bool'),
  plain('mergeCommit', OID, 'mergeCommit{oid}'),
  plain('mergeStateStatus', 'string'),
  plain('mergeable', 'string'),
  plain('mergedAt', 'raw'),
  plain('mergedBy', orNull('author'), 'mergedBy{login,...on User{id,name}}'),
  plain('potentialMergeCommit', OID, 'potentialMergeCommit{oid}'),
  plain('reviewDecision', 'string'),
  [
    'reviewRequests',
    {
      select:
        'reviewRequests(first: 100) {nodes {requestedReviewer {__typename,...on User{login},' +
        '...on Team{organization{login}name,slug}}}}',
      export: requestsOf,
    },
  ],
  nodes('reviews', REVIEWS(''), REVIEW, paged('reviews', REVIEWS)),
  [
    'statusCheckRollup',
    { select: CHECKS(''), pages: { select: CHECKS, at: contexts }, export: checksOf },
  ],
])

export const PR_FIELDS: readonly string[] = [...PULL_FIELD_TABLE.keys()]

// The `--state` spellings as the pull request states gh lists for each.
const STATES: Readonly<Record<string, readonly string[]>> = {
  open: ['OPEN'],
  closed: ['CLOSED', 'MERGED'],
  merged: ['MERGED'],
  all: ['OPEN', 'CLOSED', 'MERGED'],
}

/**
 * One pull request as `gh pr view --json` reads it: the fields asked for in
 * one query, plus the `id` and `number` gh adds for its own follow-ups, every
 * connection it pages read to its end, and project items in a query of their
 * own. A line that asks for `number` alone is answered from the line itself,
 * which is gh's own shortcut.
 */
async function viewedPull(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  fields: readonly string[],
): Promise<Node> {
  if (fields.every((field) => field === 'number')) return { number }
  const names = [...fields, 'id', 'number']
  const node = await pullRequestFields(
    transport,
    ref,
    number,
    selection(PULL_FIELD_TABLE, names, true),
  )
  return readRest(PULL_FIELD_TABLE, node, fields, (select, cursor) =>
    pullRequestFields(transport, ref, number, select, cursor),
  )
}

const CHECK_FIELDS = [
  'bucket',
  'completedAt',
  'description',
  'event',
  'link',
  'name',
  'startedAt',
  'state',
  'workflow',
] as const

const BUCKETS: Record<string, string> = {
  success: 'pass',
  neutral: 'skipping',
  skipped: 'skipping',
  action_required: 'fail',
  error: 'fail',
  failure: 'fail',
  timed_out: 'fail',
  cancelled: 'cancel',
}

function pull(value: unknown): Record<string, unknown> {
  const row = camel(value)
  const result = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
  const base = result.base as Record<string, unknown> | undefined
  const head = result.head as Record<string, unknown> | undefined
  if (base !== undefined) result.baseRefName = base.ref
  if (head !== undefined) {
    result.headRefName = head.ref
    result.headRefOid = head.sha
  }
  delete result.base
  delete result.head
  if ('draft' in result) {
    result.isDraft = result.draft
    delete result.draft
  }
  result.closed = textValue(result.state).toLowerCase() === 'closed'
  return result
}

function listText(rows: Record<string, unknown>[]): string {
  return rows
    .map(
      (row) =>
        `${textValue(row.number)}\t${textValue(row.state).toUpperCase()}\t${textValue(row.title)}\t${textValue(row.headRefName)}\n`,
    )
    .join('')
}

function viewText(row: Record<string, unknown>): string {
  const author = row.author as { login?: unknown } | undefined
  return `title:\t${textValue(row.title)}\nstate:\t${textValue(row.state).toUpperCase()}\nauthor:\t${textValue(author?.login)}\nbase:\t${textValue(row.baseRefName)}\nhead:\t${textValue(row.headRefName)}\n--\n${textValue(row.body)}\n`
}

function target(inv: CLIInvocation, fl: FlagView) {
  return repoNumber(inv, fl, inv.texts[0], 'pull request', 'pull')
}

/**
 * `gh pr list`. With `--json` it asks GraphQL for exactly the fields named,
 * the way gh's PullRequestList does, so every field gh accepts is answered
 * in gh's own shape; the text view reads the REST listing.
 */
export async function listCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const wanted = fl.asStr('state') ?? 'open'
  const base = fl.asStr('base')
  const head = fl.asStr('head')
  const fields = jsonFields(fl, PR_FIELDS)
  if (fields !== null) {
    const rows = await listPullRequestFields(
      ghTransport(inv.config),
      repoFor(inv, fl),
      { states: STATES[wanted] ?? ['OPEN'], base, head },
      fl.asInt('limit') ?? 30,
      selection(PULL_FIELD_TABLE, fields, false),
    )
    return typedOut(
      rows.map((node) => exportedNode(PULL_FIELD_TABLE, node, fields)),
      fl,
      '',
      PR_FIELDS,
    )
  }
  const params: Record<string, string> = { state: wanted === 'merged' ? 'closed' : wanted }
  if (base !== undefined) params.base = base
  if (head !== undefined) params.head = head
  const values = await listPulls(
    ghTransport(inv.config),
    repoFor(inv, fl),
    params,
    fl.asInt('limit') ?? 30,
    wanted === 'merged'
      ? (row) => row.merged_at !== null && row.merged_at !== undefined
      : undefined,
  )
  const rows = values.map(pull)
  return typedOut(rows, fl, listText(rows), PR_FIELDS)
}

/**
 * `gh pr view`. With `--json` it reads the fields named over GraphQL, as gh
 * does (see viewedPull); the text view reads the REST object, and `-c` its
 * comments.
 */
export async function viewCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const [ref, number] = target(inv, fl)
  const fields = jsonFields(fl, PR_FIELDS)
  if (fields !== null) {
    const node = await viewedPull(ghTransport(inv.config), ref, number, fields)
    return typedOut(exportedNode(PULL_FIELD_TABLE, node, fields), fl, '', PR_FIELDS)
  }
  const row = pull(await getPull(ghTransport(inv.config), ref, number))
  const comments = await commentsFor(inv, fl, ref, number)
  return typedOut(
    row,
    fl,
    ghBool(fl, 'comments') ? commentsText(comments ?? []) : viewText(row),
    PR_FIELDS,
  )
}

export async function createCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const title = fl.asStr('title')
  const head = fl.asStr('head')
  const base = fl.asStr('base')
  const missing = [
    ['title', title],
    ['head', head],
    ['base', base],
  ].find(([, value]) => value === undefined || value === '')
  if (missing !== undefined)
    throw new Error(`--${String(missing[0])} is required in noninteractive mode`)
  const body = {
    title: title ?? '',
    head: head ?? '',
    base: base ?? '',
    body: (await bodyValue(inv, fl, { required: true })) ?? '',
    draft: ghBool(fl, 'draft'),
    maintainer_can_modify: !ghBool(fl, 'no_maintainer_edit'),
  }
  const created = pull(await createPull(ghTransport(inv.config), repoFor(inv, fl), body))
  return textOut(`${textValue(created.url)}\n`)
}

export async function editCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const body: Record<string, unknown> = {}
  const title = fl.asStr('title')
  const base = fl.asStr('base')
  const text = await bodyValue(inv, fl)
  if (title !== undefined) body.title = title
  if (base !== undefined) body.base = base
  if (text !== undefined) body.body = text
  if (Object.keys(body).length === 0) throw new Error('no pull request fields to edit')
  const [ref, number] = target(inv, fl)
  const edited = pull(await editPull(ghTransport(inv.config), ref, number, body))
  return textOut(`${textValue(edited.url)}\n`)
}

export async function mergeCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const methods = ['merge', 'rebase', 'squash'].filter((name) => ghBool(fl, name))
  if (methods.length > 1) throw new Error('choose only one merge strategy')
  const body: Record<string, unknown> = { merge_method: methods[0] ?? 'merge' }
  const subject = fl.asStr('subject')
  const message = await bodyValue(inv, fl)
  const sha = fl.asStr('match_head_commit')
  if (subject !== undefined) body.commit_title = subject
  if (message !== undefined) body.commit_message = message
  if (sha !== undefined) body.sha = sha
  const [ref, number] = target(inv, fl)
  await mergePull(ghTransport(inv.config), ref, number, body)
  return textOut(`✓ Merged pull request ${ref.owner}/${ref.repo}#${String(number)}\n`)
}

export async function closeCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const [ref, number] = target(inv, fl)
  const edited = pull(await editPull(ghTransport(inv.config), ref, number, { state: 'closed' }))
  return textOut(
    `✓ Closed pull request ${ref.owner}/${ref.repo}#${String(number)} (${textValue(edited.title)})\n`,
  )
}

export async function commentCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const [ref, number] = target(inv, fl)
  const comment = pull(
    await commentPull(
      ghTransport(inv.config),
      ref,
      number,
      (await bodyValue(inv, fl, { required: true })) ?? '',
    ),
  )
  return textOut(`${textValue(comment.url)}\n`)
}

export async function diffCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const [ref, number] = target(inv, fl)
  const value = await diffPull(ghTransport(inv.config), ref, number)
  if (ghBool(fl, 'name_only')) {
    return textOut(
      changedNames(value)
        .map((name) => `${name}\n`)
        .join(''),
    )
  }
  return textOut(value.endsWith('\n') ? value : `${value}\n`)
}

/**
 * The files a diff changes, as `gh pr diff --name-only` reads them: the `b/`
 * side of each `diff --git` header, quotes and all.
 */
function changedNames(diff: string): string[] {
  return [...diff.matchAll(DIFF_HEADER)].map((m) => `${m[1] ?? ''}${m[2] ?? ''}`.trim())
}

function check(value: Record<string, unknown>): Record<string, unknown> {
  const row = camel(value) as Record<string, unknown>
  row.link = row.detailsUrl ?? ''
  delete row.detailsUrl
  const output = row.output as { summary?: unknown } | undefined
  row.description = output?.summary ?? ''
  const state = textValue(row.conclusion ?? row.status)
  row.state = state
  row.bucket = BUCKETS[state] ?? 'pending'
  const app = row.app as { name?: unknown } | undefined
  row.workflow = app?.name ?? ''
  return row
}

export async function checksCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const [ref, number] = target(inv, fl)
  const rows = (await pullChecks(ghTransport(inv.config), ref, number)).map(check)
  const human = rows
    .map((row) => `${textValue(row.name)}\t${textValue(row.state)}\t${textValue(row.link)}\n`)
    .join('')
  const out = await typedOut(rows, fl, human, CHECK_FIELDS)
  if (out !== null) {
    const buckets = new Set(rows.map((row) => row.bucket))
    if (buckets.has('fail')) out[1].exitCode = 1
    else if (buckets.has('pending')) out[1].exitCode = 8
  }
  return out
}
