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

import type { Prisma } from '../../generated/linear/index.js'
import type { Comment, Issue, WorkflowState } from '../../generated/linear/index.js'
import { idWhere, tenantWhere } from '../kit/typescript/tenant.ts'
import { plainWords } from '../kit/typescript/words.ts'
import type { Ctx } from '../kit/typescript/route.ts'
import type { JsonValue, Reply } from '../kit/typescript/types.ts'
import { ISSUE_URL_BASE, WRITE_STAMP, config } from './config.ts'
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
  byTeamThenSeq,
  labelsOf,
  loadLabelLinks,
  loadRefs,
  loadTeams,
  nextIssueSeq,
  teamSeqOf,
  writeLabelLinks,
} from './world.ts'

// The raw `variables` value, not a parsed dict. `op_teams` ignored it, so a
// variables of `[1]` answered 200 there and 500 in every other op; opening the
// dict inside each op that reads one keeps that.
export type Op = (ctx: Ctx<C>, vars: JsonValue | undefined) => Promise<Reply>

const SEQ_ASC = { seq: 'asc' } as const

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
  await writeLabelLinks(ctx.db, ctx.tenant, issueId, plain ?? [])
}

function scope(ctx: Ctx<C>): Record<string, JsonValue> {
  return tenantWhere(ctx.tenant, config.tenantKind)
}

// A missing teamId is not an error in this fake: the old one indexed a dict
// with None and got the empty list, so the connection comes back empty and
// the wrapper object is still there.
function teamIdOf(vars: JsonValue | undefined): string {
  return idOf(pyDictOr(vars).teamId) ?? ''
}

export const teams: Op = async (ctx) => {
  const rows = await loadTeams(ctx.db, ctx.tenant)
  const states = await ctx.db.workflowState.findMany({ where: scope(ctx), orderBy: SEQ_ASC })
  const byTeam = new Map<string, WorkflowState[]>()
  for (const state of states) {
    const live = byTeam.get(state.teamId)
    if (live === undefined) byTeam.set(state.teamId, [state])
    else live.push(state)
  }
  return dataReply({ teams: connection(rows.map((t) => teamNode(t, byTeam.get(t.id) ?? []))) })
}

export const teamMembers: Op = async (ctx, vars) => {
  const rows = await ctx.db.user.findMany({
    where: { ...scope(ctx), teamId: teamIdOf(vars) },
    orderBy: SEQ_ASC,
  })
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
  const rows = await ctx.db.issue.findMany({
    where: {
      ...scope(ctx),
      teamId: teamIdOf(vars),
      ...(projects === null ? {} : { projectId: { in: projects } }),
    },
    orderBy: SEQ_ASC,
  })
  const refs = await loadRefs(ctx.db, ctx.tenant)
  const links = await loadLabelLinks(ctx.db, ctx.tenant)
  return dataReply({
    team: { issues: connection(rows.map((i) => issueNode(refs, i, labelsOf(links, i.id)))) },
  })
}

export const teamProjects: Op = async (ctx, vars) => {
  const rows = await ctx.db.project.findMany({
    where: { ...scope(ctx), teamId: teamIdOf(vars) },
    orderBy: SEQ_ASC,
  })
  return dataReply({ team: { projects: connection(rows.map(projectNode)) } })
}

export const teamCycles: Op = async (ctx, vars) => {
  const rows = await ctx.db.cycle.findMany({
    where: { ...scope(ctx), teamId: teamIdOf(vars) },
    orderBy: SEQ_ASC,
  })
  return dataReply({ team: { cycles: connection(rows.map(cycleNode)) } })
}

export const teamLabels: Op = async (ctx, vars) => {
  const rows = await ctx.db.label.findMany({
    where: { ...scope(ctx), teamId: teamIdOf(vars) },
    orderBy: SEQ_ASC,
  })
  return dataReply({ team: { labels: connection(rows.map(labelNode)) } })
}

export const teamDocuments: Op = async (ctx, vars) => {
  const rows = await ctx.db.document.findMany({
    where: { ...scope(ctx), teamId: teamIdOf(vars) },
    orderBy: SEQ_ASC,
  })
  const refs = await loadRefs(ctx.db, ctx.tenant)
  return dataReply({ documents: connection(rows.map((d) => documentNode(refs, d))) })
}

async function issueById(ctx: Ctx<C>, id: string | null): Promise<Issue | null> {
  if (id === null) return null
  return ctx.db.issue.findUnique({
    where: idWhere<Prisma.IssueWhereUniqueInput>(ctx.tenant, id, config.tenantKind),
  })
}

export const issue: Op = async (ctx, vars) => {
  const row = await issueById(ctx, idOf(pyDictOr(vars).issueId))
  if (row === null) return dataReply({ issue: null })
  const refs = await loadRefs(ctx.db, ctx.tenant)
  const links = await loadLabelLinks(ctx.db, ctx.tenant)
  return dataReply({ issue: issueNode(refs, row, labelsOf(links, row.id)) })
}

