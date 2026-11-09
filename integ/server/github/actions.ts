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

import { crc32 } from 'node:zlib'
import { YAMLException, load as yamlLoad } from 'js-yaml'
import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { API_PREFIXES, DEFAULT_LOGIN, WRITE_COMMIT_DATE } from './config.ts'
import type { C } from './config.ts'
import { branchFor, resolveRef, scope, treeOfBranch, visibleHeadOf } from './store.ts'
import type { RepoRow, Tree } from './store.ts'
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

const DISPATCHED_AT = '2026-01-01T00:04:00Z'

// GitHub keeps a workflow's id and state once it has seen its file; its name
// is whatever the file says now, so only the first two are stored.
interface WorkflowRow {
  id: number
  path: string
  state: string
}

interface Workflow extends WorkflowRow {
  name: string
  data: Buffer
}

// One job of a run, as a fixture states it: the vendor's own field names, and
// each step carrying the log text its file in the run's log archive holds.
interface JobStep {
  name: string
  number: number
  status: string
  conclusion: string | null
  started_at: string | null
  completed_at: string | null
  log: string
}

interface Job {
  id: number
  name: string
  status: string
  conclusion: string | null
  started_at: string | null
  completed_at: string | null
  steps: JobStep[]
}

interface RunRow {
  id: number
  name: string
  displayTitle: string
  workflowId: number
  runNumber: number
  runAttempt: number
  event: string
  headBranch: string
  headSha: string
  status: string
  conclusion: string | null
  createdAt: string
  updatedAt: string
  runStartedAt: string | null
  jobsJson: string
}

interface CheckRow {
  id: number
  sha: string
  name: string
  status: string
  conclusion: string
  startedAt: string
  completedAt: string
  detailsUrl: string
  summary: string
  appName: string
}

export interface StatusRow {
  context: string
  state: string
  targetUrl: string
  description: string
  createdAt: string
  updatedAt: string
  sha: string
  seq: number
}

function workflowJson(row: Workflow): JsonValue {
  return { id: row.id, name: row.name, path: row.path, state: row.state }
}

function runJson(repo: RepoRow, row: RunRow): JsonValue {
  return {
    id: row.id,
    name: row.name,
    display_title: row.displayTitle,
    workflow_id: row.workflowId,
    run_number: row.runNumber,
    run_attempt: row.runAttempt,
    event: row.event,
    head_branch: row.headBranch,
    head_sha: row.headSha,
    status: row.status,
    conclusion: row.conclusion,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    run_started_at: row.runStartedAt,
    html_url: `https://github.com/${repo.fullName}/actions/runs/${String(row.id)}`,
    jobs_url: `https://api.github.com/repos/${repo.fullName}/actions/runs/${String(row.id)}/jobs`,
  }
}

function checkJson(row: CheckRow): JsonValue {
  return {
    id: row.id,
    head_sha: row.sha,
    name: row.name,
    status: row.status,
    conclusion: row.conclusion,
    started_at: row.startedAt,
    completed_at: row.completedAt,
    details_url: row.detailsUrl,
    output: { summary: row.summary },
    app: { name: row.appName },
  }
}

