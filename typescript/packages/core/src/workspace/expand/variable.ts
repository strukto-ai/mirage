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

import { evaluateArith } from '../../shell/arith.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ArithError, ExitSignal } from '../../shell/errors.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { Session } from '../session/session.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { fnmatch } from '../../utils/fnmatch.ts'

// $$ reports the host process id where one exists (Node); browsers have
// no process, so a fixed positive placeholder keeps the expansion usable.
const REALM_PID: number = (globalThis as { process?: { pid?: number } }).process?.pid ?? 1

export interface TSNodeLike {
  type: string
  text: string
  children: TSNodeLike[]
  namedChildren: TSNodeLike[]
  parent?: TSNodeLike | null
  isNamed?: boolean
  isMissing?: boolean
  startIndex?: number
  endIndex?: number
}

export type ExpandChild = (node: TSNodeLike) => Promise<string>

const PARAM_OPS: ReadonlySet<string> = new Set([
  ':-',
  '-',
  ':+',
  '+',
  ':?',
  '?',
  ':=',
  '=',
  '#',
  '##',
  '%',
  '%%',
  '/',
  '//',
  '/#',
  '/%',
  ':',
  '^',
  '^^',
  ',',
  ',,',
  '!',
])

const REPLACE_OPS: ReadonlySet<string> = new Set(['/', '//', '/#', '/%'])

const STRIP_OPS: ReadonlySet<string> = new Set(['#', '##', '%', '%%'])

const CASE_OPS: ReadonlySet<string> = new Set(['^', '^^', ',', ',,'])

// Ops whose first operand is a glob pattern that must keep its literal
// spelling (no unescaping) while still expanding nested $-expansions.
const PATTERN_OPS: ReadonlySet<string> = new Set([...REPLACE_OPS, ...STRIP_OPS, ...CASE_OPS])

// Ops on a "${a[@]...}" splat that act per element, so a quoted splat
// still splits into one word per element; every other op acts on the
// space-joined value and stays a single word.
const MULTIWORD_AT_OPS: ReadonlySet<string> = new Set([
  ':',
  ...STRIP_OPS,
  ...REPLACE_OPS,
  ...CASE_OPS,
])

const LITERAL_ARG_TYPES: ReadonlySet<string> = new Set([NT.WORD, NT.NUMBER, 'regex'])

// Operators that handle unset themselves, so `set -u` must not fire
// on the lookup that feeds them.
const UNSET_GUARD_OPS: ReadonlySet<string> = new Set(['-', ':-', '+', ':+', '=', ':=', '?', ':?'])

// GNU: fatal at top level with status 127; a containing
// subshell/pipeline segment reports 1 (same shape as ${var:?}).
function unbound(name: string): ExitSignal {
  return new ExitSignal(127, new TextEncoder().encode(`bash: ${name}: unbound variable\n`), null, 1)
}

/**
 * Resolve one variable name to its value.
 *
 * `strict` honors `set -u`: an unset plain name or positional raises;
 * the defaulting operators (`:-` family) pass false because they handle
 * unset themselves. Specials (`@ * # ? $ ! 0`) never raise, matching
 * bash >= 4.4.
 */
export function lookupVar(
  name: string,
  session: Session,
  callStack: CallStack | null,
  strict = true,
): string {
  const env = session.env
  const lastExitCode = session.lastExitCode
  const positional = session.positionalArgs
  const nounset = strict && session.shellOptions.nounset === true
  if (name === '@' || name === '*') {
    if (callStack && callStack.getAllPositional().length > 0) {
      return callStack.getAllPositional().join(' ')
    }
    if (positional.length > 0) return positional.join(' ')
    return ''
  }
  if (name === '#') {
    if (callStack && callStack.getAllPositional().length > 0) {
      return String(callStack.getPositionalCount())
    }
    if (positional.length > 0) return String(positional.length)
    return '0'
  }
  if (name === '?') {
    return String(lastExitCode)
  }
  if (name === '$') {
    return String(REALM_PID)
  }
  if (name === '!') {
    // Deliberate divergence from bash: jobs are identified by job
    // table id, not OS pid, so $! yields the id `wait`/`kill` accept.
    return session.lastBgJobId !== null ? String(session.lastBgJobId) : ''
  }
  if (/^\d+$/.test(name)) {
    const idx = parseInt(name, 10)
    if (idx === 0) return 'mirage'
    if (callStack) {
      const fromCall = callStack.getPositional(idx)
      if (fromCall !== '') return fromCall
    }
    if (idx > 0 && idx <= positional.length) return positional[idx - 1] ?? ''
    if (nounset) throw unbound(name)
    return ''
  }
  if (callStack) {
    const localVal = callStack.getLocal(name)
    if (localVal !== null) return localVal
  }
  const fromArray = session.arrays[name]
  if (fromArray !== undefined) {
    return fromArray[0] ?? ''
  }
  if (name === 'PWD') return session.cwd
  if (name === 'HOME') return homeDir(session) ?? ''
  if (!(name in env)) {
    if (nounset) throw unbound(name)
    return ''
  }
  return env[name] ?? ''
}

