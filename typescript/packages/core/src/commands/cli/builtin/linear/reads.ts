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
  resolveTeam,
  searchIssues,
  type LinearTransport,
} from '../../../../core/linear/_client.ts'
import type { LinearConfig } from '../../../../core/linear/config.ts'
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
} from '../../../../core/linear/normalize.ts'
import { FlagView } from '../../../spec/types.ts'
import { IOResult } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import { enoent } from '../../../../utils/errors.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIVerbOpts } from '../../types.ts'
import { firstText, linearTransport, resolveIssue } from './util.ts'

function requireTeam(fl: FlagView): string {
  const team = fl.asStr('team')
  if (team === undefined || team === '') throw new Error('--team is required')
  return team
}

function teamStr(team: Record<string, unknown>, key: string): string | null {
  const value = team[key]
  return typeof value === 'string' ? value : null
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

export async function teamList(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  _opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const cfg = config as LinearConfig
  let teams = await listTeams(linearTransport(config))
  if (cfg.teamIds !== undefined && cfg.teamIds.length > 0) {
    const keep = new Set(cfg.teamIds)
    teams = teams.filter((team) => typeof team.id === 'string' && keep.has(team.id))
  }
  return [toJsonBytes(teams.map((team) => normalizeTeam(team))), new IOResult()]
}

export async function teamGet(
  config: unknown,
  _paths: PathSpec[],
  texts: string[],
  _opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const team = await resolveTeam(linearTransport(config), firstText(texts, 'team key'))
  return [toJsonBytes(normalizeTeam(team)), new IOResult()]
}

export async function teamMembers(
  config: unknown,
  _paths: PathSpec[],
  texts: string[],
  _opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const transport = linearTransport(config)
  const team = await resolveTeam(transport, firstText(texts, 'team key'))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const users = await listTeamMembers(transport, teamId)
  return [toJsonBytes(users.map((user) => normalizeUser(user))), new IOResult()]
}

export async function issueList(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const transport = linearTransport(config)
  const team = await resolveTeam(transport, requireTeam(new FlagView(opts.flags)))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const issues = await listTeamIssues(transport, teamId)
  return [toJsonBytes(issues.map((issue) => normalizeIssue(issue))), new IOResult()]
}

export async function issueGet(
  config: unknown,
  _paths: PathSpec[],
  texts: string[],
  _opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const transport = linearTransport(config)
  const issueId = await resolveIssue(transport, firstText(texts, 'issue key'))
  const issue = await getIssue(transport, issueId)
  return [toJsonBytes(normalizeIssue(issue)), new IOResult()]
}

export async function projectList(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const transport = linearTransport(config)
  const team = await resolveTeam(transport, requireTeam(new FlagView(opts.flags)))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const projects = await listTeamProjects(transport, teamId)
  const payload = []
  for (const project of projects) {
    const projectId = typeof project.id === 'string' ? project.id : ''
    const rows = await teamProjectRows(transport, teamId, projectId)
    payload.push(
      normalizeProject(project, {
        teamId,
        teamKey: teamStr(team, 'key'),
        teamName: teamStr(team, 'name'),
        issues: rows,
      }),
    )
  }
  return [toJsonBytes(payload), new IOResult()]
}

export async function projectGet(
  config: unknown,
  _paths: PathSpec[],
  texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const transport = linearTransport(config)
  const team = await resolveTeam(transport, requireTeam(new FlagView(opts.flags)))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const projectId = firstText(texts, 'project id')
  const projects = await listTeamProjects(transport, teamId)
  for (const project of projects) {
    if (project.id === projectId) {
      const rows = await teamProjectRows(transport, teamId, projectId)
      return [
        toJsonBytes(
          normalizeProject(project, {
            teamId,
            teamKey: teamStr(team, 'key'),
            teamName: teamStr(team, 'name'),
            issues: rows,
          }),
        ),
        new IOResult(),
      ]
    }
  }
  throw enoent(projectId)
}

export async function cycleList(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const transport = linearTransport(config)
  const team = await resolveTeam(transport, requireTeam(new FlagView(opts.flags)))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const cycles = await listTeamCycles(transport, teamId)
  return [toJsonBytes(cycles.map((cycle) => normalizeCycle(cycle, teamId))), new IOResult()]
}

export async function cycleCurrent(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const transport = linearTransport(config)
  const team = await resolveTeam(transport, requireTeam(new FlagView(opts.flags)))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const cycles = await listTeamCycles(transport, teamId)
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
  return [toJsonBytes(normalizeCycle(current, teamId)), new IOResult()]
}

export async function cycleGet(
  config: unknown,
  _paths: PathSpec[],
  texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const transport = linearTransport(config)
  const team = await resolveTeam(transport, requireTeam(new FlagView(opts.flags)))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const cycleId = firstText(texts, 'cycle id')
  const cycles = await listTeamCycles(transport, teamId)
  for (const cycle of cycles) {
    if (cycle.id === cycleId) return [toJsonBytes(normalizeCycle(cycle, teamId)), new IOResult()]
  }
  throw enoent(cycleId)
}

export async function labelList(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const transport = linearTransport(config)
  const team = await resolveTeam(transport, requireTeam(new FlagView(opts.flags)))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const labels = await listTeamLabels(transport, teamId)
  return [toJsonBytes(labels.map((label) => normalizeLabel(label))), new IOResult()]
}

export async function commentList(
  config: unknown,
  _paths: PathSpec[],
  texts: string[],
  _opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const transport = linearTransport(config)
  const issueId = await resolveIssue(transport, firstText(texts, 'issue key'))
  const issue = await getIssue(transport, issueId)
  const issueKey = typeof issue.identifier === 'string' ? issue.identifier : null
  const comments = await listIssueComments(transport, issueId)
  return [
    toJsonBytes(comments.map((comment) => normalizeComment(comment, issueId, issueKey))),
    new IOResult(),
  ]
}

export async function userList(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  _opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const users = await allUsers(linearTransport(config))
  return [toJsonBytes(users.map((user) => normalizeUser(user))), new IOResult()]
}

export async function userGet(
  config: unknown,
  _paths: PathSpec[],
  texts: string[],
  _opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const email = firstText(texts, 'user email')
  for (const user of await allUsers(linearTransport(config))) {
    if (user.email === email) return [toJsonBytes(normalizeUser(user)), new IOResult()]
  }
  throw enoent(email)
}

export async function documentList(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const transport = linearTransport(config)
  const team = await resolveTeam(transport, requireTeam(new FlagView(opts.flags)))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const documents = await listTeamDocuments(transport, teamId)
  return [toJsonBytes(documents.map((document) => normalizeDocument(document))), new IOResult()]
}

export async function documentGet(
  config: unknown,
  _paths: PathSpec[],
  texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const transport = linearTransport(config)
  const team = await resolveTeam(transport, requireTeam(new FlagView(opts.flags)))
  const teamId = typeof team.id === 'string' ? team.id : ''
  const documentId = firstText(texts, 'document id')
  const documents = await listTeamDocuments(transport, teamId)
  for (const document of documents) {
    if (document.id === documentId)
      return [toJsonBytes(normalizeDocument(document)), new IOResult()]
  }
  throw enoent(documentId)
}

export async function search(
  config: unknown,
  _paths: PathSpec[],
  texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags)
  const flagQuery = fl.asStr('query')
  const query = flagQuery !== undefined && flagQuery !== '' ? flagQuery : (texts[0] ?? null)
  if (query === null || query === '') throw new Error('a search query is required')
  const results = await searchIssues(linearTransport(config), query)
  return [toJsonBytes(results), new IOResult()]
}
