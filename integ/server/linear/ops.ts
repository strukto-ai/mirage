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

import type { SQLInputValue } from 'node:sqlite'
import type {
  Comment,
  Cycle,
  Document,
  Issue,
  IssueRelation,
  Label,
  Project,
  Team,
  WorkflowState,
} from '../../generated/linear/index.js'
import { all, exec, one } from '../kit/typescript/sql.ts'
import { plainWords } from '../kit/typescript/words.ts'
import type { Ctx } from '../kit/typescript/route.ts'
import type { JsonValue, Reply } from '../kit/typescript/types.ts'
import { ISSUE_URL_BASE, WRITE_STAMP } from './config.ts'
import type { C } from './config.ts'
import {
  commentNode,
  connection,
  cycleNode,
  documentNode,
  issueDescription,
  issueNode,
  issueTitle,
  labelNode,
  projectNode,
  searchNode,
  teamNode,
  userNode,
} from './nodes.ts'
import { pyDictOr, pyGe, pyInt, pyJoinPart, pyKey, pyList, pyStrOr, pyTruthy } from './pyval.ts'
import { isNaturalInt, isNaturalString, readRaw, stage, writeRaw } from './raw.ts'
import type { RawMap } from './raw.ts'
import {
  COMMENT,
  CYCLE,
  DOCUMENT,
  ISSUE,
  LABEL,
  PROJECT,
  RELATION,
  STATE,
  TEAM,
  byTeamThenSeq,
  changeOne,
  labelsOf,
  loadLabelLinks,
  loadRefs,
  loadTeams,
  nextIssueSeq,
  teamSeqOf,
  usersWhere,
  writeLabelLinks,
} from './world.ts'

// The raw `variables` value, not a parsed dict. `op_teams` ignored it, so a
// variables of `[1]` answered 200 there and 500 in every other op; opening the
// dict inside each op that reads one keeps that.
export type Op = (ctx: Ctx<C>, vars: JsonValue | undefined) => Promise<Reply>

export function dataReply(payload: Record<string, JsonValue>): Reply {
  return { status: 200, body: { data: payload } }
}

// GraphQL reports a failure in band, but the old fake also answered 400 on
// one, and the client reads both: a 200 carrying `errors` and a 400 carrying
// `errors` raise the same LinearAPIError. The status is kept because the
// goldens were cut against it.
export function errorsReply(message: string): Reply {
  return { status: 400, body: { errors: [{ message }] } }
}

export function asString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

// An id read off the line. The old fake hashed it into a dict, so a list or a
// dict raises and everything else that is not a string simply misses.
export function idOf(value: JsonValue | undefined): string | null {
  return asString(pyKey(value))
}

// A label list the link table can hold is a list of strings and nothing else.
// The old fake stored whatever it was handed and hashed each element only when
// it rendered, so a list holding a number renders short and one holding a list
// raises; both are the overlay's job, not the link table's.
export function plainLabels(labelIds: JsonValue[]): string[] | null {
  return labelIds.every((v) => typeof v === 'string') ? (labelIds as string[]) : null
}

// Stage a supplied label list against both stores: the link table gets it when
// every element is a string, and the overlay gets it otherwise.
export async function applyLabels(
  ctx: Ctx<C>,
  raw: RawMap,
  issueId: string,
  labelIds: JsonValue[],
): Promise<void> {
  const plain = plainLabels(labelIds)
  if (plain === null) raw.labelIds = labelIds
  else delete raw.labelIds
  await writeLabelLinks(ctx.sql, ctx.tenant, issueId, plain ?? [])
}

// The issues `where` selects within the tenant.
function issuesWhere(ctx: Ctx<C>, where: string, ...params: SQLInputValue[]): Issue[] {
  return all<Issue>(ctx.sql, `${ISSUE} WHERE tenant = ? AND ${where}`, ctx.tenant, ...params)
}

function relationsWhere(ctx: Ctx<C>, where: string, ...params: SQLInputValue[]): IssueRelation[] {
  return all<IssueRelation>(
    ctx.sql,
    `${RELATION} WHERE tenant = ? AND ${where}`,
    ctx.tenant,
    ...params,
  )
}

