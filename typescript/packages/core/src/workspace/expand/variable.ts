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

import { substringOperands } from './substring.ts'

import { badSubstitution, scanParameter } from '../../shell/parameter.ts'
import { nextRandom } from '../session/state.ts'
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
import {
  ArithError,
  BadSubstitution,
  DiscardSignal,
  ExitSignal,
  named,
  ReadonlyError,
  UnboundVariable,
} from '../../shell/errors.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import type { SessionView } from '../../view/types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { SessionState } from '../session/session.ts'
import { assignElement, landedArith } from '../session/elements.ts'
import {
  ensureVarVisible,
  visibleArrays,
  visibleAssocs,
  visibleEnv,
  deref,
  namerefTarget,
  positionalParams,
  subscriptIndex,
} from '../session/state.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { decodeAnsiC } from '../../shell/escapes.ts'
import { sourceParts } from '../../shell/helpers.ts'
import { fnmatch } from '../../utils/fnmatch.ts'
import { escapeGlob, markGlobs } from '../../utils/glob_walk.ts'
import { expandTilde } from '../../utils/path.ts'
import { OPERAND_DQUOTE_ESCAPES } from './constants.ts'
import { chunksText, ifsJoiner, splatChunks, valuePiece } from './fields.ts'
import { type Chunk, piece } from './types.ts'
import { encodeText } from '../../shell/bytes.ts'

export type ExpandChild = (node: TSNodeLike, quoted: boolean) => Promise<Chunk[]>

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

/**
 * Refuse expansion-time writes that name hidden variables.
 *
 * `${X:=d}` and `$((X=5))` land on the raw session env rather than the
 * async session view, so the hidden half of the session view
 * (`ensureVarVisible`) is applied here, and the refusal takes the
 * fatal expansion-error shape `${var:?}` uses.
 */