function statusJson(row: StatusRow): JsonValue {
  return {
    id: 7000 + row.seq,
    context: row.context,
    state: row.state,
    target_url: row.targetUrl,
    description: row.description,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

const WORKFLOW_DIR = '.github/workflows/'

// A workflow is a YAML file directly under .github/workflows; GitHub reads
// no subdirectory there.
function isWorkflowFile(path: string): boolean {
  const rest = path.slice(WORKFLOW_DIR.length)
  return path.startsWith(WORKFLOW_DIR) && !rest.includes('/') && /\.ya?ml$/.test(rest)
}

// The parsed document, or null for a file that is not YAML. GitHub still
// lists such a file, so it is not an error here either.
function workflowDocument(data: Buffer): Record<string, unknown> | null {
  let doc: unknown
  try {
    doc = yamlLoad(data.toString('utf8'))
  } catch (err) {
    if (err instanceof YAMLException) return null
    throw err
  }
  return typeof doc === 'object' && doc !== null && !Array.isArray(doc)
    ? (doc as Record<string, unknown>)
    : null
}

// The file's own `name`, or its path when it names none, which is how GitHub
// shows an unnamed workflow.
function workflowName(path: string, data: Buffer): string {
  const name = workflowDocument(data)?.name
  return typeof name === 'string' && name !== '' ? name : path
}

// Whether the file's `on` lists `workflow_dispatch`, in any of the three
// spellings the key takes: one event, a list, or a map of events.
function dispatchable(data: Buffer): boolean {
  const on = workflowDocument(data)?.on
  if (typeof on === 'string') return on === 'workflow_dispatch'
  if (Array.isArray(on)) return on.includes('workflow_dispatch')
  return typeof on === 'object' && on !== null && 'workflow_dispatch' in on
}

async function nextWorkflowId(db: C, tenant: string): Promise<number> {
  const top = await db.githubWorkflow.findFirst({ where: scope(tenant), orderBy: { id: 'desc' } })
  return Math.max(top?.id ?? 0, 100) + 1
}

/**
 * A repository's workflows: one per workflow file on its default branch, which
 * is what GitHub builds the list from, in id order as GitHub lists them. A file
 * the fake has not seen before is registered with the next id, and keeps that
 * id and its state for as long as its row stands; a fixture states a row to
 * pin either. A row whose file is gone is not listed and cannot be dispatched.
 *
 * Registering writes, so every route that reads the list is a write route: two
 * concurrent reads would otherwise mint two ids for one file.
 */
export async function workflowsOf(db: C, tenant: string, repo: RepoRow): Promise<Workflow[]> {
  const files: Tree = await treeOfBranch(db, tenant, repo, repo.defaultBranch)
  const rows = (await db.githubWorkflow.findMany({
    where: { ...scope(tenant), repo: repo.fullName },
  })) as WorkflowRow[]
  const known = new Map(rows.map((row) => [row.path, row]))
  const out: Workflow[] = []
  for (const path of [...files.keys()].filter(isWorkflowFile).sort()) {
    let row = known.get(path)
    if (row === undefined) {
      const id = await nextWorkflowId(db, tenant)
      row = (await db.githubWorkflow.create({
        data: { tenant, repo: repo.fullName, id, path, state: 'active', seq: id },
      })) as WorkflowRow
    }
    const data = files.get(path) ?? Buffer.alloc(0)
    out.push({ id: row.id, path, state: row.state, name: workflowName(path, data), data })
  }
  return out.sort((a, b) => a.id - b.id)
}

// The REST routes name a workflow by its id or its file's base name, never by
// its display name: gh resolves a name to an id itself before it asks.
async function findWorkflow(ctx: Ctx<C>, repo: RepoRow, value: string): Promise<Workflow | null> {
  const rows = await workflowsOf(ctx.db, ctx.tenant, repo)
  const match = rows.find(
    (r) => value === String(r.id) || value === r.path.slice(r.path.lastIndexOf('/') + 1),
  )
  return match ?? null
}

export async function findWorkflowRow(
  ctx: Ctx<C>,
  repo: RepoRow,
  value: string,
): Promise<Workflow | null> {
  return findWorkflow(ctx, repo, value)
}

export async function runRow(ctx: Ctx<C>, repo: RepoRow, id: number): Promise<RunRow | null> {
  return (await ctx.db.githubRun.findFirst({
    where: { ...scope(ctx.tenant), repo: repo.fullName, id },
  })) as RunRow | null
}

// Runs come back newest first, which is where a dispatch inserts itself.
async function runRows(ctx: Ctx<C>, repo: RepoRow): Promise<RunRow[]> {
  return (await ctx.db.githubRun.findMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName },
    orderBy: { seq: 'desc' },
  })) as RunRow[]
}