// A missing teamId is not an error in this fake: the old one indexed a dict
// with None and got the empty list, so the connection comes back empty and
// the wrapper object is still there.
function teamIdOf(vars: JsonValue | undefined): string {
  return idOf(pyDictOr(vars).teamId) ?? ''
}

export const teams: Op = async (ctx) => {
  const rows = await loadTeams(ctx.sql, ctx.tenant)
  const states = all<WorkflowState>(
    ctx.sql,
    `${STATE} WHERE tenant = ? ORDER BY seq ASC`,
    ctx.tenant,
  )
  const byTeam = new Map<string, WorkflowState[]>()
  for (const state of states) {
    const live = byTeam.get(state.teamId)
    if (live === undefined) byTeam.set(state.teamId, [state])
    else live.push(state)
  }
  return dataReply({ teams: connection(rows.map((t) => teamNode(t, byTeam.get(t.id) ?? []))) })
}

export const teamMembers: Op = async (ctx, vars) => {
  const rows = usersWhere(
    ctx.sql,
    'tenant = ? AND teamId = ? ORDER BY seq ASC',
    ctx.tenant,
    teamIdOf(vars),
  )
  return dataReply({ team: { members: connection(rows.map(userNode)) } })
}

// Linear's `filter: {project: {id: {in: [...]}}}`, the one filter a team's
// issues are asked with: only the issues in those projects.
function projectIdsOf(vars: JsonValue | undefined): string[] | null {
  const ids = pyDictOr(pyDictOr(pyDictOr(pyDictOr(vars).filter).project).id).in
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : null
}

export const teamIssues: Op = async (ctx, vars) => {
  const projects = projectIdsOf(vars)
  const rows =
    projects === null
      ? issuesWhere(ctx, 'teamId = ? ORDER BY seq ASC', teamIdOf(vars))
      : issuesWhere(
          ctx,
          'teamId = ? AND projectId IN (SELECT value FROM json_each(?)) ORDER BY seq ASC',
          teamIdOf(vars),
          JSON.stringify(projects),
        )
  const refs = await loadRefs(ctx.sql, ctx.tenant)
  const links = await loadLabelLinks(ctx.sql, ctx.tenant)
  return dataReply({
    team: { issues: connection(rows.map((i) => issueNode(refs, i, labelsOf(links, i.id)))) },
  })
}

export const teamProjects: Op = async (ctx, vars) => {
  const rows = all<Project>(
    ctx.sql,
    `${PROJECT} WHERE tenant = ? AND teamId = ? ORDER BY seq ASC`,
    ctx.tenant,
    teamIdOf(vars),
  )
  return dataReply({ team: { projects: connection(rows.map(projectNode)) } })
}

export const teamCycles: Op = async (ctx, vars) => {
  const rows = all<Cycle>(
    ctx.sql,
    `${CYCLE} WHERE tenant = ? AND teamId = ? ORDER BY seq ASC`,
    ctx.tenant,
    teamIdOf(vars),
  )
  return dataReply({ team: { cycles: connection(rows.map(cycleNode)) } })
}

export const teamLabels: Op = async (ctx, vars) => {
  const rows = all<Label>(
    ctx.sql,
    `${LABEL} WHERE tenant = ? AND teamId = ? ORDER BY seq ASC`,
    ctx.tenant,
    teamIdOf(vars),
  )
  return dataReply({ team: { labels: connection(rows.map(labelNode)) } })
}

export const teamDocuments: Op = async (ctx, vars) => {
  const rows = all<Document>(
    ctx.sql,
    `${DOCUMENT} WHERE tenant = ? AND teamId = ? ORDER BY seq ASC`,
    ctx.tenant,
    teamIdOf(vars),
  )
  const refs = await loadRefs(ctx.sql, ctx.tenant)
  return dataReply({ documents: connection(rows.map((d) => documentNode(refs, d))) })
}