interface BraceParse {
  varName: string | null
  subscript: string | null
  lengthOp: boolean
  indirectOp: boolean
  op: string | null
  groups: TSNodeLike[][]
}

function groupSeparator(op: string | null): string | null {
  if (op !== null && REPLACE_OPS.has(op)) return '/'
  if (op === ':') return ':'
  return null
}

function parseBraces(node: TSNodeLike): BraceParse {
  let varName: string | null = null
  let subscript: string | null = null
  let lengthOp = false
  let indirectOp = false
  let op: string | null = null
  const groups: TSNodeLike[][] = []
  let seenVar = false

  for (const c of node.children) {
    if (c.type === '${' || c.type === '}') continue
    if (c.type === '#' && !seenVar) {
      lengthOp = true
      continue
    }
    if (c.type === '!' && !seenVar) {
      indirectOp = true
      continue
    }
    if ((c.type === NT.VARIABLE_NAME || c.type === NT.SPECIAL_VARIABLE_NAME) && !seenVar) {
      varName = c.text
      seenVar = true
      continue
    }
    if (c.type === 'subscript' && !seenVar) {
      for (const sc of c.namedChildren) {
        if (sc.type === NT.VARIABLE_NAME && varName === null) {
          varName = sc.text
        } else if (subscript === null && sc.type !== NT.VARIABLE_NAME) {
          subscript = sc.text
        }
      }
      seenVar = true
      continue
    }
    if (PARAM_OPS.has(c.type) && op === null) {
      op = c.text
      groups.push([])
      continue
    }
    if (op !== null && c.isNamed !== true && c.type === groupSeparator(op)) {
      groups.push([])
      continue
    }
    if (op !== null) {
      groups[groups.length - 1]?.push(c)
    }
  }
  return { varName, subscript, lengthOp, indirectOp, op, groups }
}

// Pattern operands (${f%$ext}) arrive as opaque `regex` nodes whose
// $-references have no child nodes; resolve them textually while
// keeping every other character (glob syntax) literal.
function expandDollarRefs(text: string, session: Session, callStack: CallStack | null): string {
  if (!text.includes('$')) return text
  const out: string[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i] ?? ''
    if (ch !== '$' || i + 1 >= n) {
      out.push(ch)
      i += 1
      continue
    }
    let j = i + 1
    const braced = text[j] === '{'
    if (braced) j += 1
    const start = j
    while (j < n && /[A-Za-z0-9_]/.test(text[j] ?? '')) j += 1
    const name = text.slice(start, j)
    if (name === '' || (braced && (j >= n || text[j] !== '}'))) {
      out.push(ch)
      i += 1
      continue
    }
    if (braced) j += 1
    out.push(lookupVar(name, session, callStack))
    i = j
  }
  return out.join('')
}

async function expandOperand(
  node: TSNodeLike,
  expandChild: ExpandChild,
  patternMode: boolean,
  session: Session,
  callStack: CallStack | null,
): Promise<string> {
  if (node.type === NT.CONCATENATION) {
    return expandGroup(node.children, expandChild, patternMode, session, callStack)
  }
  if (patternMode && LITERAL_ARG_TYPES.has(node.type)) {
    return expandDollarRefs(node.text, session, callStack)
  }
  return expandChild(node)
}

