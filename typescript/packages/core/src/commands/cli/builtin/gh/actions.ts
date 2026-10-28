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
import { FlagView } from '../../../spec/flag_view.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import type { PathSpec } from '../../../../types.ts'
import { UsageError } from '../../../errors.ts'
import { StreamRefusal } from '../../../../rs/errors.ts'
import {
  dispatchWorkflow,
  getRun,
  getWorkflow,
  jobLog,
  listJobs,
  listRuns,
  listWorkflows,
  rerun,
  rerunJob,
  runLogArchive,
  workflowContent,
} from '../../../../core/github/actions.ts'
import { GitHubApiError, type GitHubTransport } from '../../../../core/github/client.ts'
import type { RepoRef } from '../../../../core/github/repo.ts'
import { viewRepo } from '../../../../core/github/repo.ts'
import { IOResult, materialize } from '../../../../io/types.ts'
import { openStream, serveRequests, type RequestHost } from '../../../../rs/stream.ts'
import {
  camel,
  ghBool,
  listLimit,
  readCliFile,
  repoFor,
  textOut,
  textValue,
  typedOut,
} from './accessor.ts'
import { concat } from '../../../../utils/bytes.ts'
import type { util } from 'zod'

const RUN_FIELDS = [
  'attempt',
  'conclusion',
  'createdAt',
  'databaseId',
  'displayTitle',
  'event',
  'headBranch',
  'headSha',
  'name',
  'number',
  'startedAt',
  'status',
  'updatedAt',
  'url',
  'workflowDatabaseId',
  'workflowName',
] as const
const WORKFLOW_FIELDS = ['id', 'name', 'path', 'state'] as const
// The conclusions gh's `--log-failed` keeps (run/shared IsFailureState).
const FAILURE_STATES = new Set(['action_required', 'failure', 'startup_failure', 'timed_out'])
// How many jobs gh will fetch one by one when the archive lacks their logs.
const MAX_API_LOG_FETCHERS = 25
// gh's cap on a job name in an archive path, in UTF-16 code units, since the
// server that writes the archive truncates in C#.
const JOB_NAME_MAX_LENGTH = 90
const ENC = new TextEncoder()
const NEWLINE = 0x0a
const RETURN = 0x0d

function run(value: unknown): Record<string, unknown> {
  const row = camel(value)
  const result = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
  if ('id' in result) {
    result.databaseId = result.id
    delete result.id
  }
  if ('htmlUrl' in result) {
    result.url = result.htmlUrl
    delete result.htmlUrl
  }
  if ('runAttempt' in result) {
    result.attempt = result.runAttempt
    delete result.runAttempt
  }
  if ('runNumber' in result) {
    result.number = result.runNumber
    delete result.runNumber
  }
  if ('workflowId' in result) {
    result.workflowDatabaseId = result.workflowId
    delete result.workflowId
  }
  result.workflowName ??= result.name ?? ''
  result.startedAt ??= result.runStartedAt
  return result
}

function workflow(value: unknown): Record<string, unknown> {
  const row = camel(value)
  return row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
}

export async function runListCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const params: Record<string, string> = {}
  for (const [flag, key] of [
    ['branch', 'branch'],
    ['commit', 'head_sha'],
    ['event', 'event'],
    ['status', 'status'],
    ['user', 'actor'],
    ['created', 'created'],
  ] as const) {
    const value = fl.asStr(flag)
    if (value !== undefined && value !== '') params[key] = value
  }
  const rows = (
    await listRuns(
      accessor.transport,
      repoFor(accessor, fl),
      params,
      listLimit(fl, 20),
      fl.asStr('workflow'),
    )
  ).map(run)
  const human = rows
    .map(
      (row) =>
        `${textValue(row.status)}\t${textValue(row.conclusion)}\t${textValue(row.displayTitle)}\t${textValue(row.workflowName)}\t${textValue(row.headBranch)}\t${textValue(row.event)}\t${textValue(row.databaseId)}\n`,
    )
    .join('')
  return typedOut(rows, fl, human, RUN_FIELDS)
}