async function runById(ctx: Ctx<C>, repo: RepoRow, id: number): Promise<RunRow | null> {
  return (await ctx.db.githubRun.findFirst({
    where: { ...scope(ctx.tenant), repo: repo.fullName, id },
  })) as RunRow | null
}

async function topSeq(ctx: Ctx<C>, repo: RepoRow): Promise<number> {
  const row = await ctx.db.githubRun.findFirst({
    where: { ...scope(ctx.tenant), repo: repo.fullName },
    orderBy: { seq: 'desc' },
  })
  return row === null ? -1 : row.seq
}

async function listWorkflows(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const rows = await workflowsOf(ctx.db, ctx.tenant, repo)
  return pagedReply(ctx, rows.map(workflowJson), 'workflows')
}

async function getWorkflow(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await findWorkflow(ctx, repo, param(ctx, 'workflow'))
  return row === null ? fail(404, 'Not Found') : { status: 200, body: workflowJson(row) }
}

// A dispatch answers 204 with no body, and the run it queues is what the
// caller polls for afterwards. It runs the workflow as the ref holds it, on
// that ref's head, and only an enabled workflow whose `on` lists
// `workflow_dispatch` can be run this way.
async function dispatchWorkflow(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const workflow = await findWorkflow(ctx, repo, param(ctx, 'workflow'))
  if (workflow === null) return fail(404, 'Not Found')
  const ref = str(jsonBodyOf(ctx), 'ref')
  if (ref === '') return fail(422, 'No ref found')
  const branch = await branchFor(ctx.db, ctx.tenant, repo, ref)
  if (branch === null) return fail(422, `No ref found for: ${ref}`)
  if (workflow.state !== 'active') {
    return fail(422, "Cannot trigger a 'workflow_dispatch' on a disabled workflow")
  }
  const file = (await treeOfBranch(ctx.db, ctx.tenant, repo, branch)).get(workflow.path)
  if (file === undefined || !dispatchable(file)) {
    return fail(422, "Workflow does not have 'workflow_dispatch' trigger")
  }
  const rows = await runRows(ctx, repo)
  const id = 201 + rows.length
  await ctx.db.githubRun.create({
    data: {
      tenant: ctx.tenant,
      repo: repo.fullName,
      id,
      name: workflow.name,
      displayTitle: `${workflow.name} dispatch`,
      workflowId: workflow.id,
      runNumber: rows.length + 1,
      runAttempt: 1,
      event: 'workflow_dispatch',
      headBranch: branch,
      headSha: await visibleHeadOf(ctx.db, ctx.tenant, repo, branch),
      status: 'queued',
      conclusion: null,
      createdAt: DISPATCHED_AT,
      updatedAt: DISPATCHED_AT,
      runStartedAt: null,
      seq: (await topSeq(ctx, repo)) + 1,
    },
  })
  return { status: 204 }
}

async function listRuns(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  let rows = await runRows(ctx, repo)
  const named = param(ctx, 'workflow')
  if (named !== '') {
    const workflow = await findWorkflow(ctx, repo, named)
    if (workflow === null) return fail(404, 'Not Found')
    rows = rows.filter((r) => r.workflowId === workflow.id)
  }
  const filters: Array<[string, (r: RunRow) => string]> = [
    ['branch', (r) => r.headBranch],
    ['head_sha', (r) => r.headSha],
    ['event', (r) => r.event],
    ['status', (r) => r.status],
  ]
  for (const [key, read] of filters) {
    const value = ctx.query.get(key) ?? ''
    if (value !== '') rows = rows.filter((r) => read(r) === value)
  }
  return pagedReply(
    ctx,
    rows.map((r) => runJson(repo, r)),
    'workflow_runs',
  )
}

function idParam(ctx: Ctx<C>, name: string): number | null {
  const raw = param(ctx, name)
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null
}

async function getRun(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const id = idParam(ctx, 'run_id')
  const row = id === null ? null : await runById(ctx, repo, id)
  return row === null ? fail(404, 'Not Found') : { status: 200, body: runJson(repo, row) }
}

