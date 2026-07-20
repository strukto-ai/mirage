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

import type { LinearAccessor } from '../../../accessor/linear.ts'
import {
  getIssue,
  listIssueComments,
  listTeamCycles,
  listTeamDocuments,
  listTeamIssues,
  listTeamLabels,
  listTeamMembers,
  listTeamProjects,
  listTeams,
  resolveIssueId,
  resolveTeam,
  searchIssues,
  type LinearTransport,
} from '../../../core/linear/_client.ts'
import {
  buildProjectIssue,
  normalizeComment,
  normalizeCycle,
  normalizeDocument,
  normalizeIssue,
  normalizeLabel,
  normalizeProject,
  normalizeTeam,
  normalizeUser,
  toJsonBytes,
  type NormalizedProjectIssue,
} from '../../../core/linear/normalize.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { enoent } from '../../../utils/errors.ts'
import {
  command,
  type CommandFnResult,
  type CommandOpts,
  type RegisteredCommand,
} from '../../config.ts'
import { CommandSpec, OperandKind, Operand, Option } from '../../spec/types.ts'

const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/

type Runner = (accessor: LinearAccessor, texts: string[], opts: CommandOpts) => Promise<Uint8Array>

interface LinearRead {
  name: string
  runner: Runner
  spec: CommandSpec
}

const SPEC_NONE = new CommandSpec({})
const SPEC_ARG = new CommandSpec({ rest: new Operand({ kind: OperandKind.TEXT }) })
const SPEC_TEAM = new CommandSpec({
  options: [new Option({ long: '--team', valueKind: OperandKind.TEXT })],
})
const SPEC_TEAM_ARG = new CommandSpec({
  options: [new Option({ long: '--team', valueKind: OperandKind.TEXT })],
  rest: new Operand({ kind: OperandKind.TEXT }),
})
const SEARCH_SPEC = new CommandSpec({
  options: [new Option({ long: '--query', valueKind: OperandKind.TEXT })],
  rest: new Operand({ kind: OperandKind.TEXT }),
})

function first(texts: string[], label: string): string {
  const value = texts[0]
  if (value === undefined || value === '') throw new Error(`${label} is required`)
  return value
}

function requireTeam(opts: CommandOpts): string {
  const team = opts.flags.team
  if (typeof team !== 'string' || team === '') throw new Error('--team is required')
  return team
}

async function resolveIssue(transport: LinearTransport, token: string): Promise<string> {
  if (ISSUE_KEY_RE.test(token)) return resolveIssueId(transport, null, token)
  return token
}

async function teamProjectRows(
  transport: LinearTransport,
  teamId: string,
  projectId: string,
): Promise<NormalizedProjectIssue[]> {
  const teamIssues = await listTeamIssues(transport, teamId)
  const rows: NormalizedProjectIssue[] = []
  for (const issue of teamIssues) {
    const proj = issue.project
    const projObj =
      proj !== null && typeof proj === 'object' ? (proj as Record<string, unknown>) : {}
    if (projObj.id !== projectId) continue
    rows.push(buildProjectIssue(issue))
  }
  return rows
}

function teamStr(team: Record<string, unknown>, key: string): string | null {
  const value = team[key]
  return typeof value === 'string' ? value : null
}

async function allUsers(transport: LinearTransport): Promise<Record<string, unknown>[]> {
  const teams = await listTeams(transport)
  const seen = new Set<string>()
  const users: Record<string, unknown>[] = []
  for (const team of teams) {
    const teamId = typeof team.id === 'string' ? team.id : ''
    for (const user of await listTeamMembers(transport, teamId)) {
      const uid = user.id
      if (typeof uid !== 'string' || seen.has(uid)) continue
      seen.add(uid)
      users.push(user)
    }
  }
  return users
}

async function runTeamList(accessor: LinearAccessor): Promise<Uint8Array> {
  const teams = await listTeams(accessor.transport)
  return toJsonBytes(teams.map((team) => normalizeTeam(team)))
}

async function runTeamGet(accessor: LinearAccessor, texts: string[]): Promise<Uint8Array> {
  const team = await resolveTeam(accessor.transport, first(texts, 'team key'))
  return toJsonBytes(normalizeTeam(team))
}

async function runTeamMembers(accessor: LinearAccessor, texts: string[]): Promise<Uint8Array> {
  const team = await resolveTeam(accessor.transport, first(texts, 'team key'))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const users = await listTeamMembers(accessor.transport, teamId)
  return toJsonBytes(users.map((user) => normalizeUser(user)))
}

