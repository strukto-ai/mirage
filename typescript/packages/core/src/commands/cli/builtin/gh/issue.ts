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

import type { GitHubAccount } from '../../../../accessor/github.ts'
import type { GitHubTransport } from '../../../../core/github/client.ts'
import {
  commentIssue,
  createIssue,
  editIssue,
  getIssue,
  issueComments,
  issueFields,
  listIssueFields,
  listIssues,
} from '../../../../core/github/issue.ts'
import type { RepoRef } from '../../../../core/github/repo.ts'
import type { JsonObject, PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { IOResult } from '../../../../io/types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { UsageError } from '../../../errors.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import {
  bodyValue,
  camel,
  csvValues,
  ghBool,
  jsonFields,
  listLimit,
  repoFor,
  repoNumber,
  subjectNumber,
  textOut,
  textValue,
  typedOut,
} from './accessor.ts'
import {
  exportedNode,
  plain,
  readRest,
  references,
  selection,
  SHARED_FIELDS,
  type Field,
} from './fields.ts'

/**
 * Every field `gh issue view --json` and `gh issue list --json` accept in
 * gh 2.85: the ones pull requests share, and the ones only an issue has.
 */
const ISSUE_FIELD_TABLE: ReadonlyMap<string, Field> = new Map<string, Field>([
  ...SHARED_FIELDS,
  plain('isPinned', 'bool'),
  plain('stateReason', 'string'),
  references('closedByPullRequestsReferences'),
])

export const ISSUE_FIELDS: readonly string[] = [...ISSUE_FIELD_TABLE.keys()]

// The fields a pull request has no answer for, which gh leaves out of the
// pull request half of its query, so they print at their zero for one.
const ISSUE_ONLY = new Set(['isPinned', 'stateReason', 'closedByPullRequestsReferences'])

// The `--state` spellings as the issue states gh lists for each.
const STATES: Readonly<Record<string, readonly string[]>> = {
  open: ['OPEN'],
  closed: ['CLOSED'],
  all: ['OPEN', 'CLOSED'],
}

/**
 * One issue as `gh issue view --json` reads it. gh asks for the number as an
 * issue or a pull request, so a pull request's number answers too. It adds
 * the `id` its follow-ups read, and the `number` when it reads project items
 * apart; every connection it pages is then read to its end, through the half
 * of the query that matches what the number turned out to be.
 */
async function viewedIssue(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  fields: readonly string[],
): Promise<JsonObject> {
  const names = [...fields, 'id', ...(fields.includes('projectItems') ? ['number'] : [])]
  const node = await issueFields(transport, ref, number, {
    issue: selection(ISSUE_FIELD_TABLE, names, true),
    pull: selection(
      ISSUE_FIELD_TABLE,
      names.filter((name) => !ISSUE_ONLY.has(name)),
      true,
    ),
  })
  const pull = node.__typename === 'PullRequest'
  return readRest(ISSUE_FIELD_TABLE, node, fields, (select, cursor) =>
    issueFields(
      transport,
      ref,
      number,
      pull ? { issue: '', pull: select } : { issue: select, pull: '' },
      cursor,
    ),
  )
}

function issue(value: unknown): Record<string, unknown> {
  const row = camel(value)
  const result = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
  result.closed = textValue(result.state).toLowerCase() === 'closed'
  return result
}

function names(value: unknown, key: 'login' | 'name'): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => textValue(item[key] ?? item.name))
    .filter(Boolean)
}

function labels(row: Record<string, unknown>): string {
  return names(row.labels, 'name').join(', ')
}

function listText(rows: Record<string, unknown>[]): string {
  return rows
    .map(
      (row) =>
        `${textValue(row.number)}\t${textValue(row.state).toUpperCase()}\t${textValue(row.title)}\t${labels(row)}\n`,
    )
    .join('')
}

function viewText(row: Record<string, unknown>): string {
  const author = row.author as { login?: unknown } | undefined
  return `title:\t${textValue(row.title)}\nstate:\t${textValue(row.state).toUpperCase()}\nauthor:\t${textValue(author?.login)}\nlabels:\t${labels(row)}\n--\n${textValue(row.body)}\n`
}

/**
 * The issues `gh issue edit` names, read as gh's ParseIssuesFromArgs reads
 * them: at least one, each parsed before anything is asked, and the
 * repository a URL names the one every issue is in.
 */