export async function runViewCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const raw = texts[0] ?? ''
  if (!/^\d+$/.test(raw)) throw new Error('a run ID is required in noninteractive mode')
  const logs = ghBool(fl, 'log')
  const failedOnly = ghBool(fl, 'log_failed')
  if (logs && failedOnly) throw new UsageError('specify only one of --log or --log-failed', 1)
  const transport = accessor.transport
  const ref = repoFor(accessor, fl)
  const row = run(await getRun(transport, ref, Number(raw)))
  // `--json` is answered first, as gh's exporter is.
  if ((logs || failedOnly) && fl.asStr('json') === undefined) {
    return [await runLog(transport, ref, row, failedOnly), new IOResult()]
  }
  const human = `title:\t${textValue(row.displayTitle)}\nworkflow:\t${textValue(row.workflowName)}\nstatus:\t${textValue(row.status)}\nconclusion:\t${textValue(row.conclusion)}\nbranch:\t${textValue(row.headBranch)}\nevent:\t${textValue(row.event)}\n`
  const out = await typedOut(row, fl, human, RUN_FIELDS)
  if (
    out !== null &&
    ghBool(fl, 'exit_status') &&
    row.conclusion !== null &&
    row.conclusion !== undefined &&
    row.conclusion !== '' &&
    row.conclusion !== 'success'
  ) {
    out[1].exitCode = 1
  }
  return out
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => item !== null && typeof item === 'object',
      )
    : []
}

/**
 * A job's name as the archive spells it (gh's getJobNameForLogFilename): the
 * `/` and `:` the server drops, cut to 90 UTF-16 code units the way C# cuts a
 * string, a half surrogate pair read as U+FFFD, and trimmed.
 */
function logName(name: string): string {
  const cut = name.replace(/[/:]/g, '').slice(0, JOB_NAME_MAX_LENGTH)
  return cut
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .trim()
}

function quoted(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
}

// A run's log archive read from memory by mirage-rs's unzip, with its exit
// status: its stored names (index), or the entries it picks.
async function unzipped(
  archive: Uint8Array,
  config: Record<string, util.JSONType>,
): Promise<[number, Uint8Array]> {
  const engine = await openStream('unzip', { archive: '', ...config })
  // The engine reads the archive a window at a time, each answered whole.
  const host: RequestHost = {
    errors: { append: () => Promise.resolve() },
    serve: (request) => {
      if (request.op === 'fill') return Promise.resolve({ reply: { size: archive.length } })
      if (request.op !== 'read') return Promise.resolve({ reply: {} })
      const skip = Number(request.skip ?? 0)
      const data = archive.subarray(skip, skip + Number(request.size ?? 0))
      return Promise.resolve({ reply: {}, data })
    },
  }
  try {
    const out = await materialize(serveRequests(engine, host))
    return [engine.status(), out]
  } finally {
    engine.close()
  }
}

// Entries `picks` of a run's log archive, read in one pass over its
// directory a window at a time: each frame a tag (0 a window, 1 the entry
// whole, 2 not) and its four-byte length. Null for an entry that did not
// decode whole.
async function members(
  archive: Uint8Array,
  picks: readonly number[],
): Promise<Map<number, Uint8Array | null>> {
  const [, framed] = await unzipped(archive, { picks: [...picks] })
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength)
  const read = new Map<number, Uint8Array | null>()
  let at = 0
  for (const pick of picks) {
    const windows: Uint8Array[] = []
    let tag = framed[at]
    while (tag === 0) {
      const end = at + 5 + view.getUint32(at + 1, true)
      windows.push(framed.subarray(at + 5, end))
      at = end
      tag = framed[at]
    }
    at += 5
    read.set(pick, tag === 1 ? concat(windows) : null)
  }
  return read
}

// The archive entry gh reads for a job, or one of its steps: the first whose
// name matches, in the archive's own order.
function entryFor(names: readonly string[], pattern: RegExp): number | undefined {
  const at = names.findIndex((name) => pattern.test(name))
  return at < 0 ? undefined : at
}

// A log's lines as bufio.Scanner splits them: at each newline, a carriage
// return before it dropped, and no empty line after a final newline.
function logLines(data: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = []
  let start = 0
  while (start < data.length) {
    let end = data.indexOf(NEWLINE, start)
    const next = end < 0 ? data.length : end + 1
    if (end < 0) end = data.length
    lines.push(data.subarray(start, end > start && data[end - 1] === RETURN ? end - 1 : end))
    start = next
  }
  return lines
}

// A job's or step's log: an archive entry by its place, or a fetch.
interface LogSegment {
  job: string
  step: string
  read: number | (() => Promise<Uint8Array>)
}

async function apiJobLog(
  transport: GitHubTransport,
  ref: RepoRef,
  id: number,
): Promise<Uint8Array> {
  try {
    return await jobLog(transport, ref, id)
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      throw new Error(`log not found: ${String(id)}`)
    }
    throw err
  }
}

/**
 * The segments gh prints for a run's log (run/view populateLogSegments):
 * per job, its steps' own files when the archive has any, otherwise the
 * job's whole log from the archive, otherwise the job's log fetched on its
 * own, at most 25 of those. A skipped job prints nothing, and `--log-failed`
 * keeps only failed jobs and, within them, failed steps.
 */
