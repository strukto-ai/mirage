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

function splitFields(line: string, fs: string): string[] {
  if (fs === '') return line.split(/\s+/).filter((s) => s !== '')
  const re = fs.length === 1 ? new RegExp(escapeRegex(fs)) : new RegExp(fs)
  return line.split(re)
}

function parseProgram(program: string): [string, string] {
  const trimmed = program.trim()
  if (trimmed.startsWith('{')) return ['', trimmed.slice(1).replace(/\}$/, '')]
  if (trimmed.includes('{')) {
    const idx = trimmed.indexOf('{')
    const condition = trimmed.slice(0, idx).trim()
    const action = trimmed
      .slice(idx + 1)
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

function evalCondition(condition: string, fieldMap: Record<string, string>): boolean {
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

function evalAction(action: string, fieldMap: Record<string, string>): string {
  const parts: string[] = []
  for (const rawStmt of action.split(';')) {
    const stmt = rawStmt.trim()
    if (stmt === '') continue
    if (stmt.startsWith(PRINT_STMT)) {
      const args = stmt.slice(PRINT_STMT.length).trim()
      if (args === '') {
        parts.push(fieldMap[AwkBuiltin.REC] ?? '')
      } else {
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
    }
  }
  return parts.join('\n')
}

function buildFieldMap(
  line: string,
  fs: string,
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

function awkEvalLine(
  line: string,
  program: string,
  fs: string,
  variables: Record<string, string>,
  nr: number,
): string | null {
  const fieldMap = buildFieldMap(line, fs, nr, variables)
  const [condition, action] = parseProgram(program)
  if (condition !== '' && !evalCondition(condition, fieldMap)) return null
  if (action === '') return line
  return evalAction(action, fieldMap)
}

function parseBlocks(program: string): [string, string, string] {
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

function evalAccumulator(
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
      const n = Number.parseFloat(val)
      if (!Number.isNaN(n)) accum[variable] = (accum[variable] ?? 0) + n
    }
  }
}

function evalBegin(action: string): string {
  const parts: string[] = []
  for (const rawStmt of action.split(';')) {
    const stmt = rawStmt.trim()
    if (!stmt.startsWith(PRINT_STMT)) continue
    const args = stmt.slice(PRINT_STMT.length).trim()
    if (args === '') {
      parts.push('')
      continue
    }
    const tokens = args.split(/,\s*/)
    const vals: string[] = []
    for (const raw of tokens) {
      const tok = raw.trim()
      if (tok.startsWith('"') && tok.endsWith('"')) vals.push(tok.slice(1, -1))
      else vals.push(tok)
    }
    parts.push(vals.join(' '))
  }
  return parts.join('\n')
}

function evalEndPrint(
  action: string,
  accum: Record<string, number>,
  endMap: Record<string, string>,
): string {
  const parts: string[] = []
  for (const rawStmt of action.split(';')) {
    const stmt = rawStmt.trim()
    if (!stmt.startsWith(PRINT_STMT)) continue
    const args = stmt.slice(PRINT_STMT.length).trim()
    if (args === '') continue
    const tokens = args.split(/,\s*/)
    const vals: string[] = []
    for (const raw of tokens) {
      const tok = raw.trim()
      if (tok.startsWith('"') && tok.endsWith('"')) {
        vals.push(tok.slice(1, -1))
      } else if (tok in accum) {
        const v = accum[tok] ?? 0
        vals.push(Number.isInteger(v) ? String(v) : String(v))
      } else if (tok in endMap) {
        vals.push(endMap[tok] ?? '')
      } else {
        vals.push(tok)
      }
    }
    parts.push(vals.join(' '))
  }
  return parts.join('\n')
}

export async function* awkStream(
  source: AsyncIterable<Uint8Array>,
  program: string,
  fs: string,
  variables: Record<string, string>,
): AsyncIterable<Uint8Array> {
  const [begin, main, end] = parseBlocks(program)
  const accum: Record<string, number> = {}
  let nr = 0
  if (begin !== '') {
    const result = evalBegin(begin)
    if (result !== '') yield ENC.encode(result + '\n')
  }
  const iter = new AsyncLineIterator(source)
  for await (const lineBytes of iter) {
    nr += 1
    const line = DEC.decode(lineBytes)
    if (main !== '') {
      const fieldMap = buildFieldMap(line, fs, nr, variables)
      const [condition, action] = parseProgram(main)
      if (condition !== '' && !evalCondition(condition, fieldMap)) continue
      evalAccumulator(action, fieldMap, accum)
      const result = awkEvalLine(line, main, fs, variables, nr)
      if (result !== null && result !== '') yield ENC.encode(result + '\n')
    }
  }
  if (end !== '') {
    const endMap: Record<string, string> = {
      [AwkBuiltin.NR]: String(nr),
      [AwkBuiltin.NF]: '0',
    }
    const result = evalEndPrint(end, accum, endMap)
    if (result !== '') yield ENC.encode(result + '\n')
  }
}