function targets(accessor: GitHubAccount, texts: string[], fl: FlagView): [RepoRef, number[]] {
  if (texts.length === 0) throw new Error('requires at least 1 arg(s), only received 0')
  let named: RepoRef | null = null
  const numbers: number[] = []
  for (const text of texts) {
    const number = subjectNumber(text)
    if (number !== null) {
      numbers.push(number)
      continue
    }
    const [ref, found] = repoNumber(accessor, fl, text, 'issue', 'issues')
    const name = `${ref.owner}/${ref.repo}`
    if (named !== null && name.toLowerCase() !== `${named.owner}/${named.repo}`.toLowerCase()) {
      const expected = `${named.owner}/${named.repo}`
      throw new Error(
        `multiple issues must be in same repo: found ${JSON.stringify(name)}, expected ${JSON.stringify(expected)}`,
      )
    }
    named ??= ref
    numbers.push(found)
  }
  return [named ?? repoFor(accessor, fl), numbers]
}

/** The issue a line names: one, as cobra's ExactArgs(1) holds gh's verbs to. */
function target(accessor: GitHubAccount, texts: string[], fl: FlagView) {
  if (texts.length !== 1) throw new Error(`accepts 1 arg(s), received ${String(texts.length)}`)
  return repoNumber(accessor, fl, texts[0], 'issue', 'issues')
}

/**
 * `gh issue list`. With `--json` it asks GraphQL for exactly the fields
 * named, the way gh's IssueList does, so every field gh accepts is answered
 * in gh's own shape; the text view reads the REST listing.
 */
export async function listCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const state = fl.asStr('state') ?? 'open'
  const assignee = fl.asNonEmpty('assignee')
  const author = fl.asNonEmpty('author')
  const labelValues = csvValues(fl.asList('label'))
  const fields = jsonFields(fl, ISSUE_FIELDS)
  if (fields !== null) {
    const rows = await listIssueFields(
      accessor.transport,
      repoFor(accessor, fl),
      { states: STATES[state] ?? ['OPEN'], assignee, author, labels: labelValues },
      listLimit(fl, 30),
      selection(ISSUE_FIELD_TABLE, fields, false),
    )
    return typedOut(
      rows.map((node) => exportedNode(ISSUE_FIELD_TABLE, node, fields)),
      fl,
      '',
      ISSUE_FIELDS,
      ctx,
    )
  }
  const params: Record<string, string> = { state }
  if (assignee !== undefined) params.assignee = assignee
  if (author !== undefined) params.creator = author
  if (labelValues.length > 0) params.labels = labelValues.join(',')
  const values = await listIssues(
    accessor.transport,
    repoFor(accessor, fl),
    params,
    listLimit(fl, 30),
  )
  const rows = values.map(issue)
  return typedOut(rows, fl, listText(rows), ISSUE_FIELDS, ctx)
}

/**
 * `gh issue view`. With `--json` it reads the fields named over GraphQL, as
 * gh does (see viewedIssue); the text view reads the REST object, and `-c`
 * its comments.
 */
export async function viewCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const [ref, number] = target(accessor, texts, fl)
  const fields = jsonFields(fl, ISSUE_FIELDS)
  if (fields !== null) {
    const node = await viewedIssue(accessor.transport, ref, number, fields)
    return typedOut(exportedNode(ISSUE_FIELD_TABLE, node, fields), fl, '', ISSUE_FIELDS, ctx)
  }
  const row = issue(await getIssue(accessor.transport, ref, number))
  const comments = await commentsFor(accessor, fl, ref, number)
  return typedOut(
    row,
    fl,
    ghBool(fl, 'comments') ? commentsText(comments ?? []) : viewText(row),
    ISSUE_FIELDS,
    ctx,
  )
}

export async function createCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const title = fl.asStr('title')
  if (title === undefined || title === '')
    throw new Error('--title is required in noninteractive mode')
  const body: Record<string, unknown> = { title, body: (await bodyValue(ctx, fl)) ?? '' }
  const labelValues = csvValues(fl.asList('label'))
  const assignees = csvValues(fl.asList('assignee'))
  if (labelValues.length > 0) body.labels = labelValues
  if (assignees.length > 0) body.assignees = assignees
  const created = issue(await createIssue(accessor.transport, repoFor(accessor, fl), body))
  return textOut(`${textValue(created.url)}\n`)
}

/**
 * `gh issue edit`: every issue named, as gh edits them. Each is read first,
 * which ends the line at the first one missing; each is then edited, the
 * URLs of those edited printed in order, and any that failed named on
 * standard error with the count.
 */