async function issueById(ctx: Ctx<C>, id: string | null): Promise<Issue | null> {
  if (id === null) return null
  return issuesWhere(ctx, '(id = ? OR identifier = ?) LIMIT 1', id, id)[0] ?? null
}

export const issue: Op = async (ctx, vars) => {
  const row = await issueById(ctx, idOf(pyDictOr(vars).issueId ?? pyDictOr(vars).id))
  if (row === null) return dataReply({ issue: null })
  const refs = await loadRefs(ctx.sql, ctx.tenant)
  const links = await loadLabelLinks(ctx.sql, ctx.tenant)
  return dataReply({ issue: issueNode(refs, row, labelsOf(links, row.id)) })
}

export const issueComments: Op = async (ctx, vars) => {
  const rows = all<Comment>(
    ctx.sql,
    `${COMMENT} WHERE tenant = ? AND issueId = ? ORDER BY seq ASC`,
    ctx.tenant,
    idOf(pyDictOr(vars).issueId) ?? '',
  )
  const refs = await loadRefs(ctx.sql, ctx.tenant)
  return dataReply({ issue: { comments: connection(rows.map((c) => commentNode(refs, c))) } })
}

// The identifier lookup answers a bare {nodes} with no pageInfo, and at most
// one node: the old fake broke out of the loop on the first match.
export const issueLookup: Op = async (ctx, vars) => {
  const v = pyDictOr(vars)
  const teamKey = idOf(v.teamKey)
  const wanted = v.number
  const nodes: JsonValue[] = []
  if (teamKey !== null && wanted !== undefined && wanted !== null) {
    const team = one<Team>(
      ctx.sql,
      `${TEAM} WHERE tenant = ? AND "key" = ? LIMIT 1`,
      ctx.tenant,
      teamKey,
    )
    if (team !== null) {
      const row =
        issuesWhere(
          ctx,
          'teamId = ? AND number = ? ORDER BY seq ASC LIMIT 1',
          team.id,
          pyInt(wanted),
        )[0] ?? null
      if (row !== null) nodes.push({ id: row.id, identifier: row.identifier })
    }
  }
  return dataReply({ issues: { nodes } })
}

export const userLookup: Op = async (ctx, vars) => {
  const email = pyDictOr(vars).email ?? null
  const teams = await loadTeams(ctx.sql, ctx.tenant)
  const rows = byTeamThenSeq(
    usersWhere(ctx.sql, 'tenant = ? ORDER BY seq ASC', ctx.tenant),
    teamSeqOf(teams),
  )
  const nodes: JsonValue[] = []
  for (const user of rows) {
    if ((user.email ?? null) === email) {
      nodes.push({ id: user.id, email: user.email, name: user.name })
      break
    }
  }
  return dataReply({ users: { nodes } })
}

// `first` is read the way the old fake read it, with `or`, so a first of 0
// means 50 rather than an empty page, and a value that is not a number reaches
// the length comparison exactly as it did there. The scan stops as soon as the
// page is full, which for a substring match over every issue is the same set
// as filtering and slicing. The title and description are matched by their
// plain words only (`plainWords`), as Linear can miss a word inside a link.
//
// The row order is the GLOBAL insertion order (Issue.seq, renumbered across
// teams by afterSeed), not the per-team one: the old fake paged out of one
// insertion-ordered dict, so a newly created issue is last overall and `first`
// therefore selects a different SET of rows than a team-major order would.
export const issueSearch: Op = async (ctx, vars) => {
  const v = pyDictOr(vars)
  const term = pyStrOr(v.term).toLowerCase()
  const limit = pyTruthy(v.first) ? (v.first as JsonValue) : 50
  const rows = all<Issue>(ctx.sql, `${ISSUE} WHERE tenant = ? ORDER BY seq ASC`, ctx.tenant)
  const refs = await loadRefs(ctx.sql, ctx.tenant)
  const nodes: JsonValue[] = []
  for (const row of rows) {
    const haystack = [
      plainWords(pyJoinPart(issueTitle(row))),
      plainWords(pyJoinPart(issueDescription(row))),
      pyJoinPart(row.identifier),
    ]
      .join(' ')
      .toLowerCase()
    if (haystack.includes(term)) nodes.push(searchNode(refs, row))
    if (pyGe(nodes.length, limit)) break
  }
  return dataReply({ searchIssues: { nodes } })
}

