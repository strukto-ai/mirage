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

import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { toNumber } from '../utils/formatting.ts'
import {
  AwkBlock,
  AwkBoolOp,
  AwkBuiltin,
  AwkCmpOp,
  CMP_OP_PATTERN,
  FIELD_PREFIX,
  PRINT_STMT,
} from './awk_types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function splitFields(line: string, fs: string | null): string[] {
  if (fs === null || fs === ' ') return line.split(/\s+/).filter((s) => s !== '')
  if (fs === '') return Array.from(line)
  const re = fs.length === 1 ? new RegExp(escapeRegex(fs)) : new RegExp(fs)
  return line.split(re)
}

export function parseProgram(program: string): [string, string] {
  const trimmed = program.trim()
  if (trimmed.startsWith('{')) {
    return ['', trimmed.slice(1).trimEnd().replace(/\}$/, '').trim()]
  }
  if (trimmed.includes('{')) {
    const idx = trimmed.indexOf('{')
    const condition = trimmed.slice(0, idx).trim()
    const action = trimmed
      .slice(idx + 1)
      .trimEnd()
      .replace(/\}$/, '')
      .trim()
    return [condition, action]
  }
  return [trimmed, '']
}

function resolveToken(tok: string, fieldMap: Record<string, string>): string {
  if (tok.startsWith(FIELD_PREFIX)) {
    const inner = tok.slice(1)
    if (inner in fieldMap) {
      const ref = fieldMap[inner] ?? ''
      return fieldMap[`${FIELD_PREFIX}${ref}`] ?? ''
    }
    return fieldMap[tok] ?? tok
  }
  return fieldMap[tok] ?? tok
}

function evalSimple(rawExpr: string, fieldMap: Record<string, string>): boolean {
  const expr = rawExpr.trim()
  const cmp = new RegExp(`(.+?)\\s*(${CMP_OP_PATTERN.source})\\s*(.+)`).exec(expr)
  if (cmp === null) {
    if (expr.startsWith('/') && expr.endsWith('/')) {
      const regex = expr.slice(1, -1)
      return new RegExp(regex).test(fieldMap[AwkBuiltin.REC] ?? '')
    }
    const val = resolveToken(expr, fieldMap)
    const n = Number.parseFloat(val)
    if (!Number.isNaN(n)) return n !== 0
    return val !== ''
  }
  const lhsRaw = (cmp[1] ?? '').trim()
  const op = (cmp[2] ?? '') as AwkCmpOp
  let rhsRaw = (cmp[3] ?? '').trim()
  rhsRaw = rhsRaw.replace(/^"|"$/g, '')
  const lhs = resolveToken(lhsRaw, fieldMap)
  const rhs =
    rhsRaw.startsWith(FIELD_PREFIX) || rhsRaw in fieldMap ? resolveToken(rhsRaw, fieldMap) : rhsRaw
  const lhsN = Number.parseFloat(lhs)
  const rhsN = Number.parseFloat(rhs)
  if (!Number.isNaN(lhsN) && !Number.isNaN(rhsN)) {
    if (op === AwkCmpOp.EQ) return lhsN === rhsN
    if (op === AwkCmpOp.NE) return lhsN !== rhsN
    if (op === AwkCmpOp.GT) return lhsN > rhsN
    if (op === AwkCmpOp.LT) return lhsN < rhsN
    if (op === AwkCmpOp.GE) return lhsN >= rhsN
    return lhsN <= rhsN
  }
  if (op === AwkCmpOp.EQ) return lhs === rhs
  if (op === AwkCmpOp.NE) return lhs !== rhs
  return false
}

export function evalCondition(condition: string, fieldMap: Record<string, string>): boolean {
  const cond = condition.trim()
  if (cond === AwkBlock.BEGIN || cond === AwkBlock.END) return false
  if (cond.includes(AwkBoolOp.OR)) {
    return cond.split(AwkBoolOp.OR).some((p) => evalCondition(p, fieldMap))
  }
  if (cond.includes(AwkBoolOp.AND)) {
    return cond.split(AwkBoolOp.AND).every((p) => evalCondition(p, fieldMap))
  }
  return evalSimple(cond, fieldMap)
}

