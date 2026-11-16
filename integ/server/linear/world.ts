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

import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { all, exec, one } from '../kit/typescript/sql.ts'
import type { Refs } from './nodes.ts'
import type {
  Cycle,
  Label,
  Project,
  Team,
  User,
  WorkflowState,
} from '../../generated/linear/index.js'

// The run's file over node:sqlite (kit sql.ts), on the tables
// prisma/linear.prisma declares; rows keep Prisma's generated shapes. Every
// read keeps the WHERE and ORDER BY Prisma sent, so rows that tie on seq come
// back in the order they did.
export type Db = DatabaseSync

export const TEAM =
  'SELECT tenant, id, "key", name, description, timezone, updatedAt, seq FROM Team'
export const STATE = 'SELECT tenant, id, teamId, name, type, seq FROM WorkflowState'
export const LABEL = 'SELECT tenant, id, teamId, name, color, seq FROM Label'
const USER =
  'SELECT tenant, id, teamId, name, displayName, email, active, admin, url, updatedAt, seq ' +
  'FROM User'
export const PROJECT =
  'SELECT tenant, id, teamId, name, description, statusType, url, updatedAt, leadId, seq ' +
  'FROM Project'
export const CYCLE =
  'SELECT tenant, id, teamId, name, number, startsAt, endsAt, updatedAt, url, seq FROM Cycle'
export const DOCUMENT =
  'SELECT tenant, id, teamId, title, content, url, createdAt, updatedAt, projectId, creatorId, ' +
  'seq FROM Document'
export const ISSUE =
  'SELECT tenant, id, teamId, identifier, number, title, description, priority, url, createdAt, ' +
  'updatedAt, stateId, projectId, cycleId, assigneeId, creatorId, labelIds, raw, seq FROM Issue'
export const COMMENT =
  'SELECT tenant, id, issueId, body, raw, url, createdAt, updatedAt, userId, seq FROM Comment'
export const RELATION =
  'SELECT tenant, id, issueId, relatedIssueId, type, previousStateId, seq FROM IssueRelation'

type UserRecord = Omit<User, 'active' | 'admin'> & { active: number | null; admin: number | null }

function toUser(row: UserRecord): User {
  return {
    ...row,
    active: row.active === null ? null : row.active === 1,
    admin: row.admin === null ? null : row.admin === 1,
  }
}

export function usersWhere(db: Db, where: string, ...params: SQLInputValue[]): User[] {
  return all<UserRecord>(db, `${USER} WHERE ${where}`, ...params).map(toUser)
}

// Throws when nothing matched, as Prisma's update and delete did.
export function changeOne(db: Db, sql: string, ...params: SQLInputValue[]): void {
  if (exec(db, sql, ...params) === 0) throw new Error('linear fake: no row matched')
}

export interface TeamScoped {
  teamId: string
  seq: number
}

// Ordering is not free here: `include` and a bare findMany do not read back
// insertion order, so every read that a caller sees the order of goes through
// seq. The old fake's by-id dictionaries were in seed order, which is team
// order first and then position within the team, and two reads depend on it
// (UserLookup takes the first user with an email, IssueSearch fills its page
// in that order), so the global maps are rebuilt in exactly that order rather
// than in whatever order SQLite hands back.
export function byTeamThenSeq<T extends TeamScoped>(rows: T[], teamSeq: Map<string, number>): T[] {
  return [...rows].sort(
    (a, b) => (teamSeq.get(a.teamId) ?? 0) - (teamSeq.get(b.teamId) ?? 0) || a.seq - b.seq,
  )
}

export function indexById<T extends { id: string }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>()
  for (const row of rows) out.set(row.id, row)
  return out
}

export async function loadTeams(db: Db, tenant: string): Promise<Team[]> {
  return all<Team>(db, `${TEAM} WHERE tenant = ? ORDER BY seq ASC`, tenant)
}

// The next GLOBAL issue ordinal in the tenant. The seeder stamps seq per
// nested list, so afterSeed renumbers issues across teams and a create takes
// MAX + 1 from there; taking it per team would file a new issue among its own
// team's rows instead of at the end of the world, which is the order
// IssueSearch pages in.
export async function nextIssueSeq(db: Db, tenant: string): Promise<number> {
  const top = one<{ n: number | null }>(
    db,
    'SELECT MAX(seq) AS n FROM Issue WHERE tenant = ?',
    tenant,
  )
  return (top?.n ?? -1) + 1
}

export function teamSeqOf(teams: Team[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const team of teams) out.set(team.id, team.seq)
  return out
}

// One read of the five global tables per request. The data is small and the
// alternative is a findUnique per rendered reference, which is the N+1 the
// old fake avoided by holding everything in dicts.
export async function loadRefs(db: Db, tenant: string): Promise<Refs> {
  const teams = await loadTeams(db, tenant)
  const teamSeq = teamSeqOf(teams)
  const tenantOrder = 'WHERE tenant = ? ORDER BY seq ASC'
  const states = all<WorkflowState>(db, `${STATE} ${tenantOrder}`, tenant)
  const projects = all<Project>(db, `${PROJECT} ${tenantOrder}`, tenant)
  const cycles = all<Cycle>(db, `${CYCLE} ${tenantOrder}`, tenant)
  const users = usersWhere(db, 'tenant = ? ORDER BY seq ASC', tenant)
  const labels = all<Label>(db, `${LABEL} ${tenantOrder}`, tenant)
  return {
    teams: indexById(teams),
    states: indexById(byTeamThenSeq(states, teamSeq)),
    projects: indexById(byTeamThenSeq(projects, teamSeq)),
    cycles: indexById(byTeamThenSeq(cycles, teamSeq)),
    users: indexById(byTeamThenSeq(users, teamSeq)),
    labels: indexById(byTeamThenSeq(labels, teamSeq)),
  }
}

// issueId -> label ids in the order the issue holds them, duplicates kept.
// The surrogate pk on the link table is what allows the same label twice,
// and seq is what keeps the pair in the order it was written.
export async function loadLabelLinks(db: Db, tenant: string): Promise<Map<string, string[]>> {
  const rows = all<{ issueId: string; labelId: string }>(
    db,
    'SELECT issueId, labelId FROM IssueLabel WHERE tenant = ? ORDER BY seq ASC',
    tenant,
  )
  const out = new Map<string, string[]>()
  for (const row of rows) {
    const live = out.get(row.issueId)
    if (live === undefined) out.set(row.issueId, [row.labelId])
    else live.push(row.labelId)
  }
  return out
}

export function labelsOf(links: Map<string, string[]>, issueId: string): string[] {
  return links.get(issueId) ?? []
}

export async function writeLabelLinks(
  db: Db,
  tenant: string,
  issueId: string,
  labelIds: string[],
): Promise<void> {
  exec(db, 'DELETE FROM IssueLabel WHERE tenant = ? AND issueId = ?', tenant, issueId)
  for (const [seq, labelId] of labelIds.entries()) {
    exec(
      db,
      'INSERT INTO IssueLabel (tenant, issueId, labelId, seq) VALUES (?, ?, ?, ?)',
      tenant,
      issueId,
      labelId,
      seq,
    )
  }
}