// The five reference ids a create accepts and an update does not. They are
// stored exactly as handed over, so an id that names nothing is stored and
// renders null later.
const CREATE_REFS = ['stateId', 'projectId', 'cycleId', 'assigneeId', 'creatorId'] as const

// A create checks the team and nothing else.
export const issueCreate: Op = async (ctx, vars) => {
  const input = pyDictOr(pyDictOr(vars).input)
  const teamId = idOf(input.teamId)
  const team =
    teamId === null
      ? null
      : one<Team>(ctx.sql, `${TEAM} WHERE tenant = ? AND id = ?`, ctx.tenant, teamId)
  if (team === null) return errorsReply('team not found')
  // Every field is read before the first write, because a value the old fake
  // could not use raised before it appended anything. teamId is the ONLY one
  // it hashed here; the five reference ids were stored unexamined and only
  // hashed when a later read rendered them, so a list in one of those slots
  // creates the issue and then breaks every read of it.
  const raw: RawMap = {}
  const title = stage(raw, 'title', 'title' in input ? input.title : '', isNaturalString)
  const description = stage(
    raw,
    'description',
    'description' in input ? input.description : '',
    isNaturalString,
  )
  const priority = stage(raw, 'priority', input.priority ?? null, isNaturalInt)
  const refIds: Record<string, string | null> = {}
  for (const key of CREATE_REFS) {
    refIds[key] = stage(raw, key, input[key] ?? null, isNaturalString) as string | null
  }
  const labelIds = pyList('labelIds' in input ? input.labelIds : [])
  if (plainLabels(labelIds) === null) raw.labelIds = labelIds
  const id = ctx.minter.mint('iss')
  // COALESCE(MAX(number), 0) + 1: the aggregate over a team with no issues at
  // all is null, not 0, and the first issue on an empty team is PLAT-1.
  const top = one<{ n: number | null }>(
    ctx.sql,
    'SELECT MAX(number) AS n FROM Issue WHERE tenant = ? AND teamId = ?',
    ctx.tenant,
    team.id,
  )
  const number = (top?.n ?? 0) + 1
  const identifier = `${team.key}-${String(number)}`
  exec(
    ctx.sql,
    'INSERT INTO Issue (tenant, id, teamId, identifier, number, title, description, priority, ' +
      'raw, url, createdAt, updatedAt, stateId, projectId, cycleId, assigneeId, creatorId, seq) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ctx.tenant,
    id,
    team.id,
    identifier,
    number,
    title as string | null,
    description as string | null,
    priority as number | null,
    writeRaw(raw),
    `${ISSUE_URL_BASE}/${identifier}`,
    WRITE_STAMP,
    WRITE_STAMP,
    refIds.stateId ?? null,
    refIds.projectId ?? null,
    refIds.cycleId ?? null,
    refIds.assigneeId ?? null,
    refIds.creatorId ?? null,
    await nextIssueSeq(ctx.sql, ctx.tenant),
  )
  await writeLabelLinks(ctx.sql, ctx.tenant, id, plainLabels(labelIds) ?? [])
  return dataReply({ issueCreate: { success: true, issue: { id, identifier } } })
}

// Seven updatable fields, and the list is not the create's list: cycleId and
// creatorId are settable at create and not afterwards. A key that is absent
// leaves the column alone; a key present with null clears it.
const UPDATABLE = [
  'title',
  'description',
  'stateId',
  'assigneeId',
  'priority',
  'projectId',
] as const

