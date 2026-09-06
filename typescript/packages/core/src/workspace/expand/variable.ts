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

import { nextRandom } from '../session/state.ts'
import { evaluateArith } from '../../shell/arith.ts'
import type { ArithWrite } from '../../shell/types.ts'
import type { RandomReader } from '../session/state.ts'
import {
  type ShellArray,
  arrayExtent,
  arrayGet,
  arrayHas,
  arrayIndices,
  arraySlice,
  arrayValues,
} from '../../shell/array.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { RANDOM } from '../../shell/constants.ts'
import { ArithError, ExitSignal } from '../../shell/errors.ts'
import { NodeType as NT, type ElementOps, type TSNodeLike } from '../../shell/types.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import type { SessionView } from '../../ops/types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { Session } from '../session/session.ts'
import { assignElement } from '../session/elements.ts'
import { ReadonlyVariableError } from '../session/errors.ts'
import {
  ensureVarVisible,
  visibleArrays,
  visibleAssocs,
  visibleEnv,
  deref,
  namerefTarget,
  randomReader,
  sessionElements,
  subscriptIndex,
} from '../session/state.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { decodeAnsiC } from '../../shell/escapes.ts'
import { fnmatch } from '../../utils/fnmatch.ts'
import { escapeGlob } from '../../utils/glob_walk.ts'

// $$ reports the host process id where one exists (Node); browsers have
// no process, so a fixed positive placeholder keeps the expansion usable.
const REALM_PID: number = (globalThis as { process?: { pid?: number } }).process?.pid ?? 1

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

// Quote-carrying operand nodes: in pattern position their value matches
// literally, exactly as a quoted case pattern does.
const QUOTED_ARG_TYPES: ReadonlySet<string> = new Set([
  NT.STRING,
  NT.RAW_STRING,
  NT.ANSI_C_STRING,
  NT.TRANSLATED_STRING,
])

// Operators that handle unset themselves, so `set -u` must not fire
// on the lookup that feeds them.
const UNSET_GUARD_OPS: ReadonlySet<string> = new Set(['-', ':-', '+', ':+', '=', ':=', '?', ':?'])

// GNU: fatal at top level with status 127; a containing
// subshell/pipeline segment reports 1 (same shape as ${var:?}).
function unbound(name: string): ExitSignal {
  return new ExitSignal(127, new TextEncoder().encode(`bash: ${name}: unbound variable\n`), null, 1)
}

/**
 * Refuse expansion-time writes that name hidden variables.
 *
 * `${X:=d}` and `$((X=5))` land on the raw session env rather than the
 * async session door, so the hidden half of that door
 * (`ensureVarVisible`) is applied here, and the refusal takes the
 * fatal expansion-error shape `${var:?}` uses.
 */
function guardExpansionWrite(session: Session, ...names: string[]): void {
  for (const name of names) {
    try {
      ensureVarVisible(session, name)
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      throw new ExitSignal(1, new TextEncoder().encode(`bash: ${err.message}\n`), null, 1)
    }
  }
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
  const env = visibleEnv(session)
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
    if (idx === 0) return session.argv0
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
  if (name === RANDOM) {
    const drawn = nextRandom(session, env[RANDOM])
    if (drawn !== null) return String(drawn)
  }
  // A name reference resolves to its target before the store is read.
  name = deref(session, name) || name
  const fromArray = visibleArrays(session)[name]
  if (fromArray !== undefined) {
    return arrayGet(fromArray, 0)
  }
  const fromAssoc = visibleAssocs(session)[name]
  if (fromAssoc !== undefined) {
    // `$m` on an associative array is `${m["0"]}`, the literal key.
    return fromAssoc['0'] ?? ''
  }
  // $PWD is deliberately absent here: `cd` writes it into the env like any
  // exported variable, so it can be assigned, unset and printed by `env`,
  // exactly as bash allows. Resolving it here instead would make `PWD=/x`
  // and `unset PWD` silently do nothing.
  if (name === 'HOME') return homeDir(session) ?? ''
  if (!(name in env)) {
    if (nounset) throw unbound(name)
    return ''
  }
  return env[name] ?? ''
}

