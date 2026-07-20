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

type Json = Record<string, unknown>

function pickStringOrNull(record: Json, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function pickString(record: Json, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return null
}

function pickBoolOrNull(record: Json, key: string): boolean | null {
  const value = record[key]
  return typeof value === 'boolean' ? value : null
}

function pickNumberOrNull(record: Json, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' ? value : null
}

function asObject(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function nodesOf(value: unknown): Json[] {
  const obj = asObject(value)
  const nodes = obj.nodes
  return Array.isArray(nodes) ? (nodes as Json[]) : []
}

interface NormalizedTeamState {
  state_id: string | null
  state_name: string | null
  type: string | null
}

export interface NormalizedTeam {
  team_id: string | null
  team_key: string | null
  team_name: string | null
  name: string | null
  description: string | null
  timezone: string | null
  updated_at: string | null
  states: NormalizedTeamState[]
}

export function normalizeTeam(team: Json): NormalizedTeam {
  const states: NormalizedTeamState[] = []
  for (const state of nodesOf(team.states)) {
    states.push({
      state_id: pickStringOrNull(state, 'id'),
      state_name: pickStringOrNull(state, 'name'),
      type: pickStringOrNull(state, 'type'),
    })
  }
  return {
    team_id: pickStringOrNull(team, 'id'),
    team_key: pickStringOrNull(team, 'key'),
    team_name: pickStringOrNull(team, 'name'),
    name: pickStringOrNull(team, 'name'),
    description: pickStringOrNull(team, 'description'),
    timezone: pickStringOrNull(team, 'timezone'),
    updated_at: pickStringOrNull(team, 'updatedAt'),
    states,
  }
}

export interface NormalizedUser {
  user_id: string | null
  name: string | null
  display_name: string | null
  email: string | null
  is_active: boolean | null
  is_admin: boolean | null
  updated_at: string | null
  url: string | null
}

export function normalizeUser(user: Json): NormalizedUser {
  return {
    user_id: pickStringOrNull(user, 'id'),
    name: pickStringOrNull(user, 'name'),
    display_name: pickString(user, 'displayName', 'name'),
    email: pickStringOrNull(user, 'email'),
    is_active: pickBoolOrNull(user, 'active'),
    is_admin: pickBoolOrNull(user, 'admin'),
    updated_at: pickStringOrNull(user, 'updatedAt'),
    url: pickStringOrNull(user, 'url'),
  }
}

export interface NormalizedIssue {
  issue_id: string | null
  issue_key: string | null
  title: string | null
  description: string
  team_id: string | null
  team_key: string | null
  team_name: string | null
  project_id: string | null
  project_name: string | null
  cycle_id: string | null
  cycle_name: string | null
  cycle_number: number | null
  state_id: string | null
  state_name: string | null
  assignee_id: string | null
  assignee_email: string | null
  assignee_name: string | null
  creator_id: string | null
  creator_email: string | null
  creator_name: string | null
  priority: number | null
  label_ids: (string | null)[]
  label_names: (string | null)[]
  created_at: string | null
  updated_at: string | null
  url: string | null
}

export function normalizeIssue(issue: Json): NormalizedIssue {
  const team = asObject(issue.team)
  const state = asObject(issue.state)
  const project = asObject(issue.project)
  const cycle = asObject(issue.cycle)
  const assignee = asObject(issue.assignee)
  const creator = asObject(issue.creator)
  const labels = nodesOf(issue.labels)
  return {
    issue_id: pickStringOrNull(issue, 'id'),
    issue_key: pickStringOrNull(issue, 'identifier'),
    title: pickStringOrNull(issue, 'title'),
    description: pickStringOrNull(issue, 'description') ?? '',
    team_id: pickStringOrNull(team, 'id'),
    team_key: pickStringOrNull(team, 'key'),
    team_name: pickStringOrNull(team, 'name'),
    project_id: pickStringOrNull(project, 'id'),
    project_name: pickStringOrNull(project, 'name'),
    cycle_id: pickStringOrNull(cycle, 'id'),
    cycle_name: pickStringOrNull(cycle, 'name'),
    cycle_number: pickNumberOrNull(cycle, 'number'),
    state_id: pickStringOrNull(state, 'id'),
    state_name: pickStringOrNull(state, 'name'),
    assignee_id: pickStringOrNull(assignee, 'id'),
    assignee_email: pickStringOrNull(assignee, 'email'),
    assignee_name: pickStringOrNull(assignee, 'name'),
    creator_id: pickStringOrNull(creator, 'id'),
    creator_email: pickStringOrNull(creator, 'email'),
    creator_name: pickStringOrNull(creator, 'name'),
    priority: pickNumberOrNull(issue, 'priority'),
    label_ids: labels.map((label) => pickStringOrNull(label, 'id')),
    label_names: labels.map((label) => pickStringOrNull(label, 'name')),
    created_at: pickStringOrNull(issue, 'createdAt'),
    updated_at: pickStringOrNull(issue, 'updatedAt'),
    url: pickStringOrNull(issue, 'url'),
  }
}

export interface NormalizedComment {
  comment_id: string | null
  issue_id: string
  issue_key: string | null
  user_id: string | null
  user_email: string | null
  user_name: string | null
  body: string
  created_at: string | null
  updated_at: string | null
  url: string | null
}

export function normalizeComment(
  comment: Json,
  issueId: string,
  issueKey: string | null,
): NormalizedComment {
  const user = asObject(comment.user)
  return {
    comment_id: pickStringOrNull(comment, 'id'),
    issue_id: issueId,
    issue_key: issueKey,
    user_id: pickStringOrNull(user, 'id'),
    user_email: pickStringOrNull(user, 'email'),
    user_name: pickString(user, 'displayName', 'name'),
    body: pickStringOrNull(comment, 'body') ?? '',
    created_at: pickStringOrNull(comment, 'createdAt'),
    updated_at: pickStringOrNull(comment, 'updatedAt'),
    url: pickStringOrNull(comment, 'url'),
  }
}

export interface NormalizedProjectIssue {
  issue_id: string | null
  issue_key: string | null
  title: string | null
  state_id: string | null
  state_name: string | null
  url: string | null
}

export interface NormalizedProject {
  project_id: string | null
  team_id: string
  team_key: string | null
  team_name: string | null
  name: string | null
  description: string | null
  state: string | null
  lead_id: string | null
  updated_at: string | null
  url: string | null
  issue_count: number
  issues: NormalizedProjectIssue[]
}

export interface NormalizeProjectContext {
  teamId: string
  teamKey: string | null
  teamName: string | null
  issues: NormalizedProjectIssue[]
}

export function normalizeProject(project: Json, ctx: NormalizeProjectContext): NormalizedProject {
  const lead = asObject(project.lead)
  return {
    project_id: pickStringOrNull(project, 'id'),
    team_id: ctx.teamId,
    team_key: ctx.teamKey,
    team_name: ctx.teamName,
    name: pickStringOrNull(project, 'name'),
    description: pickStringOrNull(project, 'description'),
    state: pickStringOrNull(asObject(project.status), 'type'),
    lead_id: pickStringOrNull(lead, 'id'),
    updated_at: pickStringOrNull(project, 'updatedAt'),
    url: pickStringOrNull(project, 'url'),
    issue_count: ctx.issues.length,
    issues: ctx.issues,
  }
}

export interface NormalizedCycle {
  cycle_id: string | null
  team_id: string
  name: string | null
  number: number | null
  starts_at: string | null
  ends_at: string | null
  updated_at: string | null
  url: string | null
}

export function normalizeCycle(cycle: Json, teamId: string): NormalizedCycle {
  return {
    cycle_id: pickStringOrNull(cycle, 'id'),
    team_id: teamId,
    name: pickStringOrNull(cycle, 'name'),
    number: pickNumberOrNull(cycle, 'number'),
    starts_at: pickStringOrNull(cycle, 'startsAt'),
    ends_at: pickStringOrNull(cycle, 'endsAt'),
    updated_at: pickStringOrNull(cycle, 'updatedAt'),
    url: pickStringOrNull(cycle, 'url'),
  }
}

export interface NormalizedLabel {
  label_id: string | null
  name: string | null
  color: string | null
}

export function normalizeLabel(label: Json): NormalizedLabel {
  return {
    label_id: pickStringOrNull(label, 'id'),
    name: pickStringOrNull(label, 'name'),
    color: pickStringOrNull(label, 'color'),
  }
}

export interface NormalizedDocument {
  document_id: string | null
  title: string | null
  content: string
  project_id: string | null
  project_name: string | null
  creator_id: string | null
  creator_name: string | null
  creator_email: string | null
  created_at: string | null
  updated_at: string | null
  url: string | null
}

export function normalizeDocument(document: Json): NormalizedDocument {
  const project = asObject(document.project)
  const creator = asObject(document.creator)
  return {
    document_id: pickStringOrNull(document, 'id'),
    title: pickStringOrNull(document, 'title'),
    content: pickStringOrNull(document, 'content') ?? '',
    project_id: pickStringOrNull(project, 'id'),
    project_name: pickStringOrNull(project, 'name'),
    creator_id: pickStringOrNull(creator, 'id'),
    creator_name: pickStringOrNull(creator, 'name'),
    creator_email: pickStringOrNull(creator, 'email'),
    created_at: pickStringOrNull(document, 'createdAt'),
    updated_at: pickStringOrNull(document, 'updatedAt'),
    url: pickStringOrNull(document, 'url'),
  }
}

export function buildProjectIssue(issue: Json): NormalizedProjectIssue {
  const state = asObject(issue.state)
  return {
    issue_id: pickStringOrNull(issue, 'id'),
    issue_key: pickStringOrNull(issue, 'identifier'),
    title: pickStringOrNull(issue, 'title'),
    state_id: pickStringOrNull(state, 'id'),
    state_name: pickStringOrNull(state, 'name'),
    url: pickStringOrNull(issue, 'url'),
  }
}

export function toJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2))
}

export function toJsonlBytes(rows: readonly NormalizedComment[]): Uint8Array {
  if (rows.length === 0) return new Uint8Array()
  const ordered = [...rows].sort((a, b) => {
    const ka = a.created_at ?? ''
    const kb = b.created_at ?? ''
    if (ka < kb) return -1
    if (ka > kb) return 1
    return 0
  })
  const text = ordered.map((row) => JSON.stringify(row)).join('\n') + '\n'
  return new TextEncoder().encode(text)
}