function guardExpansionWrite(session: SessionState, ...names: string[]): void {
  for (const name of names) {
    try {
      ensureVarVisible(session, name)
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      throw new DiscardSignal(encodeText(`bash: ${err.message}\n`))
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
  session: SessionState,
  callStack: CallStack | null,
  strict = true,
): string {
  const env = visibleEnv(session)
  const lastExitCode = session.lastExitCode
  const positional = positionalParams(session, callStack)
  const nounset = strict && session.shellOptions.nounset === true
  if (name === '@' || name === '*') {
    // Read where nothing splits: `$@` joins on a space and `$*` on the
    // first character of IFS, as `v=$*` stores them.
    const joiner = name === '@' ? ' ' : ifsJoiner(ifsValue(session, callStack))
    return positional.join(joiner)
  }
  if (name === '#') return String(positional.length)
  if (name === '?') {
    return String(lastExitCode)
  }
  if (name === '$') {
    return String(session.shellPid ?? session.processId ?? 0)
  }
  if (name === '!') {
    return session.lastBgJobId !== null ? String(session.lastBgJobId) : ''
  }
  if (/^\d+$/.test(name)) {
    const idx = parseInt(name, 10)
    if (idx === 0) return session.argv0
    if (idx <= positional.length) return positional[idx - 1] ?? ''
    if (nounset) throw new UnboundVariable(name)
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
    if (nounset) throw new UnboundVariable(name)
    return ''
  }
  return env[name] ?? ''
}

/** Whether `name` is a positional parameter the current count reaches. */
function positionalSet(name: string, session: SessionState, callStack: CallStack | null): boolean {
  if (!/^\d+$/.test(name)) return false
  const idx = parseInt(name, 10)
  return idx === 0 || idx <= positionalParams(session, callStack).length
}

/**
 * The IFS in scope, a function's `local IFS` first; null when IFS is
 * unset, which splits the way the default does.
 */
export function ifsValue(session: SessionState, callStack: CallStack | null): string | null {
  if (callStack) {
    const local = callStack.getLocal('IFS')
    if (local !== null) return local
  }
  return visibleEnv(session).IFS ?? null
}

/**
 * One `$name` reference as pieces of the word it stands in. `$@` is one
 * field per positional parameter, quoted or not, and so is an unquoted
 * `$*`; inside double quotes `$*` is the parameters joined on the first
 * character of IFS.
 */
export function parameterChunks(
  name: string,
  session: SessionState,
  callStack: CallStack | null,
  quoted: boolean,
): Chunk[] {
  if (name !== '@' && name !== '*') return [valuePiece(lookupVar(name, session, callStack), quoted)]
  const params = positionalParams(session, callStack)
  const joiner = name === '@' ? ' ' : ifsJoiner(ifsValue(session, callStack))
  if (name === '*' && quoted) return [valuePiece(params.join(joiner), true)]
  return splatChunks(params, joiner, quoted)
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
  groups: (string | TSNodeLike)[][]
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
  const groups: (string | TSNodeLike)[][] = []
  let seenVar = false

  for (const c of sourceParts(node)) {
    if (typeof c === 'string') {
      if (op !== null) groups[groups.length - 1]?.push(c)
      continue
    }
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
  if (lengthOp && varName === null) {
    // A `#` naming nothing after it is the parameter itself: `${#}` is the
    // count and `${!#}` the last positional parameter.
    varName = '#'
    lengthOp = false
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

// A double-quoted pattern segment: everything in it is literal.
function dquotedPattern(inner: string, session: SessionState, callStack: CallStack | null): string {
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
      const ref = scanParameter(inner, i)
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
function patternText(text: string, session: SessionState, callStack: CallStack | null): string {
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
      const ref = scanParameter(text, i)
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

/** A nested node's text where nothing splits, glob marks removed. */
async function childText(expandChild: ExpandChild, node: TSNodeLike): Promise<string> {
  return chunksText(await expandChild(node, false))
}

async function patternOperand(
  node: TSNodeLike,
  expandChild: ExpandChild,
  session: SessionState,
  callStack: CallStack | null,
): Promise<string> {
  if (node.type === NT.CONCATENATION) {
    return patternGroup([...sourceParts(node)], expandChild, session, callStack)
  }
  if (QUOTED_ARG_TYPES.has(node.type)) {
    // Quoted pattern text matches literally, the same rule case
    // patterns follow: the value, inner expansions included, is
    // escaped so its glob characters match themselves.
    return escapeGlob(await childText(expandChild, node))
  }
  if (LITERAL_ARG_TYPES.has(node.type)) {
    return patternText(node.text, session, callStack)
  }
  return childText(expandChild, node)
}

// Expand one pattern operand, the source text between its nodes included.
// That text is only ever the scanner's extras: blanks, a line
// continuation, which vanishes, and an escaped blank, which is the blank
// as in an unquoted word.
async function patternGroup(
  parts: readonly (string | TSNodeLike)[],
  expandChild: ExpandChild,
  session: SessionState,
  callStack: CallStack | null,
): Promise<string> {
  const pieces: string[] = []
  for (const part of parts) {
    pieces.push(
      typeof part === 'string'
        ? part.replaceAll('\\\n', '').replaceAll('\\', '')
        : await patternOperand(part, expandChild, session, callStack),
    )
  }
  return pieces.join('')
}

/**
 * Literal operand text as pieces; the rules are `wordChunks`'. `home` is
 * what a leading `~` names, null where no tilde prefix can stand.
 */
function operandLiteral(
  text: string,
  quoted: boolean,
  session: SessionState,
  callStack: CallStack | null,
  home: string | null,
): Chunk[] {
  if (!quoted && home !== null && !text.includes('\\') && !text.includes('$')) {
    const tilde = expandTilde(text, home)
    if (tilde !== text) return [piece(tilde)]
  }
  const out: Chunk[] = []
  let run = ''
  const flush = (): void => {
    if (run !== '') out.push(valuePiece(run, quoted))
    run = ''
  }
  let index = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char === '\\' && index + 1 < text.length) {
      const escaped = text[index + 1] ?? ''
      index += 2
      if (escaped === '\n') continue
      if (!quoted) {
        flush()
        out.push(piece(markGlobs(escaped)))
      } else if (OPERAND_DQUOTE_ESCAPES.has(escaped)) {
        run += escaped
      } else {
        run += char + escaped
      }
      continue
    }
    const ref = char === '$' ? scanParameter(text, index) : null
    if (ref !== null) {
      flush()
      for (const c of parameterChunks(ref[0], session, callStack, quoted)) out.push(c)
      index = ref[1]
      continue
    }
    run += char
    index += 1
  }
  flush()
  return out
}

/** An operand word's source parts, concatenations opened up. */
function* flatParts(parts: readonly (string | TSNodeLike)[]): Generator<string | TSNodeLike> {
  for (const part of parts) {
    if (typeof part !== 'string' && part.type === NT.CONCATENATION) {
      yield* flatParts([...sourceParts(part)])
    } else {
      yield part
    }
  }
}

/** Text whose every backslash quotes the character after it. */
function unescapeAll(text: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    if (text[index] === '\\' && index + 1 < text.length) {
      if (text[index + 1] !== '\n') out += text[index + 1] ?? ''
      index += 2
      continue
    }
    out += text[index] ?? ''
    index += 1
  }
  return out
}

/**
 * A double-quoted string inside the word of a quoted expansion. bash
 * reads the inner pair as leaving the outer quotes, so a backslash there
 * quotes any character, as in an unquoted word (`"${u:-"a\ b"}"` is
 * `a b`); the text is quoted all the same, a single quote and a glob
 * character literal and nothing splitting.
 */
async function nestedString(node: TSNodeLike, expandChild: ExpandChild): Promise<Chunk[]> {
  const out: Chunk[] = [piece('')]
  const inside = node.text.slice(1, -1)
  for (const part of sourceParts(node)) {
    let text: string
    if (typeof part === 'string') text = part
    else if (part.type === NT.STRING_CONTENT) text = part.text
    else if (part.type === NT.DQUOTE) text = part.text.slice(0, -1)
    else {
      for (const c of await named(inside, expandChild(part, true))) out.push(c)
      continue
    }
    out.push(piece(markGlobs(unescapeAll(text))))
  }
  return out
}

/**
 * Expand an operator's word to pieces of the word it stands in.
 *
 * Inside double quotes the word follows double-quote rules: a backslash
 * escapes only `$ ` " \ }` and a newline, a single-quoted string is
 * literal text, quotes and all, and nothing splits. Unquoted, an escaped
 * character and a quoted string are quoted text, which never splits,
 * while the word's literal text and its expansions split the way the
 * expansion's value would. The literal text runs between nodes are read
 * whole, source text between nodes included, since the grammar can split
 * one escape across two of them (`\\` arrives as a gap and a word); `$*`,
 * `$#` and the other special parameters arrive as literal text too, which
 * the grammar leaves unlexed inside an operand.
 */
async function wordChunks(
  parts: readonly (string | TSNodeLike)[],
  expandChild: ExpandChild,
  quoted: boolean,
  session: SessionState,
  callStack: CallStack | null,
): Promise<Chunk[]> {
  const home = homeDir(session)
  const out: Chunk[] = []
  let literal = ''
  for (const part of flatParts(parts)) {
    if (typeof part === 'string' || LITERAL_ARG_TYPES.has(part.type)) {
      literal += typeof part === 'string' ? part : part.text
      continue
    }
    for (const c of operandLiteral(
      literal,
      quoted,
      session,
      callStack,
      out.length === 0 ? home : null,
    ))
      out.push(c)
    literal = ''
    if (quoted && part.type === NT.RAW_STRING) out.push(piece(markGlobs(part.text)))
    else {
      const chunks =
        quoted && part.type === NT.STRING
          ? await nestedString(part, expandChild)
          : await expandChild(part, quoted)
      for (const c of chunks) out.push(c)
    }
  }
  for (const c of operandLiteral(
    literal,
    quoted,
    session,
    callStack,
    out.length === 0 ? home : null,
  ))
    out.push(c)
  return out
}

function globStrip(
  value: string,
  pattern: string,
  greedy: boolean,
  prefix: boolean,
  extglob = false,
): string {
  if (pattern === '') return value
  const boundaries = [0]
  for (const char of value) boundaries.push((boundaries.at(-1) ?? 0) + char.length)
  if (greedy === prefix) boundaries.reverse()
  for (const i of boundaries) {
    const candidate = prefix ? value.slice(0, i) : value.slice(i)
    if (fnmatch(candidate, pattern, extglob)) return prefix ? value.slice(i) : value.slice(0, i)
  }
  return value
}

// Bash ${var/pat/rep}: pattern is a glob, longest match wins. anchor is
// '#' (prefix), '%' (suffix), or null.
function globReplace(
  value: string,
  pattern: string,
  replacement: string,
  replaceAll: boolean,
  anchor: string | null,
  extglob = false,
): string {
  if (pattern === '') return value
  if (anchor === '#') {
    for (let j = value.length; j >= 0; j--) {
      if (fnmatch(value.slice(0, j), pattern, extglob)) return replacement + value.slice(j)
    }
    return value
  }
  if (anchor === '%') {
    for (let i = 0; i <= value.length; i++) {
      if (fnmatch(value.slice(i), pattern, extglob)) return value.slice(0, i) + replacement
    }
    return value
  }
  if (value === '') {
    return fnmatch('', pattern, extglob) ? replacement : value
  }
  const out: string[] = []
  let i = 0
  const n = value.length
  while (i < n) {
    let matchEnd = -1
    for (let j = n; j >= i; j--) {
      if (fnmatch(value.slice(i, j), pattern, extglob)) {
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

function caseMod(op: string, val: string, pattern: string, extglob = false): string {
  if (val === '') return val
  const all = op === '^^' || op === ',,'
  let out = ''
  for (let i = 0; i < val.length; i++) {
    const ch = val[i] ?? ''
    if ((!all && i > 0) || (pattern !== '' && !fnmatch(ch, pattern, extglob))) {
      out += ch
      continue
    }
    out += op === '^' || op === '^^' ? ch.toUpperCase() : ch.toLowerCase()
  }
  return out
}

/** Evaluate and apply one substring bound before expanding the next. */
class ArithOperand {
  ref = ''

  constructor(
    private readonly session: SessionState,
    private readonly view?: SessionView,
  ) {}

  async value(text: string): Promise<number> {
    const nounset = this.session.shellOptions.nounset === true
    try {
      return Number(
        await landedArith(this.session, this.view ?? null, text, landArithWrites, nounset),
      )
    } catch (err) {
      if (err instanceof ReadonlyError) throw err.signal()
      if (err instanceof ArithError) throw err.signal(this.ref)
      throw err
    }
  }
}

/** Expand/evaluate bounds left to right, stopping at an invalid offset. */
async function sliceBounds(
  node: TSNodeLike,
  expandChild: ExpandChild,
  operand: ArithOperand,
  extent: number,
  allowEnd = false,
): Promise<[number, number | null] | null> {
  const values: number[] = []
  for await (const text of substringOperands(node, (n) => childText(expandChild, n))) {
    let value = await operand.value(text)
    if (values.length === 0) {
      if (value < 0) value += extent
      if (value < 0 || value > extent || (value === extent && !allowEnd)) return null
    }
    values.push(value)
  }
  return [values[0] ?? 0, values[1] ?? null]
}

async function substring(
  val: string,
  node: TSNodeLike,
  expandChild: ExpandChild,
  operand: ArithOperand,
): Promise<string> {
  const bounds = await sliceBounds(node, expandChild, operand, val.length, true)
  if (bounds === null) return ''
  const [offset, length] = bounds
  if (length === null) return val.slice(offset)
  if (length < 0) return val.slice(offset, Math.max(offset, val.length + length))
  return val.slice(offset, offset + length)
}

async function sliceArray(
  arr: ShellArray,
  node: TSNodeLike,
  expandChild: ExpandChild,
  operand: ArithOperand,
): Promise<string[]> {
  const bounds = await sliceBounds(node, expandChild, operand, arrayExtent(arr))
  return bounds === null ? [] : arraySlice(arr, ...bounds)
}

// Whether a parsed "${...}" splats one word per element. Two spellings
// mean the same thing: an `@` subscript on a name (`${a[@]}`) and the
// positional parameters themselves (`${@}`, which bash word-splits
// exactly like the bare `$@`). `${*}` and `${a[*]}` are excluded
// because they join.
function isAtSplatParse(p: { subscript: string | null; varName: string | null }): boolean {
  if (p.subscript === '@') return true
  return p.subscript === null && p.varName === '@'
}

/**
 * Whether an expansion is a `$@`-style splat. Inside double quotes such
 * a splat yields one field per element and no field at all when there is
 * none: `"$@"` with no parameters is no word, where `"$*"` is one empty
 * word. `${#a[@]}` is a count, so it is one word like any other.
 */
export function isAtSplat(node: TSNodeLike): boolean {
  if (node.type === NT.SIMPLE_EXPANSION) return node.text.trim() === '$@'
  if (node.type !== NT.EXPANSION) return false
  const p = parseBraces(node)
  return isAtSplatParse(p) && !p.lengthOp
}

const SUBSCRIPT_LITERAL_TYPES: ReadonlySet<string> = new Set([NT.WORD, NT.NUMBER, NT.ERROR])

// The operators whose word bash expands only once the parameter's state
// selects it (a default, an alternate, an assignment, a message).
const LAZY_OPS: ReadonlySet<string> = new Set(['?', ':?', '=', ':=', ':-', '-', ':+', '+'])

/** The word of a conditional operator, expanded now that it is needed. */
async function operatorWord(
  p: BraceParse,
  expandChild: ExpandChild,
  quoted: boolean,
  session: SessionState,
  callStack: CallStack | null,
): Promise<Chunk[]> {
  const group = p.groups[0]
  if (group === undefined) return []
  return named(source(group), wordChunks(group, expandChild, quoted, session, callStack))
}

/** An operand's text as written, the word a bad substitution names. */
function source(parts: readonly (string | TSNodeLike)[]): string {
  return parts.map((part) => (typeof part === 'string' ? part : part.text)).join('')
}

/**
 * An operator's word standing in for a splat. A quoted splat that
 * selects its word yields that word even when it is empty: `"${e[@]:-}"`
 * is one empty word where `"${e[@]}"` is none.
 */
function wordResult(chunks: Chunk[], quoted: boolean): Chunk[] {
  return quoted ? [piece(''), ...chunks] : chunks
}

/**
 * The death of a line whose `${v:?word}` found v unset or null. The word
 * is the message, read with unquoted rules even inside double quotes, as
 * bash reads it. GNU: fatal at top level with status 127; a containing
 * subshell/pipeline segment reports 1. A subscripted reference is named
 * whole: `bash: m[zz]: nope`.
 */
async function unsetError(
  p: BraceParse,
  expandChild: ExpandChild,
  session: SessionState,
  callStack: CallStack | null,
): Promise<ExitSignal> {
  const word = chunksText(await operatorWord(p, expandChild, false, session, callStack))
  const message =
    word !== '' ? word : p.op === '?' ? 'parameter not set' : 'parameter null or not set'
  const ref = p.subscript === null ? (p.varName ?? '') : `${p.varName ?? ''}[${p.subscript}]`
  return new ExitSignal(127, encodeText(`bash: ${ref}: ${message}\n`), null, 1)
}

/** The refusal of a `:=` that names no single element. */
function badSubscript(p: BraceParse): DiscardSignal {
  return new DiscardSignal(
    encodeText(`bash: ${p.varName ?? ''}[${p.subscript ?? ''}]: bad array subscript\n`),
  )
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
  for (const n of nodes) parts.push(await childText(expandChild, n))
  return parts.join('')
}

function valueOp(op: string, val: string, groups: string[], extglob = false): string {
  if (STRIP_OPS.has(op)) {
    const pattern = groups[0] ?? ''
    return globStrip(val, pattern, op === '##' || op === '%%', op === '#' || op === '##', extglob)
  }
  if (REPLACE_OPS.has(op)) {
    const pattern = groups[0] ?? ''
    const replacement = groups[1] ?? ''
    let anchor: string | null = null
    if (op === '/#') anchor = '#'
    else if (op === '/%') anchor = '%'
    return globReplace(val, pattern, replacement, op === '//', anchor, extglob)
  }
  if (CASE_OPS.has(op)) {
    return caseMod(op, val, groups[0] ?? '', extglob)
  }
  return val
}

/**
 * The line's death for a refused expansion-time write: the gate's own
 * reason discards the line, as a readonly name's does, and so does the
 * `-i` coercion refusing the text, as `n=1+` does.
 */
function writeRefusal(err: PolicyDenied | ArithError): ExitSignal {
  return err instanceof PolicyDenied
    ? new DiscardSignal(encodeText(`bash: ${err.message}\n`))
    : err.signal('', true)
}

/**
 * `subscriptIndex` in the expansion's voice: the subscript's assignments
 * land as the index resolves (`${a[x=3]}` leaves x at 3, `${a[RANDOM=42]}`
 * seeds), and a refused one dies the way `expansionWrite`'s does.
 */
async function expansionIndex(
  session: SessionState,
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

/**
 * Land an arithmetic expansion's assignments and settle its draws. Each
 * write goes through `expansionWrite` in evaluation order; then the
 * `RANDOM` reader replays the draws the expression made after it seeded
 * the generator, now that the session view holds the seed. One entry point for a
 * completed expression and for one that failed partway, since bash
 * binds each assignment as it is made.
 */
export async function landArithWrites(
  session: SessionState,
  view: SessionView | null,
  writes: readonly ArithWrite[],
  reader: RandomReader,
): Promise<void> {
  try {
    for (const write of writes) {
      await expansionWrite(session, view ?? undefined, write.name, write.key, write.value)
    }
  } finally {
    reader.settle()
  }
}

/**
 * One expansion-time write, through the session view.
 *
 * `${X:=d}`, `${a[i]:=d}` and `$((X=5))` are assignments the shell
 * performs while expanding a word rather than while running a command,
 * and they used to land on the raw session env. That made a `preSession`
 * rule one `${X:=d}` away from irrelevant: a deployment refusing `AWS_*`
 * still had `${AWS_PROFILE:=prod}` write it. They go through the session view
 * now, so one rule covers every spelling.
 *
 * Without a session view (a unit test outside a workspace) the write lands
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
 * shape `${var:?}` uses); a readonly name discards the line too, and ends a
 * `( )` subshell with `contained`.
 */
export async function expansionWrite(
  session: SessionState,
  view: SessionView | undefined,
  name: string,
  key: string | null,
  value: string,
  contained = 1,
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
  if (status === 'readonly') {
    throw new DiscardSignal(encodeText(`bash: ${name}: readonly variable\n`), contained)
  }
  if (status !== 'ok') {
    throw new DiscardSignal(encodeText(`bash: ${name}[${key ?? ''}]: bad array subscript\n`))
  }
}

/**
 * Expand `${VAR}`, `${VAR<op>...}`, `${a[i]}`, `${#a[@]}`, etc. to pieces.
 *
 * An offset, length or slice bound is arithmetic and may assign
 * (`${v:x=1:y=2}`) or seed (`${v:RANDOM%10:1}`); those land through the
 * session view before the next bound expands, including its nested substitutions.
 * `quoted` says whether the expansion sits inside double quotes, which
 * decides the rules an operator's word follows and the shape a
 * `$*`-style splat takes.
 */
export async function expandBraces(
  node: TSNodeLike,
  session: SessionState,
  callStack: CallStack | null,
  expandChild: ExpandChild,
  view?: SessionView,
  quoted = false,
): Promise<Chunk[]> {
  return expandBracesIn(
    node,
    session,
    callStack,
    expandChild,
    view,
    new ArithOperand(session, view),
    quoted,
  )
}

async function expandBracesIn(
  node: TSNodeLike,
  session: SessionState,
  callStack: CallStack | null,
  expandChild: ExpandChild,
  view: SessionView | undefined,
  operand: ArithOperand,
  quoted: boolean,
): Promise<Chunk[]> {
  const text = node.text.trimStart()
  if (badSubstitution(text)) throw new BadSubstitution(text)
  const p = parseBraces(node)
  const env = visibleEnv(session)
  const arrays = visibleArrays(session)
  operand.ref = (p.varName ?? '') + (p.subscript === null ? '' : `[${p.subscript}]`)

  // A conditional operator's word expands only if the parameter's state
  // selects it, as bash's does: `${RANDOM:-$RANDOM}` draws once and
  // `${x:-$(cmd)}` runs cmd only when x is unset. Every other operator's
  // words are needed whatever the value, and expand here: the pattern as
  // a pattern, the replacement with unquoted rules even inside double
  // quotes, as bash reads it.
  const groups: string[] = []
  if (p.op !== ':' && (p.op === null || !LAZY_OPS.has(p.op))) {
    for (let gi = 0; gi < p.groups.length; gi++) {
      const group = p.groups[gi] ?? []
      if (gi === 0 && p.op !== null && PATTERN_OPS.has(p.op)) {
        groups.push(
          await named(source(group), patternGroup(group, expandChild, session, callStack)),
        )
      } else {
        groups.push(
          chunksText(
            await named(source(group), wordChunks(group, expandChild, false, session, callStack)),
          ),
        )
      }
    }
  }

  // A subscripted reference reads and writes through a name reference
  // the way a bare one does, so the target is resolved once here.
  const baseName = p.varName === null ? null : deref(session, p.varName) || p.varName
  const amap = baseName !== null ? visibleAssocs(session)[baseName] : undefined

  const splat = splatSource(p, session, callStack, env, arrays, baseName, amap)
  if (splat !== null) {
    return expandSplat(
      p,
      splat[0],
      splat[1],
      node,
      expandChild,
      operand,
      session,
      callStack,
      quoted,
      groups,
    )
  }

  let val = ''
  let varInEnv = false
  // The subscript as `:=` would write it: the key itself for an
  // associative name, the resolved index for an indexed one, null for a
  // negative index past the front, which bash refuses to assign through.
  let writeKey: string | null = null

  if (p.subscript !== null && baseName !== null && amap !== undefined) {
    // A key, not an expression: `${m[1+1]}` reads the key "1+1", never
    // element 2. An empty key reads as unset (GNU warns "bad array
    // subscript" on stderr and expands empty; expansion has no warning
    // channel, so the empty answer stands alone).
    const key = await named(p.subscript, expandSubscriptKey(p, expandChild))
    val = amap[key] ?? ''
    varInEnv = amap[key] !== undefined
    writeKey = key
  } else if (p.subscript !== null && baseName !== null) {
    let arr = arrays[baseName]
    if (arr === undefined) {
      // A scalar is element 0 of a one-element array, even when empty:
      // ${#x[@]} is 1 for x="" but 0 for an unset name.
      const scalar = env[baseName]
      arr = scalar === undefined ? [] : [scalar]
    }
    const subText = await named(p.subscript, expandSubscriptKey(p, expandChild))
    let idx = await expansionIndex(session, view, subText)
    if (idx < 0) idx += arrayExtent(arr)
    val = arrayGet(arr, idx)
    varInEnv = arrayHas(arr, idx)
    if (idx >= 0) writeKey = String(idx)
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
      // lookup; set-ness follows value presence, except that a
      // positional parameter is set whenever the count reaches it,
      // empty or not (`set -- ""` sets $1).
      val = lookupVar(p.varName, session, callStack, p.op === null || !UNSET_GUARD_OPS.has(p.op))
      varInEnv = val !== '' || positionalSet(p.varName, session, callStack)
    }
  }

  // `set -u` refuses an element or key that holds nothing, named as typed
  // (`a[i]`, `m[$k]`), unless the operator handles unset itself; a length
  // is 0 (bash 5.2.37). A scalar's refusal is lookupVar's.
  if (
    p.subscript !== null &&
    !varInEnv &&
    session.shellOptions.nounset === true &&
    !p.lengthOp &&
    !p.indirectOp &&
    (p.op === null || !UNSET_GUARD_OPS.has(p.op))
  ) {
    throw new UnboundVariable(`${p.varName ?? ''}[${p.subscript}]`)
  }
  if (p.indirectOp) {
    // `${!r}` on a name reference is the target's *name*, not an
    // indirection through the value.
    const target = p.varName !== null ? namerefTarget(session, p.varName) : null
    if (target !== null) return [valuePiece(target, quoted)]
    return [valuePiece(val !== '' ? lookupVar(val, session, callStack) : '', quoted)]
  }
  if (p.lengthOp) return [valuePiece(String(val.length), quoted)]
  if (p.op === null) return [valuePiece(val, quoted)]
  if (p.op === '?' || p.op === ':?') {
    const triggered = p.op === '?' ? !varInEnv : val === ''
    if (!triggered) return [valuePiece(val, quoted)]
    throw await unsetError(p, expandChild, session, callStack)
  }
  if (p.op === '=' || p.op === ':=') {
    const triggered = p.op === '=' ? !varInEnv : val === ''
    if (!triggered) return [valuePiece(val, quoted)]
    const defaultVal = chunksText(await operatorWord(p, expandChild, quoted, session, callStack))
    // A refused default ends a `( )` subshell, or a forked compound command,
    // with 2, unless `set -e` ends it first with 1; a line loop reads it as
    // a discard.
    const contained = callStack?.paren === true && session.shellOptions.errexit !== true ? 2 : 1
    if (p.varName !== null && p.subscript !== null) {
      // The default lands on the element the reference named, never on
      // element 0: `${m[k]:=v}` writes key k and `${a[3]:=v}` writes
      // index 3, as bash does. An index before the front is refused in
      // bash's words.
      if (writeKey === null) throw badSubscript(p)
      await expansionWrite(session, view, p.varName, writeKey, defaultVal, contained)
    } else if (callStack !== null && callStack.getLocal(p.varName ?? '') !== null) {
      callStack.setLocal(p.varName ?? '', defaultVal)
    } else if (p.varName !== null) {
      await expansionWrite(session, view, p.varName, null, defaultVal, contained)
    }
    return [valuePiece(defaultVal, quoted)]
  }
  if (p.op === ':-' || p.op === '-') {
    if (p.op === ':-' ? val !== '' : varInEnv) return [valuePiece(val, quoted)]
    return operatorWord(p, expandChild, quoted, session, callStack)
  }
  if (p.op === ':+' || p.op === '+') {
    if (!(p.op === ':+' ? val !== '' : varInEnv)) return []
    return operatorWord(p, expandChild, quoted, session, callStack)
  }
  if (p.op === ':') {
    // bash slices only a set parameter: an unset one expands empty and
    // its bounds are never evaluated, so `${a[i]:.2f}` is nothing while
    // a[i] is unset and an arithmetic error once it is set (5.2.37).
    if (!varInEnv) return [valuePiece('', quoted)]
    return [valuePiece(await substring(val, node, expandChild, operand), quoted)]
  }
  return [valuePiece(valueOp(p.op, val, groups, session.shopts.extglob ?? false), quoted)]
}

/**
 * The elements a `$@`/`$*`-style splat walks, and their keys.
 *
 * The positional parameters for `${@...}` and `${*...}`, which a slice
 * numbers from 1 so that index 0 is the shell's own name (`"${@:0}"`
 * yields it ahead of $1; pinned on bash 5.2.37, macOS bash 3.2 drops
 * it). Every element of an array for `${a[@]...}` and `${a[*]...}`,
 * holes left by `unset a[i]` included so a slice keeps its indices; an
 * associative array walks its keys sorted, since bash's hash order is
 * unpredictable and a deterministic answer beats reproducing noise. A
 * scalar is element 0 of a one-element array. Null for any other
 * expansion.
 */
function splatSource(
  p: BraceParse,
  session: SessionState,
  callStack: CallStack | null,
  env: Record<string, string>,
  arrays: Record<string, ShellArray>,
  baseName: string | null,
  amap: Record<string, string> | undefined,
): [ShellArray, string[]] | null {
  if (p.subscript === null) {
    if (p.varName !== '@' && p.varName !== '*') return null
    const params = positionalParams(session, callStack)
    const keys = params.map((_, i) => String(i + 1))
    return [p.op === ':' ? [session.argv0, ...params] : [...params], keys]
  }
  if (baseName === null || (p.subscript !== '@' && p.subscript !== '*')) return null
  if (amap !== undefined) {
    const keys = Object.keys(amap).sort(compareCodePoints)
    return [keys.map((k) => amap[k] ?? ''), keys]
  }
  let arr = arrays[baseName]
  if (arr === undefined) {
    const scalar = env[baseName]
    arr = scalar === undefined ? [] : [scalar]
  }
  return [arr, arrayIndices(arr).map((i) => String(i))]
}

/**
 * Expand a splat: one field per element, whatever the operator.
 *
 * `@` keeps its elements apart inside double quotes too, and a quoted
 * `*` joins them on IFS's first character. A slice, the per-element
 * strip, replace and case operators and `${!a[@]}`'s keys all stay a
 * splat; `${#a[@]}` is the count. A conditional operator tests the
 * elements as one: set when there is any, null when they join to
 * nothing, a space joining `@`'s as IFS joins `*`'s, so `("" "")` is
 * null for `*` alone under `IFS=`. Unselected, `:+` yields no field over
 * no elements and one empty field over empty ones, as bash does.
 */
async function expandSplat(
  p: BraceParse,
  arr: ShellArray,
  keys: string[],
  node: TSNodeLike,
  expandChild: ExpandChild,
  operand: ArithOperand,
  session: SessionState,
  callStack: CallStack | null,
  quoted: boolean,
  groups: string[],
): Promise<Chunk[]> {
  const star = (p.subscript ?? p.varName) === '*'
  const joiner = star ? ifsJoiner(ifsValue(session, callStack)) : ' '
  const values = arrayValues(arr)
  if (p.lengthOp) return [valuePiece(String(values.length), quoted)]
  let items = values
  const op = p.op
  if (p.indirectOp) {
    items = keys
  } else if (op === ':') {
    // An array with no element is unset to a slice, as a scalar is:
    // empty, bounds unevaluated. The positional parameters always
    // evaluate theirs, since `$0` stands at their front.
    const unset = p.subscript !== null && values.length === 0
    items = unset ? [] : await sliceArray(arr, node, expandChild, operand)
  } else if (op !== null && (STRIP_OPS.has(op) || REPLACE_OPS.has(op) || CASE_OPS.has(op))) {
    items = values.map((el) => valueOp(op, el, groups, session.shopts.extglob ?? false))
  } else if (op !== null && UNSET_GUARD_OPS.has(op)) {
    const triggered =
      op === '-' || op === '+' || op === '=' || op === '?'
        ? values.length === 0
        : values.join(joiner) === ''
    if (op === '+' || op === ':+') {
      if (triggered) return values.length > 0 ? splatChunks([''], joiner, quoted) : []
      return wordResult(await operatorWord(p, expandChild, quoted, session, callStack), quoted)
    }
    if (triggered && (op === '-' || op === ':-')) {
      return wordResult(await operatorWord(p, expandChild, quoted, session, callStack), quoted)
    }
    if (triggered && (op === '?' || op === ':?')) {
      throw await unsetError(p, expandChild, session, callStack)
    }
    if (triggered && p.subscript !== null) throw badSubscript(p)
    if (triggered) {
      throw new DiscardSignal(encodeText(`bash: $${p.varName ?? ''}: cannot assign in this way\n`))
    }
  }
  if (star && quoted) return [valuePiece(items.join(joiner), true)]
  return splatChunks(items, joiner, quoted)
}