async function runIssueList(
  accessor: LinearAccessor,
  _texts: string[],
  opts: CommandOpts,
): Promise<Uint8Array> {
  const team = await resolveTeam(accessor.transport, requireTeam(opts))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const issues = await listTeamIssues(accessor.transport, teamId)
  return toJsonBytes(issues.map((issue) => normalizeIssue(issue)))
}

async function runIssueGet(accessor: LinearAccessor, texts: string[]): Promise<Uint8Array> {
  const issueId = await resolveIssue(accessor.transport, first(texts, 'issue key'))
  const issue = await getIssue(accessor.transport, issueId)
  return toJsonBytes(normalizeIssue(issue))
}

async function runProjectList(
  accessor: LinearAccessor,
  _texts: string[],
  opts: CommandOpts,
): Promise<Uint8Array> {
  const team = await resolveTeam(accessor.transport, requireTeam(opts))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const projects = await listTeamProjects(accessor.transport, teamId)
  const payload = []
  for (const project of projects) {
    const projectId = typeof project.id === 'string' ? project.id : ''
    const rows = await teamProjectRows(accessor.transport, teamId, projectId)
    payload.push(
      normalizeProject(project, {
        teamId,
        teamKey: teamStr(team, 'key'),
        teamName: teamStr(team, 'name'),
        issues: rows,
      }),
    )
  }
  return toJsonBytes(payload)
}

async function runProjectGet(
  accessor: LinearAccessor,
  texts: string[],
  opts: CommandOpts,
): Promise<Uint8Array> {
  const team = await resolveTeam(accessor.transport, requireTeam(opts))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const projectId = first(texts, 'project id')
  const projects = await listTeamProjects(accessor.transport, teamId)
  for (const project of projects) {
    if (project.id === projectId) {
      const rows = await teamProjectRows(accessor.transport, teamId, projectId)
      return toJsonBytes(
        normalizeProject(project, {
          teamId,
          teamKey: teamStr(team, 'key'),
          teamName: teamStr(team, 'name'),
          issues: rows,
        }),
      )
    }
  }
  throw enoent(projectId)
}

async function runCycleList(
  accessor: LinearAccessor,
  _texts: string[],
  opts: CommandOpts,
): Promise<Uint8Array> {
  const team = await resolveTeam(accessor.transport, requireTeam(opts))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const cycles = await listTeamCycles(accessor.transport, teamId)
  return toJsonBytes(cycles.map((cycle) => normalizeCycle(cycle, teamId)))
}

async function runCycleCurrent(
  accessor: LinearAccessor,
  _texts: string[],
  opts: CommandOpts,
): Promise<Uint8Array> {
  const team = await resolveTeam(accessor.transport, requireTeam(opts))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const cycles = await listTeamCycles(accessor.transport, teamId)
  let current: Record<string, unknown> | undefined
  for (const cycle of cycles) {
    if (current === undefined) {
      current = cycle
      continue
    }
    const a = typeof cycle.number === 'number' ? cycle.number : 0
    const b = typeof current.number === 'number' ? current.number : 0
    if (a > b) current = cycle
  }
  if (current === undefined) throw enoent('cycles')
  return toJsonBytes(normalizeCycle(current, teamId))
}

async function runCycleGet(
  accessor: LinearAccessor,
  texts: string[],
  opts: CommandOpts,
): Promise<Uint8Array> {
  const team = await resolveTeam(accessor.transport, requireTeam(opts))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const cycleId = first(texts, 'cycle id')
  const cycles = await listTeamCycles(accessor.transport, teamId)
  for (const cycle of cycles) {
    if (cycle.id === cycleId) return toJsonBytes(normalizeCycle(cycle, teamId))
  }
  throw enoent(cycleId)
}

async function runLabelList(
  accessor: LinearAccessor,
  _texts: string[],
  opts: CommandOpts,
): Promise<Uint8Array> {
  const team = await resolveTeam(accessor.transport, requireTeam(opts))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const labels = await listTeamLabels(accessor.transport, teamId)
  return toJsonBytes(labels.map((label) => normalizeLabel(label)))
}

async function runCommentList(accessor: LinearAccessor, texts: string[]): Promise<Uint8Array> {
  const issueId = await resolveIssue(accessor.transport, first(texts, 'issue key'))
  const issue = await getIssue(accessor.transport, issueId)
  const issueKey = typeof issue.identifier === 'string' ? issue.identifier : null
  const comments = await listIssueComments(accessor.transport, issueId)
  return toJsonBytes(comments.map((comment) => normalizeComment(comment, issueId, issueKey)))
}