export const issueUpdate: Op = async (ctx, vars) => {
  const v = pyDictOr(vars)
  const row = await issueById(ctx, idOf(v.id))
  if (row === null) return errorsReply('issue not found')
  const input = pyDictOr(v.input)
  const requestedState =
    typeof input.stateId === 'string'
      ? one<WorkflowState>(
          ctx.sql,
          `${STATE} WHERE tenant = ? AND id = ? AND type = ? LIMIT 1`,
          ctx.tenant,
          input.stateId,
          'duplicate',
        )
      : null
  if (
    requestedState !== null &&
    (one<{ n: number }>(
      ctx.sql,
      'SELECT COUNT(*) AS n FROM IssueRelation WHERE tenant = ? AND issueId = ? AND type = ?',
      ctx.tenant,
      row.id,
      'duplicate',
    )?.n ?? 0) === 0
  )
    return errorsReply('missing duplicate relation')
  const raw = readRaw(row.raw)
  const sets = ['updatedAt = ?']
  const values: SQLInputValue[] = [WRITE_STAMP]
  for (const key of UPDATABLE) {
    if (!(key in input)) continue
    const natural = key === 'priority' ? isNaturalInt : isNaturalString
    const staged = stage(raw, key, input[key] ?? null, natural)
    sets.push(`${key} = ?`)
    values.push(key === 'priority' ? (staged as number | null) : (staged as string | null))
  }
  // The old fake assigned labelIds verbatim rather than list()-ing it, so an
  // update may leave a value that is not a list at all behind for the render
  // to iterate and raise on.
  if ('labelIds' in input) {
    const supplied = input.labelIds ?? null
    if (Array.isArray(supplied)) await applyLabels(ctx, raw, row.id, supplied)
    else {
      raw.labelIds = supplied
      await writeLabelLinks(ctx.sql, ctx.tenant, row.id, [])
    }
  }
  sets.push('raw = ?')
  values.push(writeRaw(raw))
  changeOne(
    ctx.sql,
    `UPDATE Issue SET ${sets.join(', ')} WHERE tenant = ? AND id = ?`,
    ...values,
    ctx.tenant,
    row.id,
  )
  return dataReply({
    issueUpdate: { success: true, issue: { id: row.id, identifier: row.identifier } },
  })
}

export const commentCreate: Op = async (ctx, vars) => {
  const input = pyDictOr(pyDictOr(vars).input)
  const row = await issueById(ctx, idOf(input.issueId))
  if (row === null) return errorsReply('issue not found')
  const id = ctx.minter.mint('cmt')
  const identifier = row.identifier
  const raw: RawMap = {}
  const body = stage(raw, 'body', 'body' in input ? input.body : '', isNaturalString)
  const seq =
    one<{ n: number }>(
      ctx.sql,
      'SELECT COUNT(*) AS n FROM Comment WHERE tenant = ? AND issueId = ?',
      ctx.tenant,
      row.id,
    )?.n ?? 0
  exec(
    ctx.sql,
    'INSERT INTO Comment (tenant, id, issueId, body, raw, url, createdAt, updatedAt, userId, seq) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
    ctx.tenant,
    id,
    row.id,
    body as string | null,
    writeRaw(raw),
    // f-string, so an issue with no identifier spells Python's None here.
    // No fixture omits one and issueCreate always mints one, but the old
    // fake's url is the oracle and this is what it wrote.
    `${ISSUE_URL_BASE}/${identifier ?? 'None'}#${id}`,
    WRITE_STAMP,
    WRITE_STAMP,
    seq,
  )
  return dataReply({
    commentCreate: {
      success: true,
      comment: { id, issue: { id: row.id, identifier } },
    },
  })
}