function logSegments(
  transport: GitHubTransport,
  ref: RepoRef,
  jobs: readonly Record<string, unknown>[],
  names: readonly string[],
  failedOnly: boolean,
): LogSegment[] {
  const segments: LogSegment[] = []
  let fetchers = 0
  for (const job of jobs) {
    const conclusion = textValue(job.conclusion)
    if (conclusion === 'skipped') continue
    if (failedOnly && !FAILURE_STATES.has(conclusion)) continue
    const title = textValue(job.name)
    const name = quoted(logName(title))
    const steps = records(job.steps)
    const stepFile = (step: Record<string, unknown>): number | undefined =>
      entryFor(names, new RegExp(`^${name}\\/${textValue(step.number)}_.*\\.txt$`))
    if (steps.some((step) => stepFile(step) !== undefined)) {
      const ordered = [...steps].sort((a, b) => Number(a.number) - Number(b.number))
      for (const step of ordered) {
        if (failedOnly && !FAILURE_STATES.has(textValue(step.conclusion))) continue
        const file = stepFile(step)
        if (file !== undefined)
          segments.push({ job: title, step: textValue(step.name), read: file })
      }
      continue
    }
    const file =
      entryFor(names, new RegExp(`^\\d+_${name}\\.txt$`)) ??
      entryFor(names, new RegExp(`^-\\d+_${name}\\.txt$`))
    if (file !== undefined) {
      segments.push({ job: title, step: 'UNKNOWN STEP', read: file })
      continue
    }
    const id = Number(job.id)
    segments.push({ job: title, step: 'UNKNOWN STEP', read: () => apiJobLog(transport, ref, id) })
    fetchers += 1
    if (fetchers > MAX_API_LOG_FETCHERS) {
      throw new Error(
        'too many API requests needed to fetch logs; try narrowing down to a specific job with the `--job` option',
      )
    }
  }
  return segments
}

/**
 * `gh run view --log` and `--log-failed`: the run's jobs, then, once the run
 * is complete, its log archive, printed a line at a time behind the job and
 * step it came from. A run still going is refused before any log is asked
 * for, in gh's words.
 */
async function runLog(
  transport: GitHubTransport,
  ref: RepoRef,
  row: Record<string, unknown>,
  failedOnly: boolean,
): Promise<Uint8Array> {
  const id = Number(row.databaseId)
  const jobs = await listJobs(transport, ref, id)
  if (row.status !== 'completed') {
    throw new Error(
      `run ${String(id)} is still in progress; logs will be available when it is complete`,
    )
  }
  let archive: Uint8Array
  try {
    archive = await runLogArchive(transport, ref, id)
  } catch (err) {
    if (!(err instanceof GitHubApiError)) throw err
    throw new Error(`failed to get run log: ${err.status === 404 ? 'log not found' : err.message}`)
  }
  const [status, index] = await unzipped(archive, { index: true })
  if (status !== 0) throw new Error('failed to get run log: zip: not a valid zip file')
  // Each stored name behind its two-byte length, so any byte may be in one.
  const names: string[] = []
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength)
  for (let at = 0; at < index.length;) {
    const end = at + 2 + view.getUint16(at, true)
    names.push(new TextDecoder().decode(index.subarray(at + 2, end)))
    at = end
  }
  const segments = logSegments(transport, ref, jobs, names, failedOnly)
  const read = await members(
    archive,
    segments.flatMap((segment) => (typeof segment.read === 'number' ? [segment.read] : [])),
  )
  const printed: Uint8Array[] = []
  for (const segment of segments) {
    let data: Uint8Array
    try {
      if (typeof segment.read === 'number') {
        const member = read.get(segment.read) ?? null
        if (member === null) throw new Error('zip: checksum error')
        data = member
      } else {
        data = await segment.read()
      }
    } catch (err) {
      if (!(err instanceof Error) || printed.length === 0) throw err
      throw new StreamRefusal(err.message, concat(printed))
    }
    const prefix = ENC.encode(`${segment.job}\t${segment.step}\t`)
    for (const line of logLines(data)) printed.push(prefix, line, ENC.encode('\n'))
  }
  return concat(printed)
}

export async function runRerunCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const raw = texts[0] ?? ''
  if (!/^\d+$/.test(raw)) throw new Error('a run ID is required in noninteractive mode')
  const transport = accessor.transport
  const ref = repoFor(accessor, fl)
  const job = fl.asStr('job')
  if (job !== undefined && job !== '') {
    if (!/^\d+$/.test(job)) throw new Error('--job expects a numeric job ID')
    await rerunJob(transport, ref, Number(job), ghBool(fl, 'debug'))
  } else {
    await rerun(
      transport,
      ref,
      Number(raw),
      ghBool(fl, 'failed') ? 'rerun-failed-jobs' : 'rerun',
      ghBool(fl, 'debug') ? { enable_debug_logging: true } : undefined,
    )
  }
  return textOut('')
}