export const issueComments: Op = async (ctx, vars) => {
  const rows = await ctx.db.comment.findMany({
    where: { ...scope(ctx), issueId: idOf(pyDictOr(vars).issueId) ?? '' },
    orderBy: SEQ_ASC,
  })
  const refs = await loadRefs(ctx.db, ctx.tenant)
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
    const team = await ctx.db.team.findFirst({ where: { ...scope(ctx), key: teamKey } })
    if (team !== null) {
      const row = await ctx.db.issue.findFirst({
        where: { ...scope(ctx), teamId: team.id, number: pyInt(wanted) },
        orderBy: SEQ_ASC,
      })
      if (row !== null) nodes.push({ id: row.id, identifier: row.identifier })
    }
  }
  return dataReply({ issues: { nodes } })
}

export const userLookup: Op = async (ctx, vars) => {
  const email = pyDictOr(vars).email ?? null
  const teams = await loadTeams(ctx.db, ctx.tenant)
  const rows = byTeamThenSeq(
    await ctx.db.user.findMany({ where: scope(ctx), orderBy: SEQ_ASC }),
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
  const rows = await ctx.db.issue.findMany({ where: scope(ctx), orderBy: SEQ_ASC })
  const refs = await loadRefs(ctx.db, ctx.tenant)
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
      : await ctx.db.team.findUnique({
          where: idWhere<Prisma.TeamWhereUniqueInput>(ctx.tenant, teamId, config.tenantKind),
        })
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
  const top = await ctx.db.issue.aggregate({
    where: { ...scope(ctx), teamId: team.id },
    _max: { number: true },
  })
  const number = (top._max.number ?? 0) + 1
  const identifier = `${team.key}-${String(number)}`
  await ctx.db.issue.create({
    data: {
      tenant: ctx.tenant,
      id,
      teamId: team.id,
      identifier,
      number,
      title: title as string | null,
      description: description as string | null,
      priority: priority as number | null,
      raw: writeRaw(raw),
      url: `${ISSUE_URL_BASE}/${identifier}`,
      createdAt: WRITE_STAMP,
      updatedAt: WRITE_STAMP,
      stateId: refIds.stateId ?? null,
      projectId: refIds.projectId ?? null,
      cycleId: refIds.cycleId ?? null,
      assigneeId: refIds.assigneeId ?? null,
      creatorId: refIds.creatorId ?? null,
      seq: await nextIssueSeq(ctx.db, ctx.tenant),
    },
  })
  await writeLabelLinks(ctx.db, ctx.tenant, id, plainLabels(labelIds) ?? [])
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
  const raw = readRaw(row.raw)
  const data: Prisma.IssueUncheckedUpdateInput = { updatedAt: WRITE_STAMP }
  for (const key of UPDATABLE) {
    if (!(key in input)) continue
    const natural = key === 'priority' ? isNaturalInt : isNaturalString
    const staged = stage(raw, key, input[key] ?? null, natural)
    if (key === 'priority') data.priority = staged as number | null
    else data[key] = staged as string | null
  }
  // The old fake assigned labelIds verbatim rather than list()-ing it, so an
  // update may leave a value that is not a list at all behind for the render
  // to iterate and raise on.
  if ('labelIds' in input) {
    const supplied = input.labelIds ?? null
    if (Array.isArray(supplied)) await applyLabels(ctx, raw, row.id, supplied)
    else {
      raw.labelIds = supplied
      await writeLabelLinks(ctx.db, ctx.tenant, row.id, [])
    }
  }
  data.raw = writeRaw(raw)
  await ctx.db.issue.update({
    where: idWhere<Prisma.IssueWhereUniqueInput>(ctx.tenant, row.id, config.tenantKind),
    data,
  })
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
  const seq = await ctx.db.comment.count({ where: { ...scope(ctx), issueId: row.id } })
  await ctx.db.comment.create({
    data: {
      tenant: ctx.tenant,
      id,
      issueId: row.id,
      body: body as string | null,
      raw: writeRaw(raw),
      // f-string, so an issue with no identifier spells Python's None here.
      // No fixture omits one and issueCreate always mints one, but the old
      // fake's url is the oracle and this is what it wrote.
      url: `${ISSUE_URL_BASE}/${identifier ?? 'None'}#${id}`,
      createdAt: WRITE_STAMP,
      updatedAt: WRITE_STAMP,
      userId: null,
      seq,
    },
  })
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
      : await ctx.db.comment.findUnique({
          where: idWhere<Prisma.CommentWhereUniqueInput>(ctx.tenant, id, config.tenantKind),
        })
  if (row === null) return errorsReply('comment not found')
  const input = pyDictOr(v.input)
  const raw = readRaw(row.raw)
  const data: Prisma.CommentUncheckedUpdateInput = { updatedAt: WRITE_STAMP }
  if ('body' in input) {
    data.body = stage(raw, 'body', input.body ?? null, isNaturalString) as string | null
    data.raw = writeRaw(raw)
  }
  await ctx.db.comment.update({
    where: idWhere<Prisma.CommentWhereUniqueInput>(ctx.tenant, row.id, config.tenantKind),
    data,
  })
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

// A Map, not an object literal. `OPS[name.toLowerCase()]` reached
// Object.prototype for two names the operation pattern accepts:
// `query constructor` found the Object constructor and `query __proto__`
// found the prototype, so both answered 500 where the old fake answered
// `unknown operation`.
export const OPS = new Map<string, Op>(
  Object.entries({
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