function jobsOf(run: RunRow): Job[] {
  const parsed = JSON.parse(run.jobsJson) as unknown
  return Array.isArray(parsed) ? (parsed as Job[]) : []
}

function jobJson(repo: RepoRow, run: RunRow, job: Job): JsonValue {
  return {
    id: job.id,
    run_id: run.id,
    run_attempt: run.runAttempt,
    workflow_name: run.name,
    head_branch: run.headBranch,
    head_sha: run.headSha,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    html_url: `https://github.com/${repo.fullName}/actions/runs/${String(run.id)}/job/${String(job.id)}`,
    steps: job.steps.map((step) => ({
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      number: step.number,
      started_at: step.started_at,
      completed_at: step.completed_at,
    })),
  }
}

async function listJobs(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const id = idParam(ctx, 'run_id')
  const run = id === null ? null : await runById(ctx, repo, id)
  if (run === null) return fail(404, 'Not Found')
  return pagedReply(
    ctx,
    jobsOf(run).map((job) => jobJson(repo, run, job)),
    'jobs',
  )
}

async function getJob(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const id = idParam(ctx, 'job_id')
  for (const run of await runRows(ctx, repo)) {
    const job = jobsOf(run).find((each) => each.id === id)
    if (job !== undefined) return { status: 200, body: jobJson(repo, run, job) }
  }
  return fail(404, 'Not Found')
}

function jobLog(job: Job): Buffer {
  return Buffer.from(job.steps.map((step) => step.log).join(''), 'utf8')
}

// A job's name as the archive spells it: the vendor drops the characters a
// path cannot hold, and gh matches entries by that spelling.
function logName(name: string): string {
  return name.replace(/[/:]/g, '').trim()
}

// A run's logs as the vendor ships them, one archive: each job's whole log at
// the top as `<ordinal>_<job>.txt`, and each step's under the job's own
// directory as `<job>/<number>_<step>.txt`. Only a completed run has one.
async function runLogs(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const id = idParam(ctx, 'run_id')
  const run = id === null ? null : await runById(ctx, repo, id)
  if (run === null || run.status !== 'completed') return fail(404, 'Not Found')
  const entries: Array<[string, Buffer]> = []
  jobsOf(run).forEach((job, ordinal) => {
    entries.push([`${String(ordinal)}_${logName(job.name)}.txt`, jobLog(job)])
    for (const step of job.steps) {
      const file = `${logName(job.name)}/${String(step.number)}_${logName(step.name)}.txt`
      entries.push([file, Buffer.from(step.log, 'utf8')])
    }
  })
  return {
    status: 200,
    body: storedZip(entries),
    headers: { 'Content-Type': 'application/zip' },
  }
}

// One job's whole log, plain text, which is where gh turns when the archive
// holds no entry for a job.
async function jobLogs(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const id = idParam(ctx, 'job_id')
  for (const run of await runRows(ctx, repo)) {
    const job = jobsOf(run).find((each) => each.id === id)
    if (job !== undefined && run.status === 'completed') {
      return { status: 200, body: jobLog(job), headers: { 'Content-Type': 'text/plain' } }
    }
  }
  return fail(404, 'Not Found')
}

// The archive's entries fixed at 1980-01-01, the zip epoch, so the bytes a
// golden could pin never move.
const ZIP_EPOCH_DATE = 0x21

// A zip holding `entries` uncompressed: local headers, the central directory
// and its end record, with UTF-8 names.
function storedZip(entries: Array<[string, Buffer]>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, data] of entries) {
    const path = Buffer.from(name, 'utf8')
    const sum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(ZIP_EPOCH_DATE, 12)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(path.length, 26)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0x0800, 8)
    head.writeUInt16LE(ZIP_EPOCH_DATE, 14)
    head.writeUInt32LE(sum, 16)
    head.writeUInt32LE(data.length, 20)
    head.writeUInt32LE(data.length, 24)
    head.writeUInt16LE(path.length, 28)
    head.writeUInt32LE(offset, 42)
    parts.push(local, path, data)
    central.push(head, path)
    offset += local.length + path.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

