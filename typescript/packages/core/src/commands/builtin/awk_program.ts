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

import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { UsageError } from '../errors.ts'
import { toNumber } from './utils/formatting.ts'
import {
  AwkBlock,
  AwkBoolOp,
  AwkBuiltin,
  AwkCmpOp,
  CMP_OP_PATTERN,
  FIELD_PREFIX,
  PRINT_STMT,
} from './generic/awk_types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function splitFields(line: string, fs: string | null): string[] {
  if (fs === null || fs === ' ') return line.split(/\s+/).filter((s) => s !== '')
  if (fs === '') return Array.from(line)
  const re = fs.length === 1 ? new RegExp(escapeRegex(fs)) : new RegExp(fs)
  return line.split(re)
}

const CMP_RE = new RegExp(CMP_OP_PATTERN.source, 'g')
const STRING_QUOTE = '"'
const REGEX_DELIM = '/'
const REGEX_ERROR = 'awk: syntax error in regular expression {pattern} at source line 1'

// Index just past the literal opening at `start`. Covers the two literals a
// pattern can hold, a `"string"` and a `/regex/`; a backslash escapes the
// next character in both, which is how `/a\/b/` keeps its slash. null when
// the literal never closes.
function literalEnd(text: string, start: number): number | null {
  const delim = text.charAt(start)
  let i = start + 1
  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === delim) return i + 1
    i += 1
  }
  return null
}

function isLiteral(tok: string): boolean {
  const head = tok.charAt(0)
  return (head === STRING_QUOTE || head === REGEX_DELIM) && literalEnd(tok, 0) === tok.length
}

function isRegexLiteral(tok: string): boolean {
  return tok.startsWith(REGEX_DELIM) && isLiteral(tok)
}

// Where a `/` opens a regex rather than dividing: at the start of a
// condition and after an operator that wants an operand.
const REGEX_OPENERS = new Set(['~', '!', '&', '|', '(', ','])

function opensRegex(text: string, at: number): boolean {
  const before = text.slice(0, at).trimEnd()
  return before === '' || REGEX_OPENERS.has(before.charAt(before.length - 1))
}

// Split a condition at `op` outside its literals. A `"string"` or a
// `/regex/` can hold the operator's characters (`$0 ~ /A&&B/`,
// `$1 == "a||b"`), so the split walks the text and steps over each literal
// whole; a `/` opens a regex only where awk expects an operand, so the
// slash of a bare word is not one. Validator and evaluator both split
// through here, so they cannot disagree about where a term ends. A literal
// that never closes ends the scan, and the validator refuses what is left.
function splitBool(condition: string, op: string): string[] {
  const parts: string[] = []
  let start = 0
  let i = 0
  while (i < condition.length) {
    const ch = condition.charAt(i)
    if (ch === STRING_QUOTE || (ch === REGEX_DELIM && opensRegex(condition, i))) {
      const end = literalEnd(condition, i)
      if (end === null) break
      i = end
    } else if (condition.startsWith(op, i)) {
      parts.push(condition.slice(start, i))
      i += op.length
      start = i
    } else {
      i += 1
    }
  }
  parts.push(condition.slice(start))
  return parts
}

// Index of the `{` that opens the action, or -1 without one. Literals are
// skipped whole, so the brace in a pattern's `/a{2}/` is not mistaken for
// the action's.
function actionStart(program: string): number {
  let i = 0
  while (i < program.length) {
    const ch = program.charAt(i)
    if (ch === STRING_QUOTE || ch === REGEX_DELIM) {
      const end = literalEnd(program, i)
      if (end === null) return -1
      i = end
      continue
    }
    if (ch === '{') return i
    i += 1
  }
  return -1
}

function parseProgram(program: string): [string, string] {
  const trimmed = program.trim()
  const idx = actionStart(trimmed)
  if (idx === -1) return [trimmed, '']
  const condition = trimmed.slice(0, idx).trim()
  const action = trimmed
    .slice(idx + 1)
    .trimEnd()
    .replace(/\}$/, '')
    .trim()
  return [condition, action]
}

