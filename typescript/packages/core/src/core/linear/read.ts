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
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { makeRead } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { jsonlBytesByCreatedAt } from '../render/json.ts'
import {
  getIssue,
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
import { filteredTeams } from './readdir.ts'
import { detectScope } from './scope.ts'
import { stat } from './stat.ts'

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

async function readTeamJson(
  accessor: LinearAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const teamId = match.slots.team_id ?? ''
  for (const team of await filteredTeams(accessor)) {
    if (team.id === teamId) return toJsonBytes(normalizeTeam(team))
  }
  throw enoent(path.virtual)
}

async function readMember(
  accessor: LinearAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const memberId = match.slots.member_id ?? ''
  const users = await listTeamMembers(accessor.transport, match.slots.team_id ?? '')
  for (const user of users) {
    if (user.id === memberId) return toJsonBytes(normalizeUser(user))
  }
  throw enoent(path.virtual)
}

async function readIssueJson(accessor: LinearAccessor, match: ScopeMatch): Promise<Uint8Array> {
  const issue = await getIssue(accessor.transport, match.slots.issue_id ?? '')
  return toJsonBytes(normalizeIssue(issue))
}

async function readComments(accessor: LinearAccessor, match: ScopeMatch): Promise<Uint8Array> {
  const issueId = match.slots.issue_id ?? ''
  const issue = await getIssue(accessor.transport, issueId)
  const normIssue = normalizeIssue(issue)
  const comments = await listIssueComments(accessor.transport, issueId)
  const rows = comments.map((c) => normalizeComment(c, issueId, normIssue.issue_key))
  return jsonlBytesByCreatedAt(rows)
}

async function readProject(
  accessor: LinearAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const teamId = match.slots.team_id ?? ''
  const projectId = match.slots.project_id ?? ''
  const teams = await listTeams(accessor.transport)
  const team = teams.find((t) => t.id === teamId) ?? {}
  const projects = await listTeamProjects(accessor.transport, teamId)
  const teamIssues = await listTeamIssues(accessor.transport, teamId)
  for (const project of projects) {
    if (project.id !== projectId) continue
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
    return toJsonBytes(
      normalizeProject(project, {
        teamId,
        teamKey: pickString(team, 'key') || null,
        teamName: pickString(team, 'name') || null,
        issues: projectIssues,
      }),
    )
  }
  throw enoent(path.virtual)
}

async function readCycle(
  accessor: LinearAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const teamId = match.slots.team_id ?? ''
  const cycles = await listTeamCycles(accessor.transport, teamId)
  for (const cycle of cycles) {
    if (cycle.id === match.slots.cycle_id) return toJsonBytes(normalizeCycle(cycle, teamId))
  }
  throw enoent(path.virtual)
}

async function readDocument(
  accessor: LinearAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const documents = await listTeamDocuments(accessor.transport, match.slots.team_id ?? '')
  for (const document of documents) {
    if (document.id === match.slots.document_id) {
      return toJsonBytes(normalizeDocument(document))
    }
  }
  throw enoent(path.virtual)
}

export const read = makeRead<LinearAccessor>(
  detectScope,
  {
    team_json: readTeamJson,
    member: readMember,
    issue_json: readIssueJson,
    comments_jsonl: readComments,
    project: readProject,
    cycle: readCycle,
    document: readDocument,
  },
  { stat },
)