// Rerunning queues the run again under a new attempt. A job id names a job the
// fake does not model, so that spelling is accepted and changes nothing rather
// than 404ing on a job the caller can see in a run it just read.
async function rerun(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const byJob = param(ctx, 'job_id') !== ''
  const id = idParam(ctx, 'run_id')
  const row = id === null ? null : await runById(ctx, repo, id)
  if (row === null) return byJob ? { status: 201, body: {} } : fail(404, 'Not Found')
  await ctx.db.githubRun.updateMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName, id: row.id },
    data: { runAttempt: row.runAttempt + 1, status: 'queued', conclusion: null },
  })
  return { status: 201, body: {} }
}

// The commit a `commits/{ref}/...` route names: a branch's head, a tag's
// commit, or a commit by its sha. Null for a ref that names none.
async function namedCommit(ctx: Ctx<C>, repo: RepoRow): Promise<string | null> {
  return (await resolveRef(ctx.db, ctx.tenant, repo, param(ctx, 'sha')))?.history[0]?.sha ?? null
}

function noCommit(ctx: Ctx<C>): Reply {
  return fail(422, `No commit found for SHA: ${param(ctx, 'sha')}`)
}

// A commit's check runs, which belong to the commit they ran on, as a
// fixture states them. The fake runs no checks of its own.
async function checkRuns(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const sha = await namedCommit(ctx, repo)
  if (sha === null) return noCommit(ctx)
  const rows = (await ctx.db.githubCheck.findMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName, sha },
    orderBy: { seq: 'asc' },
  })) as CheckRow[]
  return pagedReply(ctx, rows.map(checkJson), 'check_runs')
}

/**
 * Every status set on one commit in the repositories named, newest first: one
 * repository's own for its REST routes, and both sides of a pull request from
 * a fork for its rollup, whose head commit's CI may have reported to either.
 * A repository counts its own `seq`, so the order they were set in across two
 * repositories is the table's.
 */
export async function statusesOf(
  ctx: { db: C; tenant: string },
  repos: RepoRow[],
  sha: string,
): Promise<StatusRow[]> {
  return (await ctx.db.githubStatus.findMany({
    where: { ...scope(ctx.tenant), repo: { in: repos.map((r) => r.fullName) }, sha },
    orderBy: { pk: 'desc' },
  })) as StatusRow[]
}

// The rolled-up state of a commit's statuses: the newest of each context,
// failure winning over pending, which wins over success, and no statuses at
// all reading as pending rather than as a pass, as GitHub rolls them up.
export async function combinedStatus(
  ctx: { db: C; tenant: string },
  repos: RepoRow[],
  sha: string,
): Promise<{ state: string; rows: StatusRow[] }> {
  const latest = new Map<string, StatusRow>()
  for (const row of await statusesOf(ctx, repos, sha)) {
    if (!latest.has(row.context)) latest.set(row.context, row)
  }
  const rows = [...latest.values()].reverse()
  const states = new Set(rows.map((r) => r.state))
  let state = 'success'
  if (states.has('error') || states.has('failure')) state = 'failure'
  else if (rows.length === 0 || states.has('pending')) state = 'pending'
  return { state, rows }
}

async function commitStatus(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const sha = await namedCommit(ctx, repo)
  if (sha === null) return noCommit(ctx)
  const { state, rows } = await combinedStatus(ctx, [repo], sha)
  return {
    status: 200,
    body: { state, sha, total_count: rows.length, statuses: rows.map(statusJson) },
  }
}

async function listStatuses(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const sha = await namedCommit(ctx, repo)
  if (sha === null) return noCommit(ctx)
  return pagedReply(ctx, (await statusesOf(ctx, [repo], sha)).map(statusJson))
}

const STATUS_STATES = ['error', 'failure', 'pending', 'success']

