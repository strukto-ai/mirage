import { CommandSpec } from '../../../spec/types.ts'

import { compareCodePoints } from '../../../../utils/sort.ts'
import type { JsonValue } from '../../../../types.ts'
import { csvValues, ghBool, ghTransport, jsonFields, textOut, typedOut } from './accessor.ts'
import {
  SEARCH_ALIASES,
  SEARCH_BOOLEAN,
  SEARCH_FIELDS,
  SEARCH_FLAGS,
  SEARCH_MULTIPLE,
  SEARCH_SHAPES,
  SEARCH_SORTS,
} from './constants.ts'
import { renderTemplate } from './template.ts'
import { CLIHandler, type CLIInvocation } from '../../types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { UsageError } from '../../../errors.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { Argument } from '../../../spec/types.ts'
import { GitHubApiError } from '../../../../core/github/client.ts'
import { IOResult } from '../../../../io/types.ts'
import { search } from '../../../../core/github/search.ts'

function quote(value: string): string {
  return /[\s"]/.test(value) ? JSON.stringify(value) : value
}
function boolean(fl: FlagView, name: string): boolean {
  return ghBool(fl, name.replaceAll('-', '_'))
}

function query(kind: string, words: readonly string[], fl: FlagView): string {
  const qualifiers: Partial<Record<string, string[]>> = {}
  for (const name of SEARCH_FLAGS[kind] ?? []) {
    const value = fl.raw(name.replaceAll('-', '_'))
    if (
      value === undefined ||
      ['app', 'include-prs', 'locked', 'merged'].includes(name) ||
      name.startsWith('no-')
    )
      continue
    let key = SEARCH_ALIASES[name] ?? name
    if (name === 'review-requested' && typeof value === 'string' && value.includes('/'))
      key = 'team-review-requested'
    const values = SEARCH_BOOLEAN.includes(name)
      ? [String(boolean(fl, name))]
      : SEARCH_MULTIPLE.includes(name)
        ? csvValues(fl.asList(name.replaceAll('-', '_')))
        : [fl.asStr(name.replaceAll('-', '_')) ?? '']
    ;(qualifiers[key] ??= []).push(...values.filter(Boolean))
  }
  if (kind === 'issues' || kind === 'prs') {
    if (kind === 'prs' || !boolean(fl, 'include_prs'))
      qualifiers.type = [kind === 'prs' ? 'pr' : 'issue']
    if (fl.asStr('app') !== undefined) {
      if (fl.asStr('author') !== undefined)
        throw new UsageError('specify only `--author` or `--app`', 1)
      qualifiers.author = [`app/${fl.asStr('app') ?? ''}`]
    }
    for (const name of kind === 'prs' ? ['locked', 'merged'] : ['locked']) {
      if (fl.raw(name) !== undefined)
        (qualifiers.is ??= []).push(boolean(fl, name) ? name : `un${name}`)
    }
    qualifiers.no = ['assignee', 'label', 'milestone', 'project'].filter((name) =>
      boolean(fl, `no_${name}`),
    )
  }
  const keywords = words.map((word) => {
    const at = word.indexOf(':')
    return at < 0 ? quote(word) : `${word.slice(0, at)}:${quote(word.slice(at + 1))}`
  })
  return [
    ...keywords,
    ...Object.keys(qualifiers)
      .flatMap((key) => (qualifiers[key] ?? []).map((value) => `${key}:${quote(value)}`))
      .sort(compareCodePoints),
  ].join(' ')
}

function option(name: string): Argument {
  const choices: Record<string, string[]> = {
    state: ['open', 'closed'],
    'include-forks': ['false', 'true', 'only'],
    checks: ['pending', 'success', 'failure'],
    review: ['none', 'required', 'approved', 'changes_requested'],
  }
  const shorts: Record<string, string> = { repo: '-R', base: '-B', head: '-H' }
  return new Argument([...(shorts[name] === undefined ? [] : [shorts[name]]), `--${name}`], {
    action: SEARCH_MULTIPLE.includes(name) ? 'append' : 'store',
    nargs: SEARCH_BOOLEAN.includes(name) ? '?' : null,
    attachedOnly: SEARCH_BOOLEAN.includes(name),
    choices: SEARCH_BOOLEAN.includes(name) ? ['true', 'false'] : (choices[name] ?? []),
  })
}

export function searchSpec(): CommandSpec {
  return new CommandSpec({
    name: 'search',
    description: 'Search GitHub',
    subcommands: Object.entries(SEARCH_FLAGS).map(
      ([kind, names]) =>
        new CommandSpec({
          name: kind,
          description: `Search for ${kind}`,
          arguments: [
            ...names.map(option),
            new Argument('--json'),
            new Argument(['-q', '--jq']),
            new Argument(['-t', '--template']),
            new Argument(['-L', '--limit'], { type: 'int', default: '30' }),
            ...(SEARCH_SORTS[kind] === undefined
              ? []
              : [
                  new Argument('--sort', { choices: SEARCH_SORTS[kind] }),
                  new Argument('--order', { choices: ['asc', 'desc'] }),
                ]),
            new Argument('QUERY', { nargs: '*' }),
          ],
        }),
    ),
  })
}

export function searchHandlers(): Record<string, CLIHandler> {
  return Object.fromEntries(
    Object.keys(SEARCH_FLAGS).map((kind) => [
      `search ${kind}`,
      new CLIHandler({ fn: (inv) => searchCmd(kind, inv) }),
    ]),
  )
}

async function searchCmd(kind: string, inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags, inv.spec)
  const fields = jsonFields(fl, SEARCH_FIELDS[kind] ?? [])
  const limit = fl.asInt('limit')
  if (limit === undefined || limit < 1 || limit > 1000)
    throw new UsageError('`--limit` must be between 1 and 1000', 1)
  if (inv.texts.length === 0 && inv.argv.length <= 2)
    throw new UsageError('specify search keywords or flags', 1)
  if (fields === null && (fl.asStr('jq') !== undefined || fl.asStr('template') !== undefined))
    throw new UsageError('cannot use `--jq` or `--template` without `--json`', 1)
  if (fl.asStr('jq') !== undefined && fl.asStr('template') !== undefined)
    throw new UsageError('cannot use `--jq` and `--template` together', 1)
  const expression = query(kind, inv.texts, fl)
  let values: unknown[]
  try {
    values = await search(
      ghTransport(inv.config),
      ({ repos: 'repositories', prs: 'issues' } as Record<string, string>)[kind] ?? kind,
      expression,
      limit,
      SEARCH_SORTS[kind] ? fl.asStr('sort') : undefined,
      SEARCH_SORTS[kind] ? fl.asStr('order') : undefined,
    )
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: new TextEncoder().encode(`${searchError(error, expression)}\n`),
      }),
    ]
  }
  const rows = values.map((value) => exported(kind, value))
  const template = fl.asStr('template')
  if (template !== undefined)
    return textOut(
      renderTemplate(
        template,
        rows.map((row) => Object.fromEntries((fields ?? []).map((key) => [key, row[key] ?? null]))),
      ),
    )
  return typedOut(
    rows,
    fl,
    human(kind, rows, values, kind === 'issues' && boolean(fl, 'include_prs')),
    SEARCH_FIELDS[kind] ?? [],
  )
}