// Split `lhs OP rhs` at the first operator outside a leading literal. A
// leading `/regex/` or `"string"` is skipped whole, so the `<` inside
// `/a<b/` is not read as a comparison; after that the leftmost operator
// wins, which is how `$0 ~ /a==b/` keeps `==` in its regex. null when the
// expression is not a comparison.
function splitComparison(expr: string): [string, AwkCmpOp, string] | null {
  let scanFrom = 0
  const head = expr.charAt(0)
  if (head === STRING_QUOTE || head === REGEX_DELIM) {
    const end = literalEnd(expr, 0)
    if (end === null) return null
    scanFrom = end
  }
  CMP_RE.lastIndex = scanFrom
  const m = CMP_RE.exec(expr)
  if (m === null || m.index === 0) return null
  const lhs = expr.slice(0, m.index).trim()
  const rhs = expr.slice(m.index + m[0].length).trim()
  if (lhs === '' || rhs === '') return null
  return [lhs, m[0] as AwkCmpOp, rhs]
}

// Peel one leading `!` off a probe (`!/re/`, `!x`). `!=` and `!~` are
// operators, not negations, so they stay put.
function stripNegation(expr: string): [boolean, string] {
  if (
    expr.startsWith('!') &&
    !expr.startsWith(AwkCmpOp.NE) &&
    !expr.startsWith(AwkCmpOp.NOT_MATCH)
  ) {
    return [true, expr.slice(1).trim()]
  }
  return [false, expr]
}

// Compile an awk regex, refusing a bad one with awk's exit 2.
function compileRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern)
  } catch {
    throw new UsageError(REGEX_ERROR.replace('{pattern}', pattern))
  }
}

const IDENT_RE = /^[A-Za-z_]\w*$/
const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/

// Whether the scraper can evaluate this token as a value. The supported
// grammar is deliberately small: a double-quoted string with no embedded
// quote, a numeric literal, a plain identifier, or a `$` field naming a
// number or an identifier. Anything else (function calls, arithmetic,
// concatenation) has no evaluator here and must be refused rather than
// echoed as its own source text.
function isSimpleOperand(tok: string): boolean {
  if (tok === '') return false
  if (tok.length >= 2 && tok.startsWith('"') && tok.endsWith('"')) {
    return !tok.slice(1, -1).includes('"')
  }
  if (tok.startsWith(FIELD_PREFIX)) {
    const inner = tok.slice(1)
    return /^\d+$/.test(inner) || IDENT_RE.test(inner)
  }
  return IDENT_RE.test(tok) || NUMBER_RE.test(tok)
}

function reject(construct: string): never {
  throw new UsageError(`awk: unsupported construct: '${construct}'`)
}

// Split an action into its leaf statements: on `;` at brace depth zero
// and outside double quotes. A compound statement (`{ stmts }`, legal
// wherever a statement is) contributes its inner statements in place, so
// `{{print $1}}` runs `print $1` the way gawk does rather than reading as
// one unknown statement. Validator and evaluator both iterate this list,
// so they cannot disagree about where a statement ends.
function splitStatements(action: string): string[] {
  const pieces: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < action.length; i++) {
    const ch = action.charAt(i)
    if (ch === '"') {
      quoted = !quoted
    } else if (quoted) {
      continue
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth = Math.max(depth - 1, 0)
    } else if (ch === ';' && depth === 0) {
      pieces.push(action.slice(start, i))
      start = i + 1
    }
  }
  pieces.push(action.slice(start))
  const stmts: string[] = []
  for (const piece of pieces) {
    const stmt = piece.trim()
    if (stmt === '') continue
    if (stmt.startsWith('{') && stmt.endsWith('}')) {
      stmts.push(...splitStatements(stmt.slice(1, -1)))
    } else {
      stmts.push(stmt)
    }
  }
  return stmts
}

function validatePrintArgs(args: string, stmt: string): void {
  for (const tok of args.split(/,\s*/)) {
    if (!isSimpleOperand(tok.trim())) reject(stmt)
  }
}

