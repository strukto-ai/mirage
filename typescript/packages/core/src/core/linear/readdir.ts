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

import type { LinearAccessor } from '../../accessor/linear.ts'
import { ContentType, FileStat, FileType } from '../../types.ts'
import { makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { entryStat } from '../hierarchy/stat.ts'
import {
  listIssueComments,
  listTeamCycles,
  listTeamDocuments,
  listTeamIssues,
  listTeamMembers,
  listTeamProjects,
  listTeams,
} from './client.ts'
import {
  buildProjectIssue,
  normalizeComment,
  normalizeCycle,
  normalizeDocument,
  normalizeIssue,
  normalizeProject,
  normalizeTeam,
  normalizeUser,
  toJsonBytes,
  type NormalizedProjectIssue,
  unsearchedText,
} from './normalize.ts'
import {
  cycleFilename,
  documentFilename,
  issueDirname,
  memberFilename,
  projectFilename,
  teamDirname,
} from './pathing.ts'
import { detectScope } from './scope.ts'
import { jsonlBytesByCreatedAt } from '../render/json.ts'
import { keptText } from '../../utils/record_search.ts'

export const TEAM_DIRS = ['members', 'issues', 'projects', 'cycles', 'documents'] as const

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function extraSize(entry: FileStat): number | null {
  const value = entry.extra.json_size
  return typeof value === 'number' ? value : null
}

function extraString(entry: FileStat, key: string): string {
  const value = entry.extra[key]
  return typeof value === 'string' ? value : ''
}

/** The teams the mount shows: all of them, or those in `teamIds`. Mirrors Python's `filtered_teams`. */
export async function filteredTeams(accessor: LinearAccessor): Promise<Record<string, unknown>[]> {
  let teams = await listTeams(accessor.transport)
  if (accessor.teamIds !== null && accessor.teamIds.length > 0) {
    const allowed = new Set(accessor.teamIds)
    teams = teams.filter((t) => allowed.has(pickString(t, 'id')))
  }
  return teams
}

export const TEAM = entryStat('team_id', FileType.DIRECTORY)
export const TEAM_JSON = entryStat('team_id', ContentType.JSON)
export const MEMBER = entryStat('member_id', ContentType.JSON)
export const ISSUE = entryStat('issue_id', FileType.DIRECTORY)
export const ISSUE_JSON = entryStat('issue_id', ContentType.JSON)
export const COMMENTS = entryStat('issue_id', ContentType.TEXT)
export const PROJECT = entryStat('project_id', ContentType.JSON)
export const CYCLE = entryStat('cycle_id', ContentType.JSON)
export const DOCUMENT = entryStat('document_id', ContentType.JSON)

async function listTeamsDir(accessor: LinearAccessor, _match: ScopeMatch): Promise<FileStat[]> {
  // team.json renders the team object this listing already fetched, so its
  // exact size rides the directory's row, and the key/name ride along for
  // the project renders below it.
  return (await filteredTeams(accessor)).map((team) =>
    TEAM(teamDirname(team), pickString(team, 'id'), {
      modified: pickString(team, 'updatedAt'),
      extra: {
        team_key: pickString(team, 'key'),
        team_name: pickString(team, 'name'),
        json_size: toJsonBytes(normalizeTeam(team)).length,
      },
    }),
  )
}

function listTeam(
  _accessor: LinearAccessor,
  match: ScopeMatch,
  entry: FileStat,
): Promise<FileStat[]> {
  const rows = [
    TEAM_JSON('team.json', match.slots.team_id ?? '', {
      size: extraSize(entry),
      modified: entry.modified,
    }),
  ]
  for (const name of TEAM_DIRS) {
    // A project render carries its team's key and name, which only the
    // team listing knows.
    const extra =
      name === 'projects'
        ? { team_key: extraString(entry, 'team_key'), team_name: extraString(entry, 'team_name') }
        : {}
    rows.push(new FileStat({ name, type: FileType.DIRECTORY, extra }))
  }
  return Promise.resolve(rows)
}

async function listMembers(
  accessor: LinearAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<FileStat[]> {
  const users = await listTeamMembers(accessor.transport, match.slots.team_id ?? '')
  return users.map((user) => {
    const rendered = toJsonBytes(normalizeUser(user))
    return MEMBER(memberFilename(user), pickString(user, 'id'), {
      size: rendered.length,
      modified: pickString(user, 'updatedAt'),
      extra: keptText(rendered),
    })
  })
}

async function listIssues(
  accessor: LinearAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<FileStat[]> {
  const issues = await listTeamIssues(accessor.transport, match.slots.team_id ?? '')
  return issues.map((issue) =>
    ISSUE(issueDirname(issue), pickString(issue, 'id'), {
      modified: pickString(issue, 'updatedAt'),
      extra: {
        issue_key: pickString(issue, 'identifier'),
        json_size: toJsonBytes(normalizeIssue(issue)).length,
        ...(accessor.contentSearch ? { unsearched: unsearchedText(issue) } : {}),
      },
    }),
  )
}

async function listIssue(
  accessor: LinearAccessor,
  match: ScopeMatch,
  entry: FileStat,
): Promise<FileStat[]> {
  // issue.json renders the issue the team listing already fetched;
  // comments.jsonl costs the one bounded comments call, paid only when
  // this directory is entered.
  const issueId = match.slots.issue_id ?? ''
  const issueKey = extraString(entry, 'issue_key')
  const comments = await listIssueComments(accessor.transport, issueId)
  const rendered = comments.map((c) =>
    normalizeComment(c, issueId, issueKey !== '' ? issueKey : null),
  )
  let commentsTime = ''
  for (const row of rendered) {
    const updated = typeof row.updated_at === 'string' ? row.updated_at : ''
    if (updated > commentsTime) commentsTime = updated
  }
  return [
    ISSUE_JSON('issue.json', issueId, { size: extraSize(entry), modified: entry.modified }),
    COMMENTS('comments.jsonl', issueId, {
      size: jsonlBytesByCreatedAt(rendered).length,
      modified: commentsTime !== '' ? commentsTime : entry.modified,
    }),
  ]
}

async function listProjects(
  accessor: LinearAccessor,
  match: ScopeMatch,
  entry: FileStat,
): Promise<FileStat[]> {
  const teamId = match.slots.team_id ?? ''
  const projects = await listTeamProjects(accessor.transport, teamId)
  const teamIssues = await listTeamIssues(accessor.transport, teamId)
  return projects.map((project) => {
    const projectId = pickString(project, 'id')
    const projectIssues: NormalizedProjectIssue[] = []
    for (const issue of teamIssues) {
      const projField = issue.project
      const projObj =
        projField !== null && typeof projField === 'object'
          ? (projField as Record<string, unknown>)
          : {}
      if (projObj.id !== projectId) continue
      projectIssues.push(buildProjectIssue(issue))
    }
    const rendered = toJsonBytes(
      normalizeProject(project, {
        teamId,
        teamKey: extraString(entry, 'team_key') || null,
        teamName: extraString(entry, 'team_name') || null,
        issues: projectIssues,
      }),
    )
    return PROJECT(projectFilename(project), projectId, {
      size: rendered.length,
      modified: pickString(project, 'updatedAt'),
      extra: keptText(rendered),
    })
  })
}

async function listCycles(
  accessor: LinearAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<FileStat[]> {
  const teamId = match.slots.team_id ?? ''
  const cycles = await listTeamCycles(accessor.transport, teamId)
  return cycles.map((cycle) => {
    const rendered = toJsonBytes(normalizeCycle(cycle, teamId))
    return CYCLE(cycleFilename(cycle), pickString(cycle, 'id'), {
      size: rendered.length,
      modified: pickString(cycle, 'updatedAt'),
      extra: keptText(rendered),
    })
  })
}

async function listDocuments(
  accessor: LinearAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<FileStat[]> {
  const documents = await listTeamDocuments(accessor.transport, match.slots.team_id ?? '')
  return documents.map((document) => {
    const rendered = toJsonBytes(normalizeDocument(document))
    return DOCUMENT(documentFilename(document), pickString(document, 'id'), {
      size: rendered.length,
      modified: pickString(document, 'updatedAt'),
      extra: keptText(rendered),
    })
  })
}

export const readdir = makeReaddir<LinearAccessor>(detectScope, {
  listers: {
    teams: listTeamsDir,
  },
  entryListers: {
    team: listTeam,
    members: listMembers,
    issues: listIssues,
    issue: listIssue,
    projects: listProjects,
    cycles: listCycles,
    documents: listDocuments,
  },
  staticRoot: ['teams'],
})
