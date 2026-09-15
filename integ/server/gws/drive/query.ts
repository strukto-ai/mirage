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

import { docPlainText } from '../docs/body.ts'
import type { GwsState } from '../store/state.ts'
import type { DriveItem } from '../store/types.ts'

export interface QueryClause {
  field: string
  op: string
  value: string
}

export function unescapeQ(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\\' && i + 1 < value.length) {
      i += 1
      out += value[i]
      continue
    }
    out += value[i]
  }
  return out
}

export type QueryExpression =
  | { kind: 'clause'; clause: QueryClause }
  | { kind: 'and' | 'or'; left: QueryExpression; right: QueryExpression }
  | { kind: 'not'; operand: QueryExpression }

const QUERY_TOKEN = /\s*(?:'((?:[^'\\]|\\.)*)'|([()]|!=|>=|<=|=|>|<)|([A-Za-z][A-Za-z0-9_]*))/y
const QUERY_OPERATORS: Record<string, readonly string[]> = {
  parents: ['in'],
  name: ['=', '!=', 'contains'],
  mimeType: ['=', '!=', 'contains'],
  fullText: ['contains'],
  trashed: ['=', '!='],
  modifiedTime: ['=', '!=', '>', '>=', '<', '<='],
}

interface QueryToken {
  value: string
  quoted: boolean
}

class QueryReader {
  private position = 0
  constructor(private readonly tokens: QueryToken[]) {}

  private take(value: string): boolean {
    const token = this.tokens[this.position]
    if (token === undefined || token.quoted || token.value !== value) return false
    this.position += 1
    return true
  }

  private next(): QueryToken {
    const token = this.tokens[this.position++]
    if (token === undefined) throw new Error('incomplete query')
    return token
  }

  parse(): QueryExpression {
    const result = this.expression(0)
    if (this.position !== this.tokens.length) throw new Error('unexpected query token')
    return result
  }

  private expression(depth: number): QueryExpression {
    let left = this.conjunction(depth)
    while (this.take('or')) left = { kind: 'or', left, right: this.conjunction(depth) }
    return left
  }

  private conjunction(depth: number): QueryExpression {
    let left = this.atom(depth)
    while (this.take('and')) left = { kind: 'and', left, right: this.atom(depth) }
    return left
  }

  private atom(depth: number): QueryExpression {
    if (depth > 128) throw new Error('query nesting too deep')
    if (this.take('not')) return { kind: 'not', operand: this.atom(depth + 1) }
    if (this.take('(')) {
      const inner = this.expression(depth + 1)
      if (!this.take(')')) throw new Error('unclosed query group')
      return inner
    }
    const first = this.next()
    const operator = this.next()
    const last = this.next()
    const field = first.quoted ? last.value : first.value
    const value = first.quoted ? first : last
    const op = operator.value
    if (!Object.hasOwn(QUERY_OPERATORS, field)) throw new Error(`unsupported query field: ${field}`)
    if (
      operator.quoted ||
      (op === 'in' && !first.quoted) ||
      (first.quoted && (last.quoted || op !== 'in')) ||
      !QUERY_OPERATORS[field]?.includes(op)
    ) {
      throw new Error(`unsupported query clause: ${field} ${op}`)
    }
    if (
      field === 'trashed' ? value.quoted || !['true', 'false'].includes(value.value) : !value.quoted
    ) {
      throw new Error(`invalid query value for ${field}`)
    }
    return { kind: 'clause', clause: { field, op, value: value.value } }
  }
}

export function parseDriveQuery(q: string): QueryExpression {
  const tokens: QueryToken[] = []
  let position = 0
  while (position < q.trimEnd().length) {
    QUERY_TOKEN.lastIndex = position
    const match = QUERY_TOKEN.exec(q)
    if (match === null) throw new Error(`invalid query at ${String(position)}`)
    tokens.push({
      value: match[1] === undefined ? (match[2] ?? match[3] ?? '') : unescapeQ(match[1]),
      quoted: match[1] !== undefined,
    })
    position = QUERY_TOKEN.lastIndex
  }
  return new QueryReader(tokens).parse()
}

export function matchQuery(st: GwsState, item: DriveItem, query: QueryExpression): boolean {
  switch (query.kind) {
    case 'clause':
      return matchClause(st, item, query.clause)
    case 'not':
      return !matchQuery(st, item, query.operand)
    case 'and':
      return matchQuery(st, item, query.left) && matchQuery(st, item, query.right)
    case 'or':
      return matchQuery(st, item, query.left) || matchQuery(st, item, query.right)
  }
}

// Everything the live index searches for `fullText`: the display name, a
// Doc's text across every tab, a Sheet's cell values, and an uploaded file's bytes.
// Case-insensitive, the way the real search index answers.
export function fullTextOf(st: GwsState, item: DriveItem): string {
  const parts: string[] = [item.name]
  const doc = st.docs.get(item.id)
  if (doc !== undefined) parts.push(docPlainText(doc))
  const sheet = st.sheets.get(item.id)
  if (sheet !== undefined) {
    for (const tab of sheet.tabs) parts.push([...tab.cells.values()].join(' '))
  }
  if (item.content.length > 0) parts.push(item.content.toString('utf8'))
  return parts.join('\n')
}

export function matchClause(st: GwsState, item: DriveItem, clause: QueryClause): boolean {
  switch (clause.field) {
    case 'parents':
      return item.parents.includes(clause.value)
    case 'name':
      if (clause.op === 'contains') return item.name.includes(clause.value)
      if (clause.op === '!=') return item.name !== clause.value
      return item.name === clause.value
    case 'mimeType':
      if (clause.op === 'contains') return item.mimeType.includes(clause.value)
      if (clause.op === '!=') return item.mimeType !== clause.value
      return item.mimeType === clause.value
    case 'fullText':
      // The live API defines only `contains` for fullText; any other
      // operator is an invalid query, reported as the 400 the caller
      // catches below.
      if (clause.op !== 'contains') {
        throw new Error(`unsupported operator for fullText: ${clause.op}`)
      }
      return fullTextOf(st, item).toLowerCase().includes(clause.value.toLowerCase())
    case 'trashed':
      return clause.op === '!='
        ? item.trashed !== (clause.value === 'true')
        : item.trashed === (clause.value === 'true')
    case 'modifiedTime': {
      if (clause.op === '!=') return item.modifiedTime !== clause.value
      if (clause.op === '>=') return item.modifiedTime >= clause.value
      if (clause.op === '<') return item.modifiedTime < clause.value
      if (clause.op === '>') return item.modifiedTime > clause.value
      if (clause.op === '<=') return item.modifiedTime <= clause.value
      return item.modifiedTime === clause.value
    }
    default:
      throw new Error(`unsupported query field: ${clause.field}`)
  }
}