// ${x:?custom msg} carries its message as sibling nodes whose gap (the
// space) exists only in the source bytes; stitch gaps back from node
// offsets so multi-word operands round-trip.
async function expandGroup(
  nodes: TSNodeLike[],
  expandChild: ExpandChild,
  patternMode: boolean,
  session: Session,
  callStack: CallStack | null,
): Promise<string> {
  const pieces: string[] = []
  let prevEnd: number | null = null
  for (const c of nodes) {
    if (prevEnd !== null && c.startIndex !== undefined && c.startIndex > prevEnd) {
      pieces.push(' '.repeat(c.startIndex - prevEnd))
    }
    pieces.push(await expandOperand(c, expandChild, patternMode, session, callStack))
    prevEnd = c.endIndex ?? null
  }
  return pieces.join('')
}

function globStrip(value: string, pattern: string, greedy: boolean, prefix: boolean): string {
  if (pattern === '') return value
  const matches: number[] = []
  if (prefix) {
    for (let i = 0; i <= value.length; i++) {
      if (fnmatch(value.slice(0, i), pattern)) matches.push(i)
    }
    if (matches.length === 0) return value
    const i = greedy ? Math.max(...matches) : Math.min(...matches)
    return value.slice(i)
  }
  for (let i = 0; i <= value.length; i++) {
    if (fnmatch(value.slice(i), pattern)) matches.push(i)
  }
  if (matches.length === 0) return value
  const i = greedy ? Math.min(...matches) : Math.max(...matches)
  return value.slice(0, i)
}

// Bash ${var/pat/rep}: pattern is a glob, longest match wins. anchor is
// '#' (prefix), '%' (suffix), or null.
function globReplace(
  value: string,
  pattern: string,
  replacement: string,
  replaceAll: boolean,
  anchor: string | null,
): string {
  if (pattern === '') return value
  if (anchor === '#') {
    for (let j = value.length; j >= 0; j--) {
      if (fnmatch(value.slice(0, j), pattern)) return replacement + value.slice(j)
    }
    return value
  }
  if (anchor === '%') {
    for (let i = 0; i <= value.length; i++) {
      if (fnmatch(value.slice(i), pattern)) return value.slice(0, i) + replacement
    }
    return value
  }
  if (value === '') {
    return fnmatch('', pattern) ? replacement : value
  }
  const out: string[] = []
  let i = 0
  const n = value.length
  while (i < n) {
    let matchEnd = -1
    for (let j = n; j >= i; j--) {
      if (fnmatch(value.slice(i, j), pattern)) {
        matchEnd = j
        break
      }
    }
    if (matchEnd <= i) {
      // No match here (or an empty one, which bash skips over).
      out.push(value[i] ?? '')
      i += 1
      continue
    }
    out.push(replacement)
    i = matchEnd
    if (!replaceAll) {
      out.push(value.slice(i))
      return out.join('')
    }
  }
  return out.join('')
}

function caseMod(op: string, val: string, pattern: string): string {
  if (val === '') return val
  const all = op === '^^' || op === ',,'
  let out = ''
  for (let i = 0; i < val.length; i++) {
    const ch = val[i] ?? ''
    if ((!all && i > 0) || (pattern !== '' && !fnmatch(ch, pattern))) {
      out += ch
      continue
    }
    out += op === '^' || op === '^^' ? ch.toUpperCase() : ch.toLowerCase()
  }
  return out
}

// bash evaluates substring offsets and array subscripts as arithmetic
// (${v:1+1}, ${a[i+1]}).
function arithInt(text: string, env: Record<string, string>): number | null {
  if (/^\s*-?\d+\s*$/.test(text)) return Number.parseInt(text.trim(), 10)
  try {
    const { value } = evaluateArith(text, env)
    return Number(value)
  } catch (err) {
    if (err instanceof ArithError) return null
    throw err
  }
}

function substring(val: string, groups: string[], env: Record<string, string>): string {
  const offsetRaw = groups[0]
  if (offsetRaw === undefined) return val
  let offset = arithInt(offsetRaw, env)
  if (offset === null) return val
  let length: number | null = null
  const lengthRaw = groups[1]
  if (lengthRaw !== undefined) {
    length = arithInt(lengthRaw, env)
    if (length === null) return val
  }
  if (offset < 0) offset = Math.max(0, val.length + offset)
  if (length === null) return val.slice(offset)
  if (length < 0) return val.slice(offset, Math.max(offset, val.length + length))
  return val.slice(offset, offset + length)
}

