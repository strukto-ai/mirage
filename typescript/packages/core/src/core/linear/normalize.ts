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

import type { JsonObject } from '../../types.ts'
import {
  asObject,
  pickBoolOrNull,
  pickNumberOrNull,
  pickString,
  records,
} from '../../utils/records.ts'

function nodesOf(value: unknown): JsonObject[] {
  return records(asObject(value).nodes)
}

interface NormalizedTeamState {
  state_id: string | null
  state_name: string | null
  type: string | null
}

export function normalizeTeam(team: JsonObject) {
  const states: NormalizedTeamState[] = []
  for (const state of nodesOf(team.states)) {
    states.push({
      state_id: pickString(state, 'id'),
      state_name: pickString(state, 'name'),
      type: pickString(state, 'type'),
    })
  }
  return {
    team_id: pickString(team, 'id'),
    team_key: pickString(team, 'key'),
    team_name: pickString(team, 'name'),
    name: pickString(team, 'name'),
    description: pickString(team, 'description'),
    timezone: pickString(team, 'timezone'),
    updated_at: pickString(team, 'updatedAt'),
    states,
  }
}

export function normalizeUser(user: JsonObject) {
  return {
    user_id: pickString(user, 'id'),
    name: pickString(user, 'name'),
    display_name: pickString(user, 'displayName', 'name'),
    email: pickString(user, 'email'),
    is_active: pickBoolOrNull(user, 'active'),
    is_admin: pickBoolOrNull(user, 'admin'),
    updated_at: pickString(user, 'updatedAt'),
    url: pickString(user, 'url'),
  }
}

export function normalizeIssue(issue: JsonObject) {
  const team = asObject(issue.team)
  const state = asObject(issue.state)
  const project = asObject(issue.project)
  const cycle = asObject(issue.cycle)
  const assignee = asObject(issue.assignee)
  const creator = asObject(issue.creator)
  const labels = nodesOf(issue.labels)
  return {
    issue_id: pickString(issue, 'id'),
    issue_key: pickString(issue, 'identifier'),
    title: pickString(issue, 'title'),
    description: pickString(issue, 'description') ?? '',
    team_id: pickString(team, 'id'),
    team_key: pickString(team, 'key'),
    team_name: pickString(team, 'name'),
    project_id: pickString(project, 'id'),
    project_name: pickString(project, 'name'),
    cycle_id: pickString(cycle, 'id'),
    cycle_name: pickString(cycle, 'name'),
    cycle_number: pickNumberOrNull(cycle, 'number'),
    state_id: pickString(state, 'id'),
    state_name: pickString(state, 'name'),
    assignee_id: pickString(assignee, 'id'),
    assignee_email: pickString(assignee, 'email'),
    assignee_name: pickString(assignee, 'name'),
    creator_id: pickString(creator, 'id'),
    creator_email: pickString(creator, 'email'),
    creator_name: pickString(creator, 'name'),
    priority: pickNumberOrNull(issue, 'priority'),
    label_ids: labels.map((label) => pickString(label, 'id')),
    label_names: labels.map((label) => pickString(label, 'name')),
    created_at: pickString(issue, 'createdAt'),
    updated_at: pickString(issue, 'updatedAt'),
    url: pickString(issue, 'url'),
  }
}

export function normalizeComment(comment: JsonObject, issueId: string, issueKey: string | null) {
  const user = asObject(comment.user)
  return {
    comment_id: pickString(comment, 'id'),
    issue_id: issueId,
    issue_key: issueKey,
    user_id: pickString(user, 'id'),
    user_email: pickString(user, 'email'),
    user_name: pickString(user, 'displayName', 'name'),
    body: pickString(comment, 'body') ?? '',
    created_at: pickString(comment, 'createdAt'),
    updated_at: pickString(comment, 'updatedAt'),
    url: pickString(comment, 'url'),
  }
}

export interface NormalizeProjectContext {
  teamId: string
  teamKey: string | null
  teamName: string | null
  issues: ReturnType<typeof buildProjectIssue>[]
}

export function normalizeProject(project: JsonObject, ctx: NormalizeProjectContext) {
  const lead = asObject(project.lead)
  return {
    project_id: pickString(project, 'id'),
    team_id: ctx.teamId,
    team_key: ctx.teamKey,
    team_name: ctx.teamName,
    name: pickString(project, 'name'),
    description: pickString(project, 'description'),
    state: pickString(asObject(project.status), 'type'),
    lead_id: pickString(lead, 'id'),
    updated_at: pickString(project, 'updatedAt'),
    url: pickString(project, 'url'),
    issue_count: ctx.issues.length,
    issues: ctx.issues,
  }
}

export function normalizeCycle(cycle: JsonObject, teamId: string) {
  return {
    cycle_id: pickString(cycle, 'id'),
    team_id: teamId,
    name: pickString(cycle, 'name'),
    number: pickNumberOrNull(cycle, 'number'),
    starts_at: pickString(cycle, 'startsAt'),
    ends_at: pickString(cycle, 'endsAt'),
    updated_at: pickString(cycle, 'updatedAt'),
    url: pickString(cycle, 'url'),
  }
}

export function normalizeLabel(label: JsonObject) {
  return {
    label_id: pickString(label, 'id'),
    name: pickString(label, 'name'),
    color: pickString(label, 'color'),
  }
}

export function normalizeDocument(document: JsonObject) {
  const project = asObject(document.project)
  const creator = asObject(document.creator)
  return {
    document_id: pickString(document, 'id'),
    title: pickString(document, 'title'),
    content: pickString(document, 'content') ?? '',
    project_id: pickString(project, 'id'),
    project_name: pickString(project, 'name'),
    creator_id: pickString(creator, 'id'),
    creator_name: pickString(creator, 'name'),
    creator_email: pickString(creator, 'email'),
    created_at: pickString(document, 'createdAt'),
    updated_at: pickString(document, 'updatedAt'),
    url: pickString(document, 'url'),
  }
}

export function buildProjectIssue(issue: JsonObject) {
  const state = asObject(issue.state)
  return {
    issue_id: pickString(issue, 'id'),
    issue_key: pickString(issue, 'identifier'),
    title: pickString(issue, 'title'),
    state_id: pickString(state, 'id'),
    state_name: pickString(state, 'name'),
    url: pickString(issue, 'url'),
  }
}

// The fields of an issue's JSON Linear's issue search reads; every other field
// is checked against the listing instead (`unsearchedText`).
export const SEARCHED_FIELDS: ReadonlySet<string> = new Set(['title', 'description'])