export const commentUpdate: Op = async (ctx, vars) => {
  const v = pyDictOr(vars)
  const id = idOf(v.id)
  const row: Comment | null =
    id === null
      ? null
      : one<Comment>(ctx.sql, `${COMMENT} WHERE tenant = ? AND id = ?`, ctx.tenant, id)
  if (row === null) return errorsReply('comment not found')
  const input = pyDictOr(v.input)
  const raw = readRaw(row.raw)
  if ('body' in input) {
    const body = stage(raw, 'body', input.body ?? null, isNaturalString) as string | null
    changeOne(
      ctx.sql,
      'UPDATE Comment SET updatedAt = ?, body = ?, raw = ? WHERE tenant = ? AND id = ?',
      WRITE_STAMP,
      body,
      writeRaw(raw),
      ctx.tenant,
      row.id,
    )
  } else {
    changeOne(
      ctx.sql,
      'UPDATE Comment SET updatedAt = ? WHERE tenant = ? AND id = ?',
      WRITE_STAMP,
      ctx.tenant,
      row.id,
    )
  }
  const parent = await issueById(ctx, row.issueId)
  return dataReply({
    commentUpdate: {
      success: true,
      comment: {
        id: row.id,
        issue: { id: row.issueId, identifier: parent === null ? null : parent.identifier },
      },
    },
  })
}

function displayIssue(value: Issue | null): JsonValue {
  return value === null ? null : { id: value.id, identifier: value.identifier, title: value.title }
}

async function relationNode(ctx: Ctx<C>, row: IssueRelation): Promise<JsonValue> {
  const source = await issueById(ctx, row.issueId)
  const target = await issueById(ctx, row.relatedIssueId)
  return {
    id: row.id,
    type: row.type,
    issue: displayIssue(source),
    relatedIssue: displayIssue(target),
  }
}

async function relationPage(
  ctx: Ctx<C>,
  vars: JsonValue | undefined,
  incoming: boolean,
): Promise<JsonValue> {
  const v = pyDictOr(vars)
  const parent = await issueById(ctx, idOf(v.issueId ?? v.id))
  if (parent === null) return null
  const rows = incoming
    ? relationsWhere(ctx, 'relatedIssueId = ? ORDER BY seq ASC', parent.id)
    : relationsWhere(ctx, 'issueId = ? ORDER BY seq ASC', parent.id)
  const cursor = asString(v.after)
  const offset = cursor === null ? 0 : rows.findIndex((row) => row.id === cursor) + 1
  const first = typeof v.first === 'number' ? v.first : 100
  const page = rows.slice(offset, offset + first)
  return {
    nodes: await Promise.all(page.map((row) => relationNode(ctx, row))),
    pageInfo: { hasNextPage: offset + first < rows.length, endCursor: page.at(-1)?.id ?? null },
  }
}

export const outgoingRelations: Op = async (ctx, vars) => {
  const page = await relationPage(ctx, vars, false)
  return dataReply({ issue: page === null ? null : { relations: page } })
}

export const incomingRelations: Op = async (ctx, vars) => {
  const page = await relationPage(ctx, vars, true)
  return dataReply({ issue: page === null ? null : { inverseRelations: page } })
}

export const listRelations: Op = async (ctx, vars) => {
  const v = pyDictOr(vars)
  const parent = await issueById(ctx, idOf(v.issueId ?? v.id))
  if (parent === null) return dataReply({ issue: null })
  return dataReply({
    issue: {
      id: parent.id,
      identifier: parent.identifier,
      title: parent.title,
      relations: await relationPage(ctx, vars, false),
      inverseRelations: await relationPage(ctx, vars, true),
    },
  })
}