function sliceArray(arr: string[], groups: string[], env: Record<string, string>): string[] {
  const offsetRaw = groups[0]
  if (offsetRaw === undefined) return arr
  let offset = arithInt(offsetRaw, env)
  if (offset === null) return arr
  let length: number | null = null
  const lengthRaw = groups[1]
  if (lengthRaw !== undefined) {
    length = arithInt(lengthRaw, env)
    if (length === null) return arr
  }
  if (offset < 0) offset = Math.max(0, arr.length + offset)
  if (length === null) return arr.slice(offset)
  if (length < 0) return arr.slice(offset, Math.max(offset, arr.length + length))
  return arr.slice(offset, offset + length)
}

// True for the "${a[@]...}" forms bash keeps as one word per element:
// plain, slice, per-element strip/replace/case ops, and ${!a[@]}
// indices. False for single-word forms (${a[*]}, ${#a[@]}, non-@
// subscript, or a default/alternate op acting on the joined value).
export function isMultiwordAt(node: TSNodeLike): boolean {
  if (node.type !== NT.EXPANSION) return false
  const p = parseBraces(node)
  if (p.subscript !== '@' || p.lengthOp) return false
  if (p.indirectOp || p.op === null) return true
  return MULTIWORD_AT_OPS.has(p.op)
}

// Resolve a multi-word "${a[@]...}" splat to its word list. Only call
// when isMultiwordAt is true; the caller word-splits (or stitches
// prefix/suffix onto) the words, matching bash's quoted-splat rule.
export async function expandArrayAt(
  node: TSNodeLike,
  session: Session,
  callStack: CallStack | null,
  expandChild: ExpandChild,
): Promise<string[]> {
  const p = parseBraces(node)
  const env = session.env
  let arr = session.arrays[p.varName ?? '']
  if (arr === undefined) {
    const scalar = env[p.varName ?? ''] ?? ''
    arr = scalar !== '' ? [scalar] : []
  }
  if (p.indirectOp) return arr.map((_, i) => String(i))
  if (p.op === null) return [...arr]
  const op = p.op
  const groups: string[] = []
  for (let gi = 0; gi < p.groups.length; gi++) {
    const patternMode = gi === 0 && PATTERN_OPS.has(op)
    groups.push(await expandGroup(p.groups[gi] ?? [], expandChild, patternMode, session, callStack))
  }
  if (op === ':') return sliceArray(arr, groups, env)
  return arr.map((el) => valueOp(op, el, groups, env))
}

// bash evaluates subscripts in arithmetic context (${a[i+1]});
// unresolvable expressions index element 0, mirroring bash's
// unset-name-is-zero arithmetic rule.
export function arrayIndex(idxText: string, env: Record<string, string>): number {
  return arithInt(idxText, env) ?? 0
}

function valueOp(op: string, val: string, groups: string[], env: Record<string, string>): string {
  if (STRIP_OPS.has(op)) {
    const pattern = groups[0] ?? ''
    return globStrip(val, pattern, op === '##' || op === '%%', op === '#' || op === '##')
  }
  if (REPLACE_OPS.has(op)) {
    const pattern = groups[0] ?? ''
    const replacement = groups[1] ?? ''
    let anchor: string | null = null
    if (op === '/#') anchor = '#'
    else if (op === '/%') anchor = '%'
    return globReplace(val, pattern, replacement, op === '//', anchor)
  }
  if (CASE_OPS.has(op)) {
    return caseMod(op, val, groups[0] ?? '')
  }
  if (op === ':') {
    return substring(val, groups, env)
  }
  return val
}