// A status is set on one commit and stays with it, whatever the branch does
// after. A second status in the same context supersedes the first in the
// rollup, and both stay listed, as on GitHub.
async function createStatus(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const sha = await namedCommit(ctx, repo)
  if (sha === null) return noCommit(ctx)
  const body = jsonBodyOf(ctx)
  const state = str(body, 'state')
  if (!STATUS_STATES.includes(state)) return fail(422, 'Validation Failed')
  const seq = await ctx.db.githubStatus.count({
    where: { ...scope(ctx.tenant), repo: repo.fullName },
  })
  const row: StatusRow = {
    context: str(body, 'context') || 'default',
    state,
    targetUrl: str(body, 'target_url'),
    description: str(body, 'description'),
    createdAt: WRITE_COMMIT_DATE,
    updatedAt: WRITE_COMMIT_DATE,
    sha,
    seq,
  }
  await ctx.db.githubStatus.create({ data: { tenant: ctx.tenant, repo: repo.fullName, ...row } })
  return {
    status: 201,
    body: { ...(statusJson(row) as Record<string, JsonValue>), creator: { login: DEFAULT_LOGIN } },
  }
}

export function actionRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => {
    const actions = `${p}/repos/:owner/:repo/actions`
    return [
      // Reading the list registers any workflow file not seen before, so
      // every route that reads it is serialized as a write.
      route<C>('GET', `${actions}/workflows`, authedRoute(withRepo(listWorkflows)), {
        write: true,
      }),
      route<C>('GET', `${actions}/workflows/:workflow`, authedRoute(withRepo(getWorkflow)), {
        write: true,
      }),
      route<C>(
        'POST',
        `${actions}/workflows/:workflow/dispatches`,
        authedRoute(withRepo(dispatchWorkflow)),
        { write: true },
      ),
      route<C>('GET', `${actions}/workflows/:workflow/runs`, authedRoute(withRepo(listRuns)), {
        write: true,
      }),
      route<C>('GET', `${actions}/runs`, authedRoute(withRepo(listRuns))),
      route<C>('GET', `${actions}/runs/:run_id`, authedRoute(withRepo(getRun))),
      route<C>('GET', `${actions}/runs/:run_id/jobs`, authedRoute(withRepo(listJobs))),
      route<C>('GET', `${actions}/runs/:run_id/logs`, authedRoute(withRepo(runLogs))),
      route<C>('GET', `${actions}/jobs/:job_id`, authedRoute(withRepo(getJob))),
      route<C>('GET', `${actions}/jobs/:job_id/logs`, authedRoute(withRepo(jobLogs))),
      route<C>('POST', `${actions}/runs/:run_id/rerun`, authedRoute(withRepo(rerun)), {
        write: true,
      }),
      route<C>('POST', `${actions}/runs/:run_id/rerun-failed-jobs`, authedRoute(withRepo(rerun)), {
        write: true,
      }),
      route<C>('POST', `${actions}/jobs/:job_id/rerun`, authedRoute(withRepo(rerun)), {
        write: true,
      }),
      route<C>(
        'GET',
        `${p}/repos/:owner/:repo/commits/:sha/check-runs`,
        authedRoute(withRepo(checkRuns)),
      ),
      route<C>(
        'GET',
        `${p}/repos/:owner/:repo/commits/:sha/status`,
        authedRoute(withRepo(commitStatus)),
      ),
      route<C>(
        'GET',
        `${p}/repos/:owner/:repo/commits/:sha/statuses`,
        authedRoute(withRepo(listStatuses)),
      ),
      route<C>(
        'POST',
        `${p}/repos/:owner/:repo/statuses/:sha`,
        authedRoute(withRepo(createStatus)),
        {
          write: true,
        },
      ),
      // A check run is an app's to create; a personal token is refused, as
      // GitHub refuses it.
      route<C>(
        'POST',
        `${p}/repos/:owner/:repo/check-runs`,
        authedRoute(withRepo(() => fail(403, 'You must authenticate via a GitHub App.'))),
        { write: true },
      ),
    ]
  })
}