export const createRelation: Op = async (ctx, vars) => {
  const input = pyDictOr(pyDictOr(vars).input)
  const source = await issueById(ctx, idOf(input.issueId))
  const target = await issueById(ctx, idOf(input.relatedIssueId))
  const type = asString(input.type)
  if (source === null || target === null) return errorsReply('issue not found')
  if (source.id === target.id) return errorsReply('an issue cannot relate to itself')
  if (type === null || !['blocks', 'related', 'duplicate'].includes(type))
    return errorsReply('invalid relation type')
  const existing =
    type === 'duplicate'
      ? relationsWhere(ctx, 'issueId = ? AND type = ? LIMIT 1', source.id, type)
      : relationsWhere(
          ctx,
          'issueId = ? AND type = ? AND relatedIssueId = ? LIMIT 1',
          source.id,
          type,
          target.id,
        )
  if (existing.length > 0) return errorsReply('relation already exists')
  const top = one<{ n: number | null }>(
    ctx.sql,
    'SELECT MAX(seq) AS n FROM IssueRelation WHERE tenant = ?',
    ctx.tenant,
  )
  const seq = (top?.n ?? -1) + 1
  const id = `relation_${source.id}_${target.id}_${type}`
  exec(
    ctx.sql,
    'INSERT INTO IssueRelation (tenant, id, issueId, relatedIssueId, type, seq, previousStateId) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ctx.tenant,
    id,
    source.id,
    target.id,
    type,
    seq,
    type === 'duplicate' ? source.stateId : null,
  )
  const row = relationsWhere(ctx, 'id = ?', id)[0]
  if (row === undefined) throw new Error(`linear fake: relation ${id} vanished as it was made`)
  if (type === 'duplicate') {
    let stateId = one<{ id: string }>(
      ctx.sql,
      'SELECT id FROM WorkflowState WHERE tenant = ? AND teamId = ? AND type = ? LIMIT 1',
      ctx.tenant,
      source.teamId,
      'duplicate',
    )?.id
    if (stateId === undefined) {
      stateId = `duplicate_${source.teamId}`
      exec(
        ctx.sql,
        'INSERT INTO WorkflowState (tenant, id, teamId, name, type, seq) VALUES (?, ?, ?, ?, ?, ?)',
        ctx.tenant,
        stateId,
        source.teamId,
        'Duplicate',
        'duplicate',
        1000,
      )
    }
    const raw = readRaw(source.raw)
    delete raw.stateId
    changeOne(
      ctx.sql,
      'UPDATE Issue SET stateId = ?, raw = ?, updatedAt = ? WHERE tenant = ? AND id = ?',
      stateId,
      writeRaw(raw),
      WRITE_STAMP,
      ctx.tenant,
      source.id,
    )
  }
  return dataReply({
    issueRelationCreate: { success: true, issueRelation: await relationNode(ctx, row) },
  })
}

export const deleteRelation: Op = async (ctx, vars) => {
  const id = idOf(pyDictOr(vars).id)
  const row = id === null ? null : (relationsWhere(ctx, 'id = ? LIMIT 1', id)[0] ?? null)
  if (row === null) return errorsReply('relation not found')
  if (row.type === 'duplicate') {
    const source = await issueById(ctx, row.issueId)
    if (source !== null) {
      const raw = readRaw(source.raw)
      delete raw.stateId
      changeOne(
        ctx.sql,
        'UPDATE Issue SET stateId = ?, raw = ?, updatedAt = ? WHERE tenant = ? AND id = ?',
        row.previousStateId,
        writeRaw(raw),
        WRITE_STAMP,
        ctx.tenant,
        row.issueId,
      )
    }
  }
  changeOne(ctx.sql, 'DELETE FROM IssueRelation WHERE tenant = ? AND id = ?', ctx.tenant, row.id)
  return dataReply({ issueRelationDelete: { success: true } })
}

// A Map, not an object literal. `OPS[name.toLowerCase()]` reached
// Object.prototype for two names the operation pattern accepts:
// `query constructor` found the Object constructor and `query __proto__`
// found the prototype, so both answered 500 where the old fake answered
// `unknown operation`.
export const OPS = new Map<string, Op>(
  Object.entries({
    getissueid: issue,
    listissuerelations: listRelations,
    getoutgoingrelationspage: outgoingRelations,
    getincomingrelationspage: incomingRelations,
    findissuerelation: outgoingRelations,
    createissuerelation: createRelation,
    deleteissuerelation: deleteRelation,
    teams,
    teammembers: teamMembers,
    teamissues: teamIssues,
    teamprojects: teamProjects,
    teamcycles: teamCycles,
    teamlabels: teamLabels,
    teamdocuments: teamDocuments,
    issue,
    issuecomments: issueComments,
    issuelookup: issueLookup,
    userlookup: userLookup,
    issuesearch: issueSearch,
    issuecreate: issueCreate,
    issueupdate: issueUpdate,
    commentcreate: commentCreate,
    commentupdate: commentUpdate,
  }),
)