export async function workflowListCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const rows = (
    await listWorkflows(
      accessor.transport,
      repoFor(accessor, fl),
      listLimit(fl, 50),
      ghBool(fl, 'all') ? undefined : (row) => row.state === 'active',
    )
  ).map(workflow)
  const human = rows
    .map((row) => `${textValue(row.name)}\t${textValue(row.state)}\t${textValue(row.id)}\n`)
    .join('')
  return typedOut(rows, fl, human, WORKFLOW_FIELDS)
}

export async function workflowViewCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const id = texts[0] ?? ''
  if (id === '') throw new Error('a workflow ID, name, or filename is required')
  const yaml = ghBool(fl, 'yaml')
  const gitRef = fl.asStr('ref') ?? ''
  if (!yaml && gitRef !== '') throw new UsageError('`--yaml` required when specifying `--ref`', 1)
  const transport = accessor.transport
  const ref = repoFor(accessor, fl)
  const row = workflow(await getWorkflow(transport, ref, id))
  if (!yaml) {
    return textOut(
      `${textValue(row.name)} - ${textValue(row.state)}\nID: ${textValue(row.id)}\nFile: ${textValue(row.path)}\n`,
    )
  }
  return [await workflowYaml(transport, ref, textValue(row.path), gitRef), new IOResult()]
}

/**
 * `gh workflow view --yaml`: the workflow's file, read from the repository at
 * `--ref` or the default branch and printed as it is, with a newline added
 * when it ends without one. A file the ref lacks is refused in gh's words.
 */
async function workflowYaml(
  transport: GitHubTransport,
  ref: RepoRef,
  path: string,
  gitRef: string,
): Promise<Uint8Array> {
  const base = path.slice(path.lastIndexOf('/') + 1)
  let content: Uint8Array
  try {
    content = await workflowContent(transport, ref, path, gitRef)
  } catch (err) {
    if (!(err instanceof GitHubApiError)) throw err
    if (err.status !== 404) throw new Error(`could not get workflow file content: ${err.message}`)
    throw new Error(
      gitRef === ''
        ? `could not find workflow file ${base}, try specifying a branch or tag using \`--ref\``
        : `could not find workflow file ${base} on ${gitRef}, try specifying a different ref`,
    )
  }
  return content.at(-1) === NEWLINE ? content : concat([content, ENC.encode('\n')])
}

async function workflowInputs(ctx: Context, fl: FlagView): Promise<Record<string, unknown>> {
  if (ghBool(fl, 'json')) {
    if (ctx.stdin === null) throw new Error('--json needs standard input')
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(await materialize(ctx.stdin)))
    } catch (err) {
      if (err instanceof SyntaxError)
        throw new Error(`invalid JSON from standard input: ${err.message}`)
      throw err
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('workflow inputs must be a JSON object')
    }
    return value as Record<string, unknown>
  }
  const inputs: Record<string, unknown> = {}
  for (const pair of fl.asList('raw_field')) {
    const at = pair.indexOf('=')
    if (at < 0) throw new Error(`expected "key=value", got "${pair}"`)
    inputs[pair.slice(0, at)] = pair.slice(at + 1)
  }
  for (const pair of fl.asList('field')) {
    const at = pair.indexOf('=')
    if (at < 0) throw new Error(`expected "key=value", got "${pair}"`)
    const value = pair.slice(at + 1)
    inputs[pair.slice(0, at)] = value.startsWith('@')
      ? new TextDecoder().decode(await readCliFile(ctx, value.slice(1), '--field'))
      : value
  }
  return inputs
}

export async function workflowRunCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const id = texts[0] ?? ''
  if (id === '') throw new Error('a workflow ID, name, or filename is required')
  const transport = accessor.transport
  const ref = repoFor(accessor, fl)
  let branch = fl.asNonEmpty('ref') ?? accessor.config.branch
  if (branch === undefined || branch === '') {
    const repository = (await viewRepo(transport, ref)) as { default_branch?: unknown }
    branch = typeof repository.default_branch === 'string' ? repository.default_branch : undefined
  }
  if (branch === undefined || branch === '') throw new Error('a workflow ref is required')
  await dispatchWorkflow(transport, ref, id, { ref: branch, inputs: await workflowInputs(ctx, fl) })
  return textOut('')
}
