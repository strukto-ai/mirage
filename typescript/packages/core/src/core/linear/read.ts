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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { LinearAccessor } from '../../accessor/linear.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import {
  getIssue,
  listIssueComments,
  listTeamCycles,
  listTeamIssues,
  listTeamMembers,
  listTeamProjects,
  listTeams,
  type LinearTransport,
} from './_client.ts'
import {
  buildProjectIssue,
  normalizeComment,
  normalizeCycle,
  normalizeIssue,
  normalizeProject,
  normalizeTeam,
  normalizeUser,
  toJsonBytes,
  toJsonlBytes,
  type NormalizedProjectIssue,
} from './normalize.ts'
import { splitSuffixId } from './pathing.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

export interface ReadFilter {
  teamIds?: readonly string[]
}

export async function readBytes(
  transport: LinearTransport,
  path: string,
  virtual: string,
  filter: ReadFilter = {},
): Promise<Uint8Array> {
  const key = stripSlash(path)
  const parts = key.split('/')

  if (parts.length === 3 && parts[0] === 'teams' && parts[2] === 'team.json') {
    const [, teamId] = splitSuffixId(parts[1] ?? '')
    let teams = await listTeams(transport)
    if (filter.teamIds !== undefined && filter.teamIds.length > 0) {
      const allowed = new Set(filter.teamIds)
      teams = teams.filter((t) => allowed.has(typeof t.id === 'string' ? t.id : ''))
    }
    for (const team of teams) {
      if (team.id === teamId) return toJsonBytes(normalizeTeam(team))
    }
    throw enoent(virtual)
  }

  if (parts.length === 4 && parts[0] === 'teams' && parts[2] === 'members') {
    const [, teamId] = splitSuffixId(parts[1] ?? '')
    const [, userId] = splitSuffixId(parts[3] ?? '', '.json')
    const users = await listTeamMembers(transport, teamId)
    for (const user of users) {
      if (user.id === userId) return toJsonBytes(normalizeUser(user))
    }
    throw enoent(virtual)
  }

  if (parts.length === 5 && parts[0] === 'teams' && parts[2] === 'issues') {
    const [, issueId] = splitSuffixId(parts[3] ?? '')
    const issue = await getIssue(transport, issueId)
    if (parts[4] === 'issue.json') {
      return toJsonBytes(normalizeIssue(issue))
    }
    if (parts[4] === 'comments.jsonl') {
      const normIssue = normalizeIssue(issue)
      const comments = await listIssueComments(transport, issueId)
      const rows = comments.map((c) => normalizeComment(c, issueId, normIssue.issue_key))
      return toJsonlBytes(rows)
    }
    throw enoent(virtual)
  }

  if (parts.length === 4 && parts[0] === 'teams' && parts[2] === 'projects') {
    const [, teamId] = splitSuffixId(parts[1] ?? '')
    const [, projectId] = splitSuffixId(parts[3] ?? '', '.json')
    const teams = await listTeams(transport)
    const team = teams.find((t) => t.id === teamId) ?? {}
    const projects = await listTeamProjects(transport, teamId)
    const teamIssues = await listTeamIssues(transport, teamId)
    for (const project of projects) {
      if (project.id === projectId) {
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
            teamKey: typeof team.key === 'string' ? team.key : null,
            teamName: typeof team.name === 'string' ? team.name : null,
            issues: projectIssues,
          }),
        )
      }
    }
    throw enoent(virtual)
  }

  if (parts.length === 4 && parts[0] === 'teams' && parts[2] === 'cycles') {
    const [, teamId] = splitSuffixId(parts[1] ?? '')
    const [, cycleId] = splitSuffixId(parts[3] ?? '', '.json')
    const cycles = await listTeamCycles(transport, teamId)
    for (const cycle of cycles) {
      if (cycle.id === cycleId) return toJsonBytes(normalizeCycle(cycle, teamId))
    }
    throw enoent(virtual)
  }

  throw enoent(virtual)
}

export async function read(
  accessor: LinearAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  filter: ReadFilter = {},
): Promise<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  return readBytes(accessor.transport, p, path.virtual, filter)
}