async function runUserList(accessor: LinearAccessor): Promise<Uint8Array> {
  const users = await allUsers(accessor.transport)
  return toJsonBytes(users.map((user) => normalizeUser(user)))
}

async function runUserGet(accessor: LinearAccessor, texts: string[]): Promise<Uint8Array> {
  const email = first(texts, 'user email')
  for (const user of await allUsers(accessor.transport)) {
    if (user.email === email) return toJsonBytes(normalizeUser(user))
  }
  throw enoent(email)
}

async function runDocumentList(
  accessor: LinearAccessor,
  _texts: string[],
  opts: CommandOpts,
): Promise<Uint8Array> {
  const team = await resolveTeam(accessor.transport, requireTeam(opts))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const documents = await listTeamDocuments(accessor.transport, teamId)
  return toJsonBytes(documents.map((document) => normalizeDocument(document)))
}

async function runDocumentGet(
  accessor: LinearAccessor,
  texts: string[],
  opts: CommandOpts,
): Promise<Uint8Array> {
  const team = await resolveTeam(accessor.transport, requireTeam(opts))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const documentId = first(texts, 'document id')
  const documents = await listTeamDocuments(accessor.transport, teamId)
  for (const document of documents) {
    if (document.id === documentId) return toJsonBytes(normalizeDocument(document))
  }
  throw enoent(documentId)
}

async function runSearch(
  accessor: LinearAccessor,
  texts: string[],
  opts: CommandOpts,
): Promise<Uint8Array> {
  const flagQuery = typeof opts.flags.query === 'string' ? opts.flags.query : null
  const query = flagQuery ?? texts[0] ?? null
  if (query === null || query === '') throw new Error('a search query is required')
  const results = await searchIssues(accessor.transport, query)
  return toJsonBytes(results)
}

const LINEAR_READS: readonly LinearRead[] = [
  { name: 'linear team list', runner: (a) => runTeamList(a), spec: SPEC_NONE },
  { name: 'linear team get', runner: (a, t) => runTeamGet(a, t), spec: SPEC_ARG },
  { name: 'linear team members', runner: (a, t) => runTeamMembers(a, t), spec: SPEC_ARG },
  { name: 'linear issue list', runner: (a, t, o) => runIssueList(a, t, o), spec: SPEC_TEAM },
  { name: 'linear issue get', runner: (a, t) => runIssueGet(a, t), spec: SPEC_ARG },
  { name: 'linear project list', runner: (a, t, o) => runProjectList(a, t, o), spec: SPEC_TEAM },
  { name: 'linear project get', runner: (a, t, o) => runProjectGet(a, t, o), spec: SPEC_TEAM_ARG },
  { name: 'linear cycle list', runner: (a, t, o) => runCycleList(a, t, o), spec: SPEC_TEAM },
  { name: 'linear cycle current', runner: (a, t, o) => runCycleCurrent(a, t, o), spec: SPEC_TEAM },
  { name: 'linear cycle get', runner: (a, t, o) => runCycleGet(a, t, o), spec: SPEC_TEAM_ARG },
  { name: 'linear label list', runner: (a, t, o) => runLabelList(a, t, o), spec: SPEC_TEAM },
  { name: 'linear comment list', runner: (a, t) => runCommentList(a, t), spec: SPEC_ARG },
  { name: 'linear user list', runner: (a) => runUserList(a), spec: SPEC_NONE },
  { name: 'linear user get', runner: (a, t) => runUserGet(a, t), spec: SPEC_ARG },
  { name: 'linear document list', runner: (a, t, o) => runDocumentList(a, t, o), spec: SPEC_TEAM },
  {
    name: 'linear document get',
    runner: (a, t, o) => runDocumentGet(a, t, o),
    spec: SPEC_TEAM_ARG,
  },
  { name: 'linear search', runner: (a, t, o) => runSearch(a, t, o), spec: SEARCH_SPEC },
]

export function makeLinearReadCommands(): RegisteredCommand[] {
  const commands: RegisteredCommand[] = []
  for (const entry of LINEAR_READS) {
    commands.push(
      ...command({
        name: entry.name,
        resource: ResourceName.LINEAR,
        spec: entry.spec,
        fn: async (
          accessor,
          _paths: PathSpec[],
          texts: string[],
          opts: CommandOpts,
        ): Promise<CommandFnResult> => {
          const data = await entry.runner(accessor as LinearAccessor, texts, opts)
          return [data, new IOResult()]
        },
      }),
    )
  }
  return commands
}