/**
 * Structural pieces of one `${...}` expansion. `subscript` is the raw
 * text between the brackets and serves the literal checks (`@`/`*`)
 * and the arithmetic path, which wants the unexpanded spelling;
 * `subscriptNodes` are the tree-sitter children behind it, which the
 * associative path expands properly (`${m[$k]}`, `${m["a b"]}`) since
 * a key is a word, not an expression.
 */
interface BraceParse {
  varName: string | null
  subscript: string | null
  lengthOp: boolean
  indirectOp: boolean
  op: string | null
  groups: TSNodeLike[][]
  subscriptNodes: TSNodeLike[]
}

function groupSeparator(op: string | null): string | null {
  if (op !== null && REPLACE_OPS.has(op)) return '/'
  if (op === ':') return ':'
  return null
}

function parseBraces(node: TSNodeLike): BraceParse {
  let varName: string | null = null
  let subscript: string | null = null
  let subscriptNodes: TSNodeLike[] = []
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
      const subNodes: TSNodeLike[] = []
      for (const sc of c.namedChildren) {
        if (sc.type === NT.VARIABLE_NAME && varName === null) {
          varName = sc.text
        } else {
          subNodes.push(sc)
        }
      }
      subscriptNodes = subNodes
      if (varName !== null) {
        // The raw slice, not the first child's text: a subscript
        // holding several words (`${m[two words]}`) or a quoted key
        // keeps its whole spelling this way.
        subscript = c.text.slice(varName.length + 1, -1)
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
  return { varName, subscript, lengthOp, indirectOp, op, groups, subscriptNodes }
}

// Index of the next unescaped `quote`, -1 when it never closes.
function escapedFind(text: string, start: number, quote: string): number {
  let i = start
  const n = text.length
  while (i < n) {
    if (text[i] === '\\' && i + 1 < n) {
      i += 2
      continue
    }
    if (text[i] === quote) return i
    i += 1
  }
  return -1
}

// A $name/${name} reference starting after the $: the name and the index
// past it, or null when the $ starts no reference and stays literal.
function refEnd(text: string, start: number): [string, number] | null {
  const n = text.length
  let j = start
  const braced = text[j] === '{'
  if (braced) j += 1
  const from = j
  while (j < n && /[A-Za-z0-9_]/.test(text[j] ?? '')) j += 1
  const name = text.slice(from, j)
  if (name === '') return null
  if (braced) {
    if (j >= n || text[j] !== '}') return null
    j += 1
  }
  return [name, j]
}

// A double-quoted pattern segment: everything in it is literal.
function dquotedPattern(inner: string, session: Session, callStack: CallStack | null): string {
  const out: string[] = []
  let i = 0
  const n = inner.length
  while (i < n) {
    const ch = inner[i] ?? ''
    if (ch === '\\' && i + 1 < n && '$`"\\'.includes(inner[i + 1] ?? '')) {
      out.push(escapeGlob(inner[i + 1] ?? ''))
      i += 2
      continue
    }
    if (ch === '$' && i + 1 < n) {
      const ref = refEnd(inner, i + 1)
      if (ref !== null) {
        out.push(escapeGlob(lookupVar(ref[0], session, callStack)))
        i = ref[1]
        continue
      }
    }
    out.push(escapeGlob(ch))
    i += 1
  }
  return out.join('')
}

// Render an opaque pattern token with bash quoting semantics.
// Pattern operands (${f%$ext}, ${v#x"a*"}) arrive as opaque `regex` nodes
// tree-sitter does not parse further, but bash still honors quoting inside
// them: quoted segments (single, double, or ANSI-C) match literally, a
// backslash binds the next character, an unquoted $-reference splices a
// live pattern while a double-quoted one splices literal text, and every
// other character - glob syntax included - stays live. Literal text is
// spelled in one-character classes because fnmatch has no escape character.
function patternText(text: string, session: Session, callStack: CallStack | null): string {
  if (!text.includes('$') && !text.includes('\\') && !text.includes("'") && !text.includes('"')) {
    return text
  }
  const out: string[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i] ?? ''
    if (ch === '\\' && i + 1 < n) {
      out.push(escapeGlob(text[i + 1] ?? ''))
      i += 2
      continue
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      if (end !== -1) {
        out.push(escapeGlob(text.slice(i + 1, end)))
        i = end + 1
        continue
      }
    }
    if (ch === '"') {
      const end = escapedFind(text, i + 1, '"')
      if (end !== -1) {
        out.push(dquotedPattern(text.slice(i + 1, end), session, callStack))
        i = end + 1
        continue
      }
    }
    if (ch === '$' && i + 1 < n) {
      if (text[i + 1] === "'") {
        const end = escapedFind(text, i + 2, "'")
        if (end !== -1) {
          out.push(escapeGlob(decodeAnsiC(text.slice(i + 2, end))))
          i = end + 1
          continue
        }
      }
      const ref = refEnd(text, i + 1)
      if (ref !== null) {
        out.push(lookupVar(ref[0], session, callStack))
        i = ref[1]
        continue
      }
    }
    out.push(ch)
    i += 1
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
  if (patternMode && QUOTED_ARG_TYPES.has(node.type)) {
    // Quoted pattern text matches literally, the same rule case
    // patterns follow: the value, inner expansions included, is
    // escaped so its glob characters match themselves.
    return escapeGlob(await expandChild(node))
  }
  if (patternMode && LITERAL_ARG_TYPES.has(node.type)) {
    return patternText(node.text, session, callStack)
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

/**
 * The arithmetic operands of one expansion, evaluated in one record.
 *
 * A substring offset, a length and a slice bound are arithmetic
 * (`${v:1+1}`, `${a[@]:i:n}`), so each may assign and seed. bash binds
 * an assignment as it makes it, so the second operand sees the first's
 * (`${v:x=1:y=x+1}` leaves y at 2) and draws from a `RANDOM` the first
 * seeded; the writes themselves land through the door once the word has
 * expanded (`landArithWrites`), so a refusal never leaves the word
 * half-applied. Element references resolve through the session, so an
 * operand may name one (`${v:a[0]}`).
 */
class ArithOperand {
  readonly reader: RandomReader
  readonly writes: ArithWrite[] = []
  // The reference the operands belong to (`v`, `a[@]`), which bash names
  // ahead of a failing operand.
  ref = ''
  private readonly pending: Record<string, string> = {}
  private readonly pendingElems = new Map<string, string>()

  constructor(private readonly session: Session) {
    this.reader = randomReader(session)
  }

  /**
   * The session's element callbacks, the pending element writes laid
   * over their reads, so `${v:(a[0]=2):(a[0])}` reads the 2 the first
   * operand assigned.
   */
  private elements(): ElementOps {
    const inner = sessionElements(this.session, this.reader)
    const pending = this.pendingElems
    return {
      resolve: (name, subscript, env) => inner.resolve(name, subscript, env),
      read: (name, key) => pending.get(`${name}\0${key}`) ?? inner.read(name, key),
      isAssoc: (name) => inner.isAssoc?.(name) ?? false,
    }
  }

  /**
   * The operand's value. An operand that does not evaluate ends the line,
   * as bash's does (`${v:1/0}` is `v: 1/0: division by 0`), once what it
   * assigned before failing is recorded for the door.
   */
  value(text: string): number {
    if (/^\s*-?\d+\s*$/.test(text)) return Number.parseInt(text.trim(), 10)
    const env = { ...visibleEnv(this.session), ...this.pending }
    try {
      const result = evaluateArith(
        text,
        env,
        0,
        this.elements(),
        this.reader.read,
        this.reader.wrote,
      )
      this.record(result.writes)
      return Number(result.value)
    } catch (err) {
      if (!(err instanceof ArithError)) throw err
      this.record(err.writes)
      throw new ExitSignal(
        1,
        new TextEncoder().encode(`bash: ${this.ref}: ${text.trim()}: ${err.message}\n`),
        null,
        1,
      )
    }
  }

  private record(writes: readonly ArithWrite[]): void {
    this.writes.push(...writes)
    for (const write of writes) {
      if (write.key === null) this.pending[write.name] = write.value
      else this.pendingElems.set(`${write.name}\0${write.key}`, write.value)
    }
  }
}

function substring(val: string, groups: string[], operand: ArithOperand): string {
  const offsetRaw = groups[0]
  if (offsetRaw === undefined) return val
  let offset = operand.value(offsetRaw)
  const lengthRaw = groups[1]
  const length = lengthRaw === undefined ? null : operand.value(lengthRaw)
  if (offset < 0) offset = Math.max(0, val.length + offset)
  if (length === null) return val.slice(offset)
  if (length < 0) return val.slice(offset, Math.max(offset, val.length + length))
  return val.slice(offset, offset + length)
}

/** Resolve `${a[@]:offset:length}` against a shell array. */
function sliceArray(arr: ShellArray, groups: string[], operand: ArithOperand): string[] {
  const offsetRaw = groups[0]
  if (offsetRaw === undefined) return arrayValues(arr)
  const offset = operand.value(offsetRaw)
  const lengthRaw = groups[1]
  const length = lengthRaw === undefined ? null : operand.value(lengthRaw)
  return arraySlice(arr, offset, length)
}

// True for the "${a[@]...}" forms bash keeps as one word per element:
// plain, slice, per-element strip/replace/case ops, and ${!a[@]}
// indices. False for single-word forms (${a[*]}, ${#a[@]}, non-@
// subscript, or a default/alternate op acting on the joined value).
// The positional parameters in scope, function args winning.
function positionalArgs(session: Session, callStack: CallStack | null): string[] {
  if (callStack !== null && callStack.getAllPositional().length > 0) {
    return callStack.getAllPositional()
  }
  return session.positionalArgs
}

// Whether a parsed "${...}" splats one word per element. Two spellings
// mean the same thing: an `@` subscript on a name (`${a[@]}`) and the
// positional parameters themselves (`${@}`, which bash word-splits
// exactly like the bare `$@`). `${*}` and `${a[*]}` are excluded
// because they join.
function isAtSplat(p: { subscript: string | null; varName: string | null }): boolean {
  if (p.subscript === '@') return true
  return p.subscript === null && p.varName === '@'
}

export function isMultiwordAt(node: TSNodeLike): boolean {
  if (node.type === NT.SIMPLE_EXPANSION) {
    // Bare "$@" is the positional splat. It word-splits exactly like
    // "${a[@]}" and stitches onto surrounding literals the same way, so
    // it takes the same path rather than a rule of its own.
    return node.text.trim() === '$@'
  }
  if (node.type !== NT.EXPANSION) return false
  const p = parseBraces(node)
  if (!isAtSplat(p) || p.lengthOp) return false
  if (p.indirectOp || p.op === null) return true
  return MULTIWORD_AT_OPS.has(p.op)
}

// Resolve a multi-word "${a[@]...}" splat to its word list. Only call
// when isMultiwordAt is true; the caller word-splits (or stitches
// prefix/suffix onto) the words, matching bash's quoted-splat rule. A
// slice bound is arithmetic and may assign (`${a[@]:x=1:y=x+1}`); those
// land through the door once the words are known, as expandBraces lands
// its own.
export async function expandArrayAt(
  node: TSNodeLike,
  session: Session,
  callStack: CallStack | null,
  expandChild: ExpandChild,
  view?: SessionView,
): Promise<string[]> {
  const operand = new ArithOperand(session)
  let words: string[]
  try {
    words = await expandArrayAtIn(node, session, callStack, expandChild, operand)
  } catch (err) {
    if (err instanceof ExitSignal)
      await landArithWrites(session, view, operand.writes, operand.reader)
    throw err
  }
  await landArithWrites(session, view, operand.writes, operand.reader)
  return words
}

async function expandArrayAtIn(
  node: TSNodeLike,
  session: Session,
  callStack: CallStack | null,
  expandChild: ExpandChild,
  operand: ArithOperand,
): Promise<string[]> {
  if (node.type === NT.SIMPLE_EXPANSION) return positionalArgs(session, callStack)
  const p = parseBraces(node)
  operand.ref = (p.varName ?? '') + (p.subscript === null ? '' : `[${p.subscript}]`)
  const env = visibleEnv(session)
  let arr: ShellArray | undefined
  if (p.subscript === null && p.varName === '@') {
    // "${@}" splats the positional parameters; every op below then
    // applies per element, which is what bash does for "${@/x/y}". A
    // slice is the exception: bash numbers the parameters from 1 there,
    // so index 0 is the shell's own name and "${@:0}" yields it ahead
    // of $1. Pinned on bash 5.2.37; macOS bash 3.2 drops it, so probe
    // this one in docker, not locally.
    const params = positionalArgs(session, callStack)
    arr = p.op === ':' ? [session.argv0, ...params] : params
  } else {
    const arrName = p.varName === null ? '' : deref(session, p.varName) || p.varName
    arr = visibleArrays(session)[arrName]
    if (arr === undefined && p.varName !== null) {
      const amap = visibleAssocs(session)[arrName]
      if (amap !== undefined) {
        if (p.indirectOp) {
          // Sorted keys, the same deterministic order every other walk
          // of an associative array answers in.
          return Object.keys(amap).sort(compareCodePoints)
        }
        arr = Object.keys(amap)
          .sort(compareCodePoints)
          .map((k) => amap[k] ?? '')
      }
    }
  }
  if (arr === undefined) {
    const scalarName = p.varName === null ? '' : deref(session, p.varName) || p.varName
    const scalar = env[scalarName]
    arr = scalar === undefined ? [] : [scalar]
  }
  if (p.indirectOp) return arrayIndices(arr).map((i) => String(i))
  const values = arrayValues(arr)
  if (p.op === null) return values
  const op = p.op
  const groups: string[] = []
  for (let gi = 0; gi < p.groups.length; gi++) {
    const patternMode = gi === 0 && PATTERN_OPS.has(op)
    groups.push(await expandGroup(p.groups[gi] ?? [], expandChild, patternMode, session, callStack))
  }
  if (op === ':') return sliceArray(arr, groups, operand)
  return values.map((el) => valueOp(op, el, groups, operand))
}

const SUBSCRIPT_LITERAL_TYPES: ReadonlySet<string> = new Set([NT.WORD, NT.NUMBER, NT.ERROR])

// The operators whose word bash expands only once the parameter's state
// selects it (a default, an alternate, an assignment, a message).
const LAZY_OPS: ReadonlySet<string> = new Set(['?', ':?', '=', ':=', ':-', '-', ':+', '+'])

/** The word of a conditional operator, expanded now that it is needed. */
async function operatorWord(
  p: BraceParse,
  expandChild: ExpandChild,
  session: Session,
  callStack: CallStack | null,
): Promise<string> {
  const group = p.groups[0]
  if (group === undefined) return ''
  return expandGroup(group, expandChild, false, session, callStack)
}

/**
 * The associative key one subscript spells.
 *
 * A purely literal subscript keeps its raw spelling, spaces included,
 * which is what bash stores for `m[ k ]`; anything carrying an
 * expansion or quoting expands node by node (`${m[$k]}`, `${m["a b"]}`)
 * so substitution and quote removal land.
 */
async function expandSubscriptKey(p: BraceParse, expandChild: ExpandChild): Promise<string> {
  const nodes = p.subscriptNodes
  if (nodes.length === 0 || nodes.every((n) => SUBSCRIPT_LITERAL_TYPES.has(n.type))) {
    return p.subscript ?? ''
  }
  const parts: string[] = []
  for (const n of nodes) parts.push(await expandChild(n))
  return parts.join('')
}

function valueOp(op: string, val: string, groups: string[], operand: ArithOperand): string {
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
    return substring(val, groups, operand)
  }
  return val
}

/**
 * One expansion-time write, through the session plane's door.
 *
 * `${X:=d}`, `${a[i]:=d}` and `$((X=5))` are assignments the shell
 * performs while expanding a word rather than while running a command,
 * and they used to land on the raw session env. That made a `preSession`
 * rule one `${X:=d}` away from irrelevant: a deployment refusing `AWS_*`
 * still had `${AWS_PROFILE:=prod}` write it. They go through the door
 * now, so one rule covers every spelling.
 *
 * Without a door (a unit test outside a workspace) the write lands
 * directly, with the hidden half still applied: skipping that would let
 * the write-back clobber a value the host's wiring reads.
 *
 * The element mechanics are `assignElement`'s: a bare name (null key)
 * over an array takes the write at element 0 and keeps its other
 * elements (`a=(1 2 3)` then `$((a=5))` leaves `5 2 3`), an associative
 * one writes the literal key "0", and a subscripted target arrives with
 * its key already canonical. Throws ExitSignal when the name is hidden,
 * a preSession rule refuses, the subscript is bad, or the name carries
 * `-i` and the text does not evaluate (the line dies with status 1, the
 * shape `${var:?}` uses); ReadonlyVariableError when the name is
 * readonly, the same refusal a plain assignment raises through the door.
 */
/**
 * Land an arithmetic expansion's assignments and settle its draws. Each
 * write goes through `expansionWrite` in evaluation order; then the
 * `RANDOM` reader replays the draws the expression made after it seeded
 * the generator, now that the door holds the seed. One door for a
 * completed expression and for one that failed partway, since bash
 * binds each assignment as it is made.
 */
/**
 * The line's death for a refused expansion-time write: the gate's own
 * reason, or the `-i` coercion refusing the text; status 1, the shape
 * `${var:?}` uses.
 */
function writeRefusal(err: PolicyDenied | ArithError): ExitSignal {
  return new ExitSignal(1, new TextEncoder().encode(`bash: ${err.message}\n`), null, 1)
}

/**
 * `subscriptIndex` in the expansion's voice: the subscript's assignments
 * land as the index resolves (`${a[x=3]}` leaves x at 3, `${a[RANDOM=42]}`
 * seeds), and a refused one dies the way `expansionWrite`'s does.
 */
async function expansionIndex(
  session: Session,
  view: SessionView | undefined,
  subscript: string,
): Promise<number> {
  try {
    return await subscriptIndex(session, subscript, view ?? null)
  } catch (err) {
    if (err instanceof PolicyDenied || err instanceof ArithError) throw writeRefusal(err)
    throw err
  }
}

export async function landArithWrites(
  session: Session,
  view: SessionView | undefined,
  writes: readonly ArithWrite[],
  reader: RandomReader,
): Promise<void> {
  for (const write of writes) {
    await expansionWrite(session, view, write.name, write.key, write.value)
  }
  reader.settle()
}

export async function expansionWrite(
  session: Session,
  view: SessionView | undefined,
  name: string,
  key: string | null,
  value: string,
): Promise<void> {
  guardExpansionWrite(session, name)
  let status: string
  try {
    status = await assignElement(session, view ?? null, name, key, value)
  } catch (err) {
    // A PolicyDenied is the gate; an ArithError is the name carrying
    // `-i` refusing the text. Both die as `n=1+` does, in that voice.
    if (!(err instanceof PolicyDenied) && !(err instanceof ArithError)) throw err
    throw writeRefusal(err)
  }
  if (status === 'readonly') throw new ReadonlyVariableError(name)
  if (status !== 'ok') {
    throw new ExitSignal(
      1,
      new TextEncoder().encode(`bash: ${name}[${key ?? ''}]: bad array subscript\n`),
      null,
      1,
    )
  }
}

/**
 * Expand `${VAR}`, `${VAR<op>...}`, `${a[i]}`, `${#a[@]}`, etc.
 *
 * An offset, length or slice bound is arithmetic and may assign
 * (`${v:x=1:y=2}`) or seed (`${v:RANDOM%10:1}`); those land through the
 * door once the word has expanded, then the `RANDOM` reader settles, so
 * the line ends where bash's does.
 */
export async function expandBraces(
  node: TSNodeLike,
  session: Session,
  callStack: CallStack | null,
  expandChild: ExpandChild,
  view?: SessionView,
): Promise<string> {
  const operand = new ArithOperand(session)
  let value: string
  try {
    value = await expandBracesIn(node, session, callStack, expandChild, view, operand)
  } catch (err) {
    // bash bound what an operand assigned before the one that failed;
    // they land before the line dies.
    if (err instanceof ExitSignal)
      await landArithWrites(session, view, operand.writes, operand.reader)
    throw err
  }
  await landArithWrites(session, view, operand.writes, operand.reader)
  return value
}

async function expandBracesIn(
  node: TSNodeLike,
  session: Session,
  callStack: CallStack | null,
  expandChild: ExpandChild,
  view: SessionView | undefined,
  operand: ArithOperand,
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
  const env = visibleEnv(session)
  const arrays = visibleArrays(session)
  operand.ref = (p.varName ?? '') + (p.subscript === null ? '' : `[${p.subscript}]`)

  // A conditional operator's word expands only if the parameter's state
  // selects it, as bash's does: `${RANDOM:-$RANDOM}` draws once and
  // `${x:-$(cmd)}` runs cmd only when x is unset. Every other operator's
  // words are needed whatever the value, and expand here.
  const groups: string[] = []
  if (p.op === null || !LAZY_OPS.has(p.op)) {
    for (let gi = 0; gi < p.groups.length; gi++) {
      const patternMode = gi === 0 && p.op !== null && PATTERN_OPS.has(p.op)
      groups.push(
        await expandGroup(p.groups[gi] ?? [], expandChild, patternMode, session, callStack),
      )
    }
  }

  let val = ''
  let varInEnv = false
  // The subscript as `:=` would write it: the key itself for an
  // associative name, the resolved index for an indexed one, null for
  // `[@]`/`[*]` and a negative index past the front, which bash refuses
  // to assign through.
  let writeKey: string | null = null

  // A subscripted reference reads and writes through a name reference
  // the way a bare one does, so the target is resolved once here.
  const baseName = p.varName === null ? null : deref(session, p.varName) || p.varName
  const amap = baseName !== null ? visibleAssocs(session)[baseName] : undefined
  if (p.subscript !== null && baseName !== null && amap !== undefined) {
    if (p.subscript === '@' || p.subscript === '*') {
      // Sorted-key order everywhere an associative array is walked:
      // bash iterates its hash table, whose order is unpredictable,
      // and a deterministic answer beats reproducing noise.
      const keys = Object.keys(amap).sort(compareCodePoints)
      const values = keys.map((k) => amap[k] ?? '')
      if (p.indirectOp) return keys.join(' ')
      if (p.lengthOp) return String(values.length)
      if (p.op === ':') {
        return sliceArray(values, groups, operand).join(' ')
      }
      if (p.op !== null && (STRIP_OPS.has(p.op) || REPLACE_OPS.has(p.op) || CASE_OPS.has(p.op))) {
        const op = p.op
        return values.map((el) => valueOp(op, el, groups, operand)).join(' ')
      }
      val = values.join(' ')
      varInEnv = keys.length > 0
    } else {
      // A key, not an expression: `${m[1+1]}` reads the key "1+1",
      // never element 2. An empty key reads as unset (GNU warns "bad
      // array subscript" on stderr and expands empty; expansion has no
      // warning channel, so the empty answer stands alone).
      const key = await expandSubscriptKey(p, expandChild)
      val = amap[key] ?? ''
      varInEnv = amap[key] !== undefined
      writeKey = key
    }
  } else if (p.subscript !== null && baseName !== null) {
    let arr = arrays[baseName]
    if (arr === undefined) {
      // A scalar is element 0 of a one-element array, even when empty:
      // ${#x[@]} is 1 for x="" but 0 for an unset name.
      const scalar = env[baseName]
      arr = scalar === undefined ? [] : [scalar]
    }
    varInEnv = baseName in arrays || baseName in env
    if (p.subscript === '@' || p.subscript === '*') {
      // ${a[@]} and friends see only the assigned elements: a hole left
      // by `unset a[i]` (or skipped by a[9]=v) neither expands nor
      // counts, though it keeps the later indices in place.
      const values = arrayValues(arr)
      if (p.indirectOp) {
        return arrayIndices(arr)
          .map((i) => String(i))
          .join(' ')
      }
      if (p.lengthOp) return String(values.length)
      if (p.op === ':') {
        return sliceArray(arr, groups, operand).join(' ')
      }
      if (p.op !== null && (STRIP_OPS.has(p.op) || REPLACE_OPS.has(p.op) || CASE_OPS.has(p.op))) {
        const op = p.op
        return values.map((el) => valueOp(op, el, groups, operand)).join(' ')
      }
      val = values.join(' ')
    } else {
      const subText = await expandSubscriptKey(p, expandChild)
      let idx = await expansionIndex(session, view, subText)
      if (idx < 0) idx += arrayExtent(arr)
      val = arrayGet(arr, idx)
      varInEnv = arrayHas(arr, idx)
      if (idx >= 0) writeKey = String(idx)
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
      val = arrayGet(arrays[p.varName] ?? [], 0)
      varInEnv = true
    }
    if (!varInEnv && amap !== undefined) {
      // A bare `$m` on an associative array is `${m["0"]}`, the
      // literal key, exactly as bash reads it.
      val = amap['0'] ?? ''
      varInEnv = amap['0'] !== undefined
    }
    if (!varInEnv && p.varName === RANDOM) {
      // `${RANDOM}` draws as `$RANDOM` does: the env holds the last word,
      // which a read must not hand back unchanged.
      const drawn = nextRandom(session, env[RANDOM])
      if (drawn !== null) {
        val = String(drawn)
        varInEnv = true
      }
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
    // `${!r}` on a name reference is the target's *name*, not an
    // indirection through the value.
    const target = p.varName !== null ? namerefTarget(session, p.varName) : null
    if (target !== null) return target
    return val !== '' ? lookupVar(val, session, callStack) : ''
  }
  if (p.lengthOp) return String(val.length)
  if (p.op === null) return val
  if (p.op === '?' || p.op === ':?') {
    const triggered = p.op === '?' ? !varInEnv : val === ''
    if (!triggered) return val
    const word = await operatorWord(p, expandChild, session, callStack)
    const message =
      word !== '' ? word : p.op === '?' ? 'parameter not set' : 'parameter null or not set'
    // GNU: fatal at top level with status 127; a containing
    // subshell/pipeline segment reports 1. A subscripted reference is
    // named whole: `bash: m[zz]: nope`.
    const ref = p.subscript === null ? (p.varName ?? '') : `${p.varName ?? ''}[${p.subscript}]`
    throw new ExitSignal(127, new TextEncoder().encode(`bash: ${ref}: ${message}\n`), null, 1)
  }
  if (p.op === '=' || p.op === ':=') {
    const triggered = p.op === '=' ? !varInEnv : val === ''
    if (!triggered) return val
    const defaultVal = await operatorWord(p, expandChild, session, callStack)
    if (p.varName !== null && p.subscript !== null) {
      // The default lands on the element the reference named, never on
      // element 0: `${m[k]:=v}` writes key k and `${a[3]:=v}` writes
      // index 3, as bash does. `[@]`, `[*]` and an index before the
      // front are refused in bash's words.
      if (writeKey === null) {
        throw new ExitSignal(
          1,
          new TextEncoder().encode(`bash: ${p.varName}[${p.subscript}]: bad array subscript\n`),
          null,
          1,
        )
      }
      await expansionWrite(session, view, p.varName, writeKey, defaultVal)
    } else if (callStack !== null && callStack.getLocal(p.varName ?? '') !== null) {
      callStack.setLocal(p.varName ?? '', defaultVal)
    } else if (p.varName !== null) {
      await expansionWrite(session, view, p.varName, null, defaultVal)
    }
    return defaultVal
  }
  if (p.op === ':-')
    return val !== '' ? val : await operatorWord(p, expandChild, session, callStack)
  if (p.op === '-') return varInEnv ? val : await operatorWord(p, expandChild, session, callStack)
  if (p.op === ':+') return val !== '' ? await operatorWord(p, expandChild, session, callStack) : ''
  if (p.op === '+') return varInEnv ? await operatorWord(p, expandChild, session, callStack) : ''
  return valueOp(p.op, val, groups, operand)
}