export async function editCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const transport = accessor.transport
  const [ref, numbers] = targets(accessor, texts, fl)
  const title = fl.asStr('title')
  const text = await bodyValue(ctx, fl)
  const additions = csvValues(fl.asList('add_label'))
  const removals = new Set(csvValues(fl.asList('remove_label')))
  const addAssignees = csvValues(fl.asList('add_assignee'))
  const removeAssignees = new Set(csvValues(fl.asList('remove_assignee')))
  const relabel = additions.length > 0 || removals.size > 0
  const reassign = addAssignees.length > 0 || removeAssignees.size > 0
  if (title === undefined && text === undefined && !relabel && !reassign) {
    throw new UsageError('field to edit flag required when not running interactively', 1)
  }
  const rows: Record<string, unknown>[] = []
  for (const number of numbers) rows.push(issue(await getIssue(transport, ref, number)))
  const edited: string[] = []
  const failed: string[] = []
  for (const [at, current] of rows.entries()) {
    const body: Record<string, unknown> = {}
    if (title !== undefined) body.title = title
    if (text !== undefined) body.body = text
    if (relabel) {
      body.labels = [
        ...new Set([
          ...names(current.labels, 'name').filter((name) => !removals.has(name)),
          ...additions,
        ]),
      ]
    }
    if (reassign) {
      body.assignees = [
        ...new Set([
          ...names(current.assignees, 'login').filter((name) => !removeAssignees.has(name)),
          ...addAssignees,
        ]),
      ]
    }
    try {
      edited.push(textValue(issue(await editIssue(transport, ref, numbers[at] ?? 0, body)).url))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      failed.push(`failed to update ${textValue(current.url)}: ${reason}`)
    }
  }
  const out = textOut(
    edited
      .sort(compareCodePoints)
      .map((url) => `${url}\n`)
      .join(''),
  )
  if (failed.length === 0 || out === null) return out
  const count = failed.length === 1 ? '1 issue' : `${String(failed.length)} issues`
  const lines = [...failed.sort(compareCodePoints), `gh issue edit: failed to update ${count}`]
  out[1].exitCode = 1
  out[1].stderr = new TextEncoder().encode(lines.map((line) => `${line}\n`).join(''))
  return out
}

export async function closeCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const [ref, number] = target(accessor, texts, fl)
  const edited = issue(await editIssue(accessor.transport, ref, number, { state: 'closed' }))
  return textOut(
    `✓ Closed issue ${ref.owner}/${ref.repo}#${String(number)} (${textValue(edited.title)})\n`,
  )
}

export async function reopenCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const [ref, number] = target(accessor, texts, fl)
  const transport = accessor.transport
  const row = issue(await getIssue(transport, ref, number))
  const name = `${ref.owner}/${ref.repo}#${String(number)} (${textValue(row.title)})`
  if (row.closed !== true) {
    return [
      new Uint8Array(0),
      new IOResult({ stderr: new TextEncoder().encode(`! Issue ${name} is already open\n`) }),
    ]
  }
  const comment = fl.asStr('comment')
  if (comment !== undefined && comment !== '') await commentIssue(transport, ref, number, comment)
  await editIssue(transport, ref, number, { state: 'open' })
  return textOut(`✓ Reopened issue ${name}\n`)
}

export async function commentCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const body = await bodyValue(ctx, fl, { required: true })
  const [ref, number] = target(accessor, texts, fl)
  const comment = issue(await commentIssue(accessor.transport, ref, number, body ?? ''))
  return textOut(`${textValue(comment.url)}\n`)
}

export async function commentsFor(
  accessor: GitHubAccount,
  fl: FlagView,
  ref: { owner: string; repo: string },
  number: number,
): Promise<Record<string, unknown>[] | null> {
  if (!ghBool(fl, 'comments')) return null
  const rows = await issueComments(accessor.transport, ref, number)
  return rows.map((row) => ({
    ...row,
    author: row.author ?? { login: '' },
    minimizedReason: row.minimizedReason ?? '',
    reactionGroups: (row.reactionGroups as { users: { totalCount: number } }[]).filter(
      (group) => group.users.totalCount > 0,
    ),
  }))
}

export function commentsText(rows: Record<string, unknown>[]): string {
  return rows
    .map(
      (row) =>
        `author:\t${textValue((row.author as { login: string } | null)?.login)}\nassociation:\t${textValue(row.authorAssociation).toLowerCase()}\nedited:\t${String(row.includesCreatedEdit)}\nstatus:\t${row.isMinimized ? textValue(row.minimizedReason).toLowerCase() : 'none'}\n--\n${textValue(row.body)}\n--\n`,
    )
    .join('')
}