export function evalAction(action: string, fieldMap: Record<string, string>): string | null {
  const parts: string[] = []
  let printed = false
  for (const rawStmt of action.split(';')) {
    const stmt = rawStmt.trim()
    if (!stmt.startsWith(PRINT_STMT)) continue
    printed = true
    const args = stmt.slice(PRINT_STMT.length).trim()
    if (args === '') {
      parts.push(fieldMap[AwkBuiltin.REC] ?? '')
      continue
    }
    const tokens = args.split(/,\s*/)
    const vals: string[] = []
    for (const raw of tokens) {
      const tok = raw.trim()
      if (tok.startsWith('"') && tok.endsWith('"')) {
        vals.push(tok.slice(1, -1))
      } else {
        vals.push(resolveToken(tok, fieldMap))
      }
    }
    parts.push(vals.join(' '))
  }
  return printed ? parts.join('\n') : null
}

export function buildFieldMap(
  line: string,
  fs: string | null,
  nr: number,
  variables: Record<string, string>,
): Record<string, string> {
  const fields = splitFields(line, fs)
  const fieldMap: Record<string, string> = {
    [AwkBuiltin.REC]: line,
    [AwkBuiltin.NR]: String(nr),
    [AwkBuiltin.NF]: String(fields.length),
  }
  for (let i = 0; i < fields.length; i++)
    fieldMap[`${FIELD_PREFIX}${String(i + 1)}`] = fields[i] ?? ''
  for (const [k, v] of Object.entries(variables)) fieldMap[k] = v
  return fieldMap
}

export function parseBlocks(program: string): [string, string, string] {
  let begin = ''
  let end = ''
  let main = program
  const beginRe = new RegExp(`^${AwkBlock.BEGIN}\\s*\\{([^}]*)\\}\\s*([\\s\\S]*)`)
  const beginMatch = beginRe.exec(program)
  if (beginMatch !== null) {
    begin = (beginMatch[1] ?? '').trim()
    main = (beginMatch[2] ?? '').trim()
  }
  const endRe = new RegExp(`${AwkBlock.END}\\s*\\{([^}]*)\\}\\s*$`)
  const endMatch = endRe.exec(main)
  if (endMatch !== null) {
    end = (endMatch[1] ?? '').trim()
    main = main.slice(0, endMatch.index).trim()
  }
  return [begin, main, end]
}

export function evalAccumulator(
  action: string,
  fieldMap: Record<string, string>,
  accum: Record<string, number>,
): void {
  for (const rawStmt of action.split(';')) {
    const stmt = rawStmt.trim()
    const m = /^(\w+)\s*\+=\s*(.+)/.exec(stmt)
    if (m !== null) {
      const variable = m[1] ?? ''
      const expr = (m[2] ?? '').trim()
      const val = fieldMap[expr] ?? expr
      accum[variable] = (accum[variable] ?? 0) + toNumber(val)
    }
  }
}

export async function* awkStream(
  sources: AsyncIterable<Uint8Array>[],
  program: string,
  fs: string | null,
  variables: Record<string, string>,
): AsyncIterable<Uint8Array> {
  const [begin, main, end] = parseBlocks(program)
  const [condition, action] = main !== '' ? parseProgram(main) : ['', '']
  const accum: Record<string, number> = {}
  let nr = 0

  if (begin !== '') {
    const beginMap: Record<string, string> = {
      [AwkBuiltin.REC]: '',
      [AwkBuiltin.NR]: '0',
      [AwkBuiltin.NF]: '0',
      ...variables,
    }
    const result = evalAction(begin, beginMap)
    if (result !== null) yield ENC.encode(result + '\n')
  }

  for (const source of sources) {
    const iter = new AsyncLineIterator(source)
    for await (const lineBytes of iter) {
      nr += 1
      if (main === '') continue
      const line = DEC.decode(lineBytes)
      const fieldMap = buildFieldMap(line, fs, nr, variables)
      if (condition !== '' && !evalCondition(condition, fieldMap)) continue
      evalAccumulator(action, fieldMap, accum)
      const result = action !== '' ? evalAction(action, fieldMap) : line
      if (result !== null) yield ENC.encode(result + '\n')
    }
  }

  if (end !== '') {
    const endMap: Record<string, string> = {
      [AwkBuiltin.REC]: '',
      [AwkBuiltin.NR]: String(nr),
      [AwkBuiltin.NF]: '0',
      ...variables,
    }
    for (const [k, v] of Object.entries(accum)) endMap[k] = String(v)
    const result = evalAction(end, endMap)
    if (result !== null) yield ENC.encode(result + '\n')
  }
}
