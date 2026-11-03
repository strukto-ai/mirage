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

// Relation behavior adapted from schpet/linear-cli v3.1.0,
// 02571d34be662e5487204841fb80bf23ed79b4f0, ISC.
// Copyright (c) Peter Schilling and contributors.
// See licenses/third_party/schpet-linear-cli.txt for the permission notice.

import type { LinearAccessor } from '../../../../../accessor/linear.ts'
import {
  RelationType,
  getRelationIssue,
  issueRelationCreate,
  issueRelationDelete,
  listIssueRelations,
  relationInput,
} from '../../../../../core/linear/client.ts'
import { normalizeRelation } from '../../../../../core/linear/normalize.ts'
import { jsonBytes } from '../../../../../core/render/json.ts'
import type { CommandFnResult, Context } from '../../../../config.ts'
import { FlagView } from '../../../../spec/flag_view.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import { enoent } from '../../../../../errors/fs.ts'

const ISSUE_KEY_RE = /^[A-Za-z0-9]+-[1-9][0-9]*$/
const RAW_ID_RE =
  /^(?:[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_-]+)$/

export function prepareReference(token: string): string {
  if (ISSUE_KEY_RE.test(token)) return token.toUpperCase()
  if (RAW_ID_RE.test(token)) return token
  let candidate = token.trim()
  if (/^(?:www\.)?linear\.app\//i.test(candidate)) candidate = `https://${candidate}`
  try {
    if (URL.canParse(candidate)) {
      const url = new URL(candidate)
      const parts = url.pathname
        .split('/')
        .filter((part) => part !== '')
        .map(decodeURIComponent)
      const key = parts[2]
      const host = url.hostname.toLowerCase().replace(/\.$/, '')
      const anchorOk = url.hash === '' || /^#comment-[0-9a-f]{8}$/.test(url.hash)
      if (
        ['http:', 'https:'].includes(url.protocol) &&
        ['linear.app', 'www.linear.app'].includes(host) &&
        url.port === '' &&
        url.username === '' &&
        url.password === '' &&
        parts[1] === 'issue' &&
        key !== undefined &&
        ISSUE_KEY_RE.test(key) &&
        anchorOk &&
        !parts.some((part) => part === '.' || part === '..')
      )
        return key.toUpperCase()
    }
  } catch (error) {
    throw new Error(`invalid issue reference: ${token}`, { cause: error })
  }
  throw new Error(`invalid issue reference: ${token}`)
}

export function relationOperands(texts: string[]): readonly [string, RelationType, string] {
  const [source, kind, target] = texts
  if (texts.length !== 3 || source === undefined || kind === undefined || target === undefined)
    throw new Error('expected ISSUE RELATION RELATED')
  const relationType = Object.values(RelationType).find(
    (value) => value.toLowerCase() === kind.toLowerCase(),
  )
  if (relationType === undefined) throw new Error(`invalid relation type: ${kind}`)
  return [prepareReference(source), relationType, prepareReference(target)]
}

export async function add(
  accessor: LinearAccessor,
  _paths: PathSpec[],
  texts: string[],
  _ctx: Context,
): Promise<CommandFnResult> {
  const [source, kind, target] = relationOperands(texts)
  const issue = await getRelationIssue(accessor.transport, source)
  const related = await getRelationIssue(accessor.transport, target)
  const relation = await issueRelationCreate(
    accessor.transport,
    relationInput(kind, issue.id, related.id),
  )
  return [jsonBytes(normalizeRelation(relation, issue.id)), new IOResult()]
}

export async function listRelations(
  accessor: LinearAccessor,
  _paths: PathSpec[],
  texts: string[],
  _ctx: Context,
): Promise<CommandFnResult> {
  const [reference] = texts
  if (texts.length !== 1 || reference === undefined) throw new Error('expected ISSUE')
  const issue = await getRelationIssue(accessor.transport, prepareReference(reference))
  const outgoing = await listIssueRelations(accessor.transport, issue.id)
  const incoming = await listIssueRelations(accessor.transport, issue.id, true)
  return [
    jsonBytes([...outgoing, ...incoming].map((row) => normalizeRelation(row, issue.id))),
    new IOResult(),
  ]
}

export async function deleteRelation(
  accessor: LinearAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const [source, kind, target] = relationOperands(texts)
  const issue = await getRelationIssue(accessor.transport, source)
  const related = await getRelationIssue(accessor.transport, target)
  const payload = relationInput(kind, issue.id, related.id)
  const relations = await listIssueRelations(accessor.transport, payload.issueId)
  const relation = relations.find(
    (row) => row.type === payload.type && row.relatedIssue.id === payload.relatedIssueId,
  )
  if (relation === undefined) throw enoent(`relation ${source} ${kind} ${target}`)
  if (!new FlagView(ctx.flags).asBool('yes'))
    throw new Error('--yes is required to delete a relation')
  await issueRelationDelete(accessor.transport, relation.id)
  return [jsonBytes(normalizeRelation(relation, issue.id)), new IOResult()]
}