const ASSIGN_RE = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/

// Refuse any statement the streamer would silently drop or mangle.
// `evalStatements` executes `print`, `var = value` and `var += value`;
// every other statement used to vanish (and `printf` ran as a mangled
// `print`), so an agent's script exited 0 having done nothing. Shares
// the statement split with the evaluator.
function validateAction(action: string): void {
  for (const stmt of splitStatements(action)) {
    const m = /^\w+\s*\+=\s*(.+)$/.exec(stmt)
    if (m !== null) {
      if (!isSimpleOperand((m[1] ?? '').trim())) reject(stmt)
      continue
    }
    if (!new RegExp(`^${PRINT_STMT}\\b`).test(stmt)) {
      const mSet = ASSIGN_RE.exec(stmt)
      if (mSet !== null) {
        if (!isSimpleOperand((mSet[2] ?? '').trim())) reject(stmt)
        continue
      }
    }
    if (stmt === PRINT_STMT) continue
    if (new RegExp(`^${PRINT_STMT}\\b`).test(stmt)) {
      const args = stmt.slice(PRINT_STMT.length).trim()
      if (args !== '') validatePrintArgs(args, stmt)
      continue
    }
    reject(stmt)
  }
}

function validateSimple(rawExpr: string): void {
  const expr = rawExpr.trim()
  const [negated, probe] = stripNegation(expr)
  const split = splitComparison(probe)
  if (split === null) {
    if (isRegexLiteral(probe)) {
      compileRegex(probe.slice(1, -1))
      return
    }
    if (!isSimpleOperand(probe)) reject(expr)
    return
  }
  // `!$1 == 2` negates the operand, not the comparison, and nothing here
  // evaluates that shape.
  if (negated) reject(expr)
  const [lhs, op, rhs] = split
  if (!isSimpleOperand(lhs)) reject(expr)
  if (op === AwkCmpOp.MATCH || op === AwkCmpOp.NOT_MATCH) {
    // A literal regex is checked now; a variable or field is a dynamic
    // regex, compiled against each record.
    if (isLiteral(rhs)) compileRegex(rhs.slice(1, -1))
    else if (!isSimpleOperand(rhs)) reject(expr)
    return
  }
  if (rhs.startsWith('"') || rhs.startsWith(FIELD_PREFIX)) {
    if (!isSimpleOperand(rhs)) reject(expr)
    return
  }
  // A bare right-hand side compares as a literal in this dialect, so any
  // word is fine; structural characters mean an expression nothing here
  // evaluates (`length(x)`, `a[1]`).
  if (/[(){}[]/.test(rhs)) reject(expr)
}

// Refuse any pattern `evalCondition` cannot actually decide. Mirrors its
// decomposition exactly (`||` first, then `&&`, then one simple
// comparison / regex / truthiness probe), so everything the evaluator
// runs is accepted and everything it would misread (`~`, arithmetic,
// parenthesized groups) is refused up front.
function validateCondition(condition: string): void {
  const cond = condition.trim()
  if (cond === '' || cond === AwkBlock.BEGIN || cond === AwkBlock.END) return
  for (const op of [AwkBoolOp.OR, AwkBoolOp.AND]) {
    const parts = splitBool(cond, op)
    if (parts.length > 1) {
      for (const part of parts) validateCondition(part)
      return
    }
  }
  validateSimple(cond)
}

export function validateAwkProgram(program: string): void {
  const [begin, main, end] = parseBlocks(program)
  const [condition, action] = main !== '' ? parseProgram(main) : (['', ''] as [string, string])
  if (begin !== '') validateAction(begin)
  if (end !== '') validateAction(end)
  validateCondition(condition)
  if (action !== '') validateAction(action)
}

function resolveToken(tok: string, fieldMap: Record<string, string>): string {
  if (tok.startsWith(FIELD_PREFIX)) {
    const inner = tok.slice(1)
    if (inner in fieldMap) {
      const ref = fieldMap[inner] ?? ''
      return fieldMap[`${FIELD_PREFIX}${ref}`] ?? ''
    }
    // An out-of-range field is empty in awk, never its own spelling.
    return fieldMap[tok] ?? ''
  }
  if (tok in fieldMap) return fieldMap[tok] ?? ''
  // An unset variable reads as the empty string, not its own name; a
  // numeric literal is its own value.
  return IDENT_RE.test(tok) ? '' : tok
}

function truthy(val: string): boolean {
  const n = Number.parseFloat(val)
  if (!Number.isNaN(n)) return n !== 0
  return val !== ''
}

function evalSimple(rawExpr: string, fieldMap: Record<string, string>): boolean {
  const expr = rawExpr.trim()
  const [negated, probe] = stripNegation(expr)
  const split = splitComparison(probe)
  if (split === null) {
    const hit = isRegexLiteral(probe)
      ? compileRegex(probe.slice(1, -1)).test(fieldMap[AwkBuiltin.REC] ?? '')
      : truthy(resolveToken(probe, fieldMap))
    return hit !== negated
  }
  const [lhsRaw, op, rhsRawIn] = split
  const lhs = resolveToken(lhsRaw, fieldMap)
  if (op === AwkCmpOp.MATCH || op === AwkCmpOp.NOT_MATCH) {
    const pattern = isLiteral(rhsRawIn) ? rhsRawIn.slice(1, -1) : resolveToken(rhsRawIn, fieldMap)
    const hit = compileRegex(pattern).test(lhs)
    return op === AwkCmpOp.MATCH ? hit : !hit
  }
  const rhsRaw = rhsRawIn.replace(/^"|"$/g, '')
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
  const ors = splitBool(cond, AwkBoolOp.OR)
  if (ors.length > 1) return ors.some((p) => evalCondition(p, fieldMap))
  const ands = splitBool(cond, AwkBoolOp.AND)
  if (ands.length > 1) return ands.every((p) => evalCondition(p, fieldMap))
  return evalSimple(cond, fieldMap)
}

// Run an action's statements in written order. Three statement forms
// exist in this dialect: `var += value` accumulates, `var = value`
// assigns (persisting across records via `variables`, which is how
// `BEGIN {OFS=":"}` reaches every print), and `print` emits its
// arguments joined with OFS. One sequential pass, so `x = 1; print x`
// sees the assignment.
function evalStatements(
  action: string,
  fieldMap: Record<string, string>,
  accum: Record<string, number>,
  variables: Record<string, string>,
): string | null {
  const parts: string[] = []
  let printed = false
  for (const stmt of splitStatements(action)) {
    const mAdd = /^(\w+)\s*\+=\s*(.+)$/.exec(stmt)
    if (mAdd !== null) {
      const variable = mAdd[1] ?? ''
      const expr = (mAdd[2] ?? '').trim()
      const val = fieldMap[expr] ?? expr
      accum[variable] = (accum[variable] ?? 0) + toNumber(val)
      continue
    }
    if (!stmt.startsWith(PRINT_STMT)) {
      const mSet = ASSIGN_RE.exec(stmt)
      if (mSet !== null) {
        const variable = mSet[1] ?? ''
        const raw = (mSet[2] ?? '').trim()
        const val =
          raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
            ? raw.slice(1, -1)
            : resolveToken(raw, fieldMap)
        variables[variable] = val
        fieldMap[variable] = val
        continue
      }
      continue
    }
    printed = true
    const args = stmt.slice(PRINT_STMT.length).trim()
    const ofs = fieldMap.OFS ?? ' '
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
    parts.push(vals.join(ofs))
  }
  return printed ? parts.join('\n') : null
}

function buildFieldMap(
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
    const result = evalStatements(begin, beginMap, accum, variables)
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
      const result = action !== '' ? evalStatements(action, fieldMap, accum, variables) : line
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
    const result = evalStatements(end, endMap, accum, variables)
    if (result !== null) yield ENC.encode(result + '\n')
  }
}