export async function expandBraces(
  node: TSNodeLike,
  session: Session,
  callStack: CallStack | null,
  expandChild: ExpandChild,
): Promise<string> {
  const p = parseBraces(node)
  if (node.children.some((c) => c.type === '}' && c.isMissing)) {
    // tree-sitter-bash cannot parse a $-spelled substring offset
    // (${v:$o}, ${v:$o:n}): it truncates the expansion with a
    // zero-width `}` and reparses the tail as stray siblings. bash
    // accepts the form, so emitting the mis-parse would corrupt the
    // value silently; fail loudly instead. Spell it ${v:o} or
    // ${v:$((o))}.
    throw new ExitSignal(
      2,
      new TextEncoder().encode(`bash: \${${p.varName ?? ''}}: bad substitution\n`),
      null,
      2,
    )
  }
  const env = session.env
  const arrays = session.arrays

  const groups: string[] = []
  for (let gi = 0; gi < p.groups.length; gi++) {
    const patternMode = gi === 0 && p.op !== null && PATTERN_OPS.has(p.op)
    groups.push(await expandGroup(p.groups[gi] ?? [], expandChild, patternMode, session, callStack))
  }

  let val = ''
  let varInEnv = false

  if (p.subscript !== null && p.varName !== null) {
    let arr = arrays[p.varName]
    if (arr === undefined) {
      const scalar = env[p.varName] ?? ''
      arr = scalar !== '' ? [scalar] : []
    }
    varInEnv = p.varName in arrays || p.varName in env
    if (p.subscript === '@' || p.subscript === '*') {
      if (p.indirectOp) {
        return arr.map((_, i) => String(i)).join(' ')
      }
      if (p.lengthOp) return String(arr.length)
      if (p.op === ':') {
        return sliceArray(arr, groups, env).join(' ')
      }
      if (p.op !== null && (STRIP_OPS.has(p.op) || REPLACE_OPS.has(p.op) || CASE_OPS.has(p.op))) {
        const op = p.op
        return arr.map((el) => valueOp(op, el, groups, env)).join(' ')
      }
      val = arr.join(' ')
    } else {
      let idx = arrayIndex(p.subscript, env)
      if (idx < 0) idx += arr.length
      if (idx >= 0 && idx < arr.length) {
        val = arr[idx] ?? ''
        varInEnv = true
      } else {
        val = ''
        varInEnv = false
      }
    }
  } else if (p.varName !== null) {
    if (callStack) {
      const localVal = callStack.getLocal(p.varName)
      if (localVal !== null) {
        val = localVal
        varInEnv = true
      }
    }
    if (!varInEnv && p.varName in arrays) {
      const arr = arrays[p.varName] ?? []
      val = arr[0] ?? ''
      varInEnv = true
    }
    if (!varInEnv && p.varName in env) {
      val = env[p.varName] ?? ''
      varInEnv = true
    }
    if (!varInEnv) {
      // Specials, positionals, PWD/HOME fall back to the shared
      // lookup; set-ness follows value presence.
      val = lookupVar(p.varName, session, callStack, p.op === null || !UNSET_GUARD_OPS.has(p.op))
      varInEnv = val !== ''
    }
  }

  if (p.indirectOp) {
    return val !== '' ? lookupVar(val, session, callStack) : ''
  }
  if (p.lengthOp) return String(val.length)
  if (p.op === null) return val
  if (p.op === '?' || p.op === ':?') {
    const triggered = p.op === '?' ? !varInEnv : val === ''
    if (!triggered) return val
    const message =
      groups[0] !== undefined && groups[0] !== ''
        ? groups[0]
        : p.op === '?'
          ? 'parameter not set'
          : 'parameter null or not set'
    // GNU: fatal at top level with status 127; a containing
    // subshell/pipeline segment reports 1.
    throw new ExitSignal(
      127,
      new TextEncoder().encode(`bash: ${p.varName ?? ''}: ${message}\n`),
      null,
      1,
    )
  }
  if (p.op === '=' || p.op === ':=') {
    const triggered = p.op === '=' ? !varInEnv : val === ''
    if (!triggered) return val
    const defaultVal = groups[0] ?? ''
    if (callStack !== null && callStack.getLocal(p.varName ?? '') !== null) {
      callStack.setLocal(p.varName ?? '', defaultVal)
    } else if (p.varName !== null) {
      env[p.varName] = defaultVal
    }
    return defaultVal
  }
  if (p.op === ':-') return val !== '' ? val : (groups[0] ?? '')
  if (p.op === '-') {
    if (varInEnv) return val
    return groups[0] ?? ''
  }
  if (p.op === ':+') return val !== '' ? (groups[0] ?? '') : ''
  if (p.op === '+') return varInEnv ? (groups[0] ?? '') : ''
  return valueOp(p.op, val, groups, env)
}