/**
 * How gh search words a failed search, its `httpError.Error`.
 *
 * A 422 naming its errors says the query is invalid, with the first reason;
 * anything else is the status, GitHub's message (the status line for a body
 * that is not JSON) and the request URL.
 */
function searchError(error: GitHubApiError, expression: string): string {
  const { data } = error
  const body =
    typeof data === 'object' && data !== null && !Array.isArray(data) ? record(data) : null
  const errors = body?.errors
  if (error.status === 422 && Array.isArray(errors) && errors.length > 0) {
    const reason = record(errors[0]).message
    const quoted = JSON.stringify(expression.trim())
    return `Invalid search query ${quoted}.\n${typeof reason === 'string' ? reason : ''}`
  }
  let message = `${String(error.status)} ${error.message}`
  if (body !== null) message = typeof body.message === 'string' ? body.message : ''
  return `HTTP ${String(error.status)}: ${message} (${error.url})`
}

type Row = Record<string, JsonValue>
function record(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {}
}
function shape(kind: string, value: JsonValue | undefined): JsonValue {
  if (kind.startsWith('*')) return value == null ? null : shape(kind.slice(1), value)
  if (kind.startsWith('[]'))
    return Array.isArray(value) ? value.map((item) => shape(kind.slice(2), item)) : null
  if (kind === 'time.Time') return value ?? '0001-01-01T00:00:00Z'
  if (kind === 'string') return value ?? ''
  if (kind === 'bool') return Boolean(value)
  if (kind === 'int') return value ?? 0
  const row = record(value)
  return Object.fromEntries(
    (SEARCH_SHAPES[kind] ?? []).map(([name, key, type]) => [name, shape(type, row[key])]),
  )
}
function user(value: unknown): Row {
  const row = record(value),
    bot = !row.node_id
  return {
    id: row.node_id ?? '',
    login: `${bot ? 'app/' : ''}${str(row.login)}`,
    type: row.type ?? '',
    url: row.html_url ?? '',
    is_bot: bot,
  }
}
function exported(kind: string, value: unknown): Row {
  const raw = record(value)
  const row = shape(
    (
      {
        repos: 'Repository',
        issues: 'Issue',
        prs: 'Issue',
        code: 'Code',
        commits: 'Commit',
      } as Record<string, string>
    )[kind] ?? '',
    raw,
  ) as Row
  if (kind === 'repos') row.owner = user(raw.owner)
  else if (kind === 'issues' || kind === 'prs') {
    row.author = user(raw.user)
    row.assignees = ((raw.assignees ?? []) as unknown[]).map(user)
    row.labels ??= []
    const pull = record(raw.pull_request)
    row.isPullRequest = Boolean(pull.html_url)
    row.state = pull.merged_at ? 'merged' : (raw.state ?? '')
    const parts = str(raw.repository_url).replace(/\/$/, '').split('/')
    row.repository = { name: parts.at(-1) ?? '', nameWithOwner: parts.slice(-2).join('/') }
  } else if (kind === 'code') {
    const repo = record(raw.repository)
    row.repository = {
      id: repo.node_id ?? '',
      nameWithOwner: repo.full_name ?? '',
      url: repo.html_url ?? '',
      isPrivate: Boolean(repo.private),
      isFork: Boolean(repo.fork),
    }
    row.textMatches = ((raw.text_matches ?? []) as Row[]).map((m) => ({
      fragment: m.fragment ?? '',
      matches: m.matches ?? null,
      type: m.object_type ?? '',
      property: m.property ?? '',
    }))
  } else if (kind === 'commits') {
    row.author = user(raw.author)
    row.committer = user(raw.committer)
    const info = record(raw.commit)
    row.commit = {
      author: shape('CommitUser', info.author),
      committer: shape('CommitUser', info.committer),
      comment_count: info.comment_count ?? 0,
      message: info.message ?? '',
      tree: shape('Tree', info.tree),
    }
    row.parents ??= []
    const repo = exported('repos', raw.repository)
    row.repository = Object.fromEntries(
      ['description', 'fullName', 'name', 'id', 'isFork', 'isPrivate', 'owner', 'url'].map(
        (key) => [key, repo[key] ?? null],
      ),
    )
  }
  return row
}
function str(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function records(value: JsonValue | undefined): Row[] {
  return Array.isArray(value) ? value.map(record) : []
}

function human(kind: string, rows: Row[], values: unknown[], both: boolean): string {
  const lines: string[] = []
  const clean = (value: JsonValue | undefined): string => str(value).trim().split(/\s+/).join(' ')
  rows.forEach((row, i) => {
    const raw = record(values[i]),
      repo = record(row.repository)
    let cells: string[]
    if (kind === 'issues' || kind === 'prs')
      cells = [
        ...(both ? [row.isPullRequest ? 'pr' : 'issue'] : []),
        str(repo.nameWithOwner),
        String(typeof row.number === 'number' ? row.number : 0),
        str(row.state),
        clean(row.title),
        records(row.labels)
          .map((label) => str(label.name))
          .join(', '),
        str(row.updatedAt),
      ]
    else if (kind === 'repos') {
      const tags = [
        str(row.visibility) || (row.isPrivate ? 'private' : 'public'),
        ...(row.isFork ? ['fork'] : []),
        ...(row.isArchived ? ['archived'] : []),
      ]
      cells = [str(row.fullName), clean(row.description), tags.join(', '), str(row.updatedAt)]
    } else if (kind === 'commits') {
      const info = record(row.commit)
      cells = [
        str(repo.fullName),
        str(row.sha),
        clean(info.message),
        str(record(raw.author).login),
        str(record(info.author).date),
      ]
    } else {
      for (const match of records(row.textMatches)) {
        let offset = 0
        for (const line of str(match.fragment).split('\n')) {
          const end = offset + new TextEncoder().encode(line).length
          if (
            records(match.matches).some(
              (m) =>
                Array.isArray(m.indices) &&
                typeof m.indices[0] === 'number' &&
                m.indices[0] >= offset &&
                m.indices[0] < end,
            )
          )
            lines.push(`${str(repo.nameWithOwner)}:${str(row.path)}: ${line.trim()}\n`)
          offset = end + 1
        }
      }
      return
    }
    lines.push(`${cells.join('\t')}\n`)
  })
  return lines.join('')
}
