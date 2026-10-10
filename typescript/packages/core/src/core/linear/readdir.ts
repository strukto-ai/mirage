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
import { IndexEntry } from '../../cache/index/config.ts'
import { makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
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

export const TEAM_DIRS = ['members', 'issues', 'projects', 'cycles', 'documents'] as const

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function extraSize(entry: IndexEntry): number | null {
  const value = entry.extra.json_size
  return typeof value === 'number' ? value : null
}

function extraString(entry: IndexEntry, key: string): string {
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

async function listTeamsDir(
  accessor: LinearAccessor,
  _match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  const entries: [string, IndexEntry][] = []
  for (const team of await filteredTeams(accessor)) {
    const dirname = teamDirname(team)
    // team.json renders the team object this listing already fetched, so
    // its exact size rides the directory entry, and the key/name ride
    // along for the project renders below it.
    entries.push([
      dirname,
      new IndexEntry({
        id: pickString(team, 'id'),
        name: pickString(team, 'name') || pickString(team, 'key') || pickString(team, 'id'),
        resourceType: 'linear/team',
        remoteTime: pickString(team, 'updatedAt'),
        vfsName: dirname,
        extra: {
          team_key: pickString(team, 'key'),
          team_name: pickString(team, 'name'),
          json_size: toJsonBytes(normalizeTeam(team)).length,
        },
      }),
    ])
  }
  return entries
}

function listTeam(
  _accessor: LinearAccessor,
  _match: ScopeMatch,
  entry: IndexEntry,
): Promise<[string, IndexEntry][]> {
  const entries: [string, IndexEntry][] = [
    [
      'team.json',
      new IndexEntry({
        id: entry.id,
        name: 'team.json',
        resourceType: 'linear/team_json',
        remoteTime: entry.remoteTime,
        vfsName: 'team.json',
        size: extraSize(entry),
      }),
    ],
  ]
  for (const name of TEAM_DIRS) {
    // A project render carries its team's key and name, which only the
    // team listing knows.
    const extra =
      name === 'projects'
        ? { team_key: extraString(entry, 'team_key'), team_name: extraString(entry, 'team_name') }
        : {}
    entries.push([
      name,
      new IndexEntry({
        id: entry.id,
        name,
        resourceType: `linear/${name}_dir`,
        vfsName: name,
        extra,
      }),
    ])
  }
  return Promise.resolve(entries)
}

async function listMembers(
  accessor: LinearAccessor,
  match: ScopeMatch,
  _entry: IndexEntry,
): Promise<[string, IndexEntry][]> {
  const users = await listTeamMembers(accessor.transport, match.slots.team_id ?? '')
  return users.map((user): [string, IndexEntry] => {
    const filename = memberFilename(user)
    return [
      filename,
      new IndexEntry({
        id: pickString(user, 'id'),
        name: pickString(user, 'name') || pickString(user, 'displayName') || pickString(user, 'id'),
        resourceType: 'linear/user',
        remoteTime: pickString(user, 'updatedAt'),
        vfsName: filename,
        size: toJsonBytes(normalizeUser(user)).length,
      }),
    ]
  })
}

async function listIssues(
  accessor: LinearAccessor,
  match: ScopeMatch,
  _entry: IndexEntry,
): Promise<[string, IndexEntry][]> {
  const issues = await listTeamIssues(accessor.transport, match.slots.team_id ?? '')
  return issues.map((issue): [string, IndexEntry] => {
    const dirname = issueDirname(issue)
    return [
      dirname,
      new IndexEntry({
        id: pickString(issue, 'id'),
        name: pickString(issue, 'identifier') || pickString(issue, 'id'),
        resourceType: 'linear/issue',
        remoteTime: pickString(issue, 'updatedAt'),
        vfsName: dirname,
        extra: {
          issue_key: pickString(issue, 'identifier'),
          json_size: toJsonBytes(normalizeIssue(issue)).length,
        },
      }),
    ]
  })
}

async function listIssue(
  accessor: LinearAccessor,
  _match: ScopeMatch,
  entry: IndexEntry,
): Promise<[string, IndexEntry][]> {
  // issue.json renders the issue the team listing already fetched;
  // comments.jsonl costs the one bounded comments call, paid only when
  // this directory is entered.
  const issueId = entry.id
  const issueKey = extraString(entry, 'issue_key')
  const comments = await listIssueComments(accessor.transport, issueId)
  const rows = comments.map((c) => normalizeComment(c, issueId, issueKey !== '' ? issueKey : null))
  let commentsTime = ''
  for (const row of rows) {
    const updated = typeof row.updated_at === 'string' ? row.updated_at : ''
    if (updated > commentsTime) commentsTime = updated
  }
  return [
    [
      'issue.json',
      new IndexEntry({
        id: issueId,
        name: 'issue.json',
        resourceType: 'linear/issue_json',
        remoteTime: entry.remoteTime,
        vfsName: 'issue.json',
        size: extraSize(entry),
      }),
    ],
    [
      'comments.jsonl',
      new IndexEntry({
        id: issueId,
        name: 'comments.jsonl',
        resourceType: 'linear/comments',
        remoteTime: commentsTime !== '' ? commentsTime : entry.remoteTime,
        vfsName: 'comments.jsonl',
        size: jsonlBytesByCreatedAt(rows).length,
      }),
    ],
  ]
}

async function listProjects(
  accessor: LinearAccessor,
  match: ScopeMatch,
  entry: IndexEntry,
): Promise<[string, IndexEntry][]> {
  const teamId = match.slots.team_id ?? ''
  const projects = await listTeamProjects(accessor.transport, teamId)
  const teamIssues = await listTeamIssues(accessor.transport, teamId)
  return projects.map((project): [string, IndexEntry] => {
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
    const rendered = normalizeProject(project, {
      teamId,
      teamKey: extraString(entry, 'team_key') || null,
      teamName: extraString(entry, 'team_name') || null,
      issues: projectIssues,
    })
    const filename = projectFilename(project)
    return [
      filename,
      new IndexEntry({
        id: projectId,
        name: pickString(project, 'name') || projectId,
        resourceType: 'linear/project',
        remoteTime: pickString(project, 'updatedAt'),
        vfsName: filename,
        size: toJsonBytes(rendered).length,
      }),
    ]
  })
}

async function listCycles(
  accessor: LinearAccessor,
  match: ScopeMatch,
  _entry: IndexEntry,
): Promise<[string, IndexEntry][]> {
  const teamId = match.slots.team_id ?? ''
  const cycles = await listTeamCycles(accessor.transport, teamId)
  return cycles.map((cycle): [string, IndexEntry] => {
    const filename = cycleFilename(cycle)
    return [
      filename,
      new IndexEntry({
        id: pickString(cycle, 'id'),
        name: pickString(cycle, 'name') || pickString(cycle, 'id'),
        resourceType: 'linear/cycle',
        remoteTime: pickString(cycle, 'updatedAt'),
        vfsName: filename,
        size: toJsonBytes(normalizeCycle(cycle, teamId)).length,
      }),
    ]
  })
}

async function listDocuments(
  accessor: LinearAccessor,
  match: ScopeMatch,
  _entry: IndexEntry,
): Promise<[string, IndexEntry][]> {
  const documents = await listTeamDocuments(accessor.transport, match.slots.team_id ?? '')
  return documents.map((document): [string, IndexEntry] => {
    const filename = documentFilename(document)
    return [
      filename,
      new IndexEntry({
        id: pickString(document, 'id'),
        name: pickString(document, 'title') || pickString(document, 'id'),
        resourceType: 'linear/document',
        remoteTime: pickString(document, 'updatedAt'),
        vfsName: filename,
        size: toJsonBytes(normalizeDocument(document)).length,
      }),
    ]
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
