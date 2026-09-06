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

import { FindParseError } from '../errors.ts'
import { parseDateExpr } from '../../utils/dates.ts'
import type { PredNode } from './find_eval.ts'
import {
  EXEC_BATCH_END,
  EXEC_END,
  EXEC_PLACEHOLDER,
  FIND_BARE_PREDICATES,
  FIND_EXEC_PREDICATES,
  FIND_EXPRESSION_TOKENS,
  FIND_MAX_DEPTH,
  FIND_ROW_ACTIONS,
  FIND_VALID_TYPES,
  FIND_VALUE_PREDICATES,
} from './constants.ts'
import type { ExecAction, FindAction } from './types.ts'

const EXEC_PLACEMENT =
  'find: -exec is supported only in a top-level -a chain, not under -o, ! or parentheses'

/** The `-exec` actions of an expression, in order. */
export function execActions(actions: readonly FindAction[]): ExecAction[] {
  return actions.filter((a): a is ExecAction => a.kind === 'exec')
}

/**
 * One parsed find expression: the predicate tree plus everything the flat
 * window lifts out of it. The tests a backend can answer per entry stay in
 * `tree`; the windows (depth, size, mtime) and the actions are global to
 * the expression, because a native find op evaluates the tree and the
 * executor applies the actions to what came back. `newer` holds `-newer`
 * reference operands as typed, for the executor to resolve against the
 * dispatcher into `-newermt` bounds before any backend sees the
 * expression.
 */
export interface FindExpr {
  tree: PredNode
  maxDepth: number | null
  minDepth: number | null
  minSize: number | null
  maxSize: number | null
  mtimeMin: number | null
  mtimeMax: number | null
  usesEmpty: boolean
  printf: string | null
  // In the order written: GNU runs actions per position, so
  // `-exec echo {} ";" -print -exec echo again {} ";"` alternates the
  // three per match.
  actions: FindAction[]
  newer: string[]
  // GNU's -depth: every directory's contents come before the directory
  // itself. -delete turns it on, since a directory can only be removed
  // once what it holds is gone.
  depthFirst: boolean
}

/**
 * The inclusive lower bound that means "later than `timestamp`". `-newer`
 * and `-newermt` are strict (GNU: modified *more recently than*), and the
 * window is inclusive, so the bound is the next representable float:
 * exact, where adding an epsilon would either miss a timestamp or admit
 * the reference itself.
 */
export function strictlyAfter(timestamp: number): number {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, timestamp)
  const bits = view.getBigUint64(0)
  view.setBigUint64(0, timestamp >= 0 ? bits + 1n : bits - 1n)
  return view.getFloat64(0)
}

/** One `-newermt` argument as a GNU date expression; naive times are UTC. */
export function parseNewermt(value: string): number {
  const ts = parseDateExpr(value, true)
  if (ts === null || !Number.isFinite(ts.getTime()) || value.trim() === '@') {
    throw new FindParseError(
      `find: I cannot figure out how to interpret '${value}' as a date or time`,
    )
  }
  return ts.getTime() / 1000
}

/**
 * The argv index ranges, inclusive, that `-exec` owns. Every word from
 * `-exec` to its terminator is the action's, never an operand of find's
 * own: the classifier reads this so `echo`, `{}` and `;` are not turned
 * into start points. A span with no terminator runs to the end; the
 * parser reports that one.
 */
export function execSpans(argv: readonly string[]): [number, number][] {
  const spans: [number, number][] = []
  let i = 0
  while (i < argv.length) {
    if (!FIND_EXEC_PREDICATES.has(argv[i] ?? '')) {
      i += 1
      continue
    }
    const start = i
    i += 1
    while (i < argv.length) {
      const tok = argv[i]
      if (
        tok === EXEC_END ||
        (tok === EXEC_BATCH_END && i > start + 1 && (argv[i - 1] ?? '').includes(EXEC_PLACEHOLDER))
      ) {
        break
      }
      i += 1
    }
    spans.push([start, Math.min(i, argv.length - 1)])
    i += 1
  }
  return spans
}

// Number.parseInt accepts trailing garbage ('12abc' -> 12), which silently
// mis-read find's numeric arguments where python's int() and GNU both
// refuse them; only fully-consumed digits (one optional sign) parse.
function strictInt(value: string): number {
  const trimmed = value.trim()
  return /^[+-]?[0-9]+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN
}

// GNU rounds the file size up to whole units before comparing, and
// +N / -N are strict: +N keeps ceil(size/unit) > N, -N keeps
// ceil(size/unit) < N, N alone keeps ceil(size/unit) === N. Expressed
// as inclusive byte bounds: +N -> [N*unit + 1, inf), -N ->
// [0, (N-1)*unit], N -> [(N-1)*unit + 1, N*unit].
export function parseSize(spec: string): [number | null, number | null] {
  const suffixes: Record<string, number> = { c: 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3 }
  const raw = spec.startsWith('+') || spec.startsWith('-') ? spec.slice(1) : spec
  const last = raw[raw.length - 1] ?? ''
  const mult = suffixes[last] ?? 1
  const n = strictInt(raw.replace(/[ckMG]+$/, ''))
  if (Number.isNaN(n)) throw new FindParseError(`find: invalid argument '${spec}' to '-size'`)
  if (spec.startsWith('+')) return [n * mult + 1, null]
  if (spec.startsWith('-')) return [null, (n - 1) * mult]
  return [(n - 1) * mult + 1, n * mult]
}

export function parseMtime(spec: string): [number | null, number | null] {
  const day = 86400
  const now = Date.now() / 1000
  const n = strictInt(spec.replace(/^[+-]+/, ''))
  if (Number.isNaN(n)) throw new FindParseError(`find: invalid argument '${spec}' to '-mtime'`)
  if (spec.startsWith('+')) return [null, now - n * day]
  if (spec.startsWith('-')) return [now - n * day, null]
  return [now - (n + 1) * day, now - n * day]
}

function typeNode(value: string): PredNode {
  if (value === 'f' || value === 'file') return { op: 'type', kind: 'f' }
  if (value === 'd' || value === 'directory') return { op: 'type', kind: 'd' }
  if (FIND_VALID_TYPES.has(value)) return { op: 'type', kind: value }
  throw new FindParseError(`find: Unknown argument to -type: ${value}`)
}

export function parseDepth(value: string, flag: string): number {
  const n = strictInt(value)
  if (Number.isNaN(n)) throw new FindParseError(`find: invalid argument '${value}' to '${flag}'`)
  return n
}

// GNU find's link-policy options are leading options, not predicates:
// they may only appear before the start points, and never take part in
// the expression. Without this the tail scan would treat `-L` as the
// start of the expression and swallow the paths after it.
const LINK_OPTIONS = new Set(['-P', '-H', '-L'])

export function findExprTail(rawArgv: string[]): string[] {
  let start = 0
  while (start < rawArgv.length && LINK_OPTIONS.has(rawArgv[start] ?? '')) start++
  for (let i = start; i < rawArgv.length; i++) {
    const tok = rawArgv[i]
    if (tok === undefined) continue
    if (FIND_EXPRESSION_TOKENS.has(tok) || (tok.startsWith('-') && tok.length > 1)) {
      return rawArgv.slice(i)
    }
  }
  return []
}

export function parseFindExpression(tokens: string[]): FindExpr {
  const g = {
    maxDepth: null as number | null,
    minDepth: null as number | null,
    minSize: null as number | null,
    maxSize: null as number | null,
    mtimeMin: null as number | null,
    mtimeMax: null as number | null,
    usesEmpty: false,
    printf: null as string | null,
    actions: [] as FindAction[],
    newer: [] as string[],
    depthFirst: false,
  }
  let pos = 0
  let depth = 0
  // How many parentheses and negations enclose the current token, and
  // whether a top-level `-o` has been seen: an action under either would
  // need per-position evaluation the flat window cannot do.
  let nested = 0
  let inOr = false
  let mtimeSeen = false
  let newerToken: string | null = null
  const checkActionPlacement = (token: string): void => {
    if (nested > 0 || inOr) {
      throw new FindParseError(
        `find: ${token} is supported only in a top-level -a chain, not under -o, ! or parentheses`,
      )
    }
  }
  // Fold one mtime window into the expression's single window. The flat
  // window cannot evaluate a time test per predicate node, so repeated
  // ones fold by where they sit. In the top-level `-a` chain every test
  // must hold, so the windows intersect: `-newer old -newer new` keeps
  // only what is newer than both, and `-mtime +2 -mtime -1` keeps
  // nothing, as GNU answers. Under `-o`, `!` or parentheses the window
  // cannot be exact, so they widen to the union: the tautology `-mtime
  // +0 -o -mtime -1` imposes no bounds instead of last-wins dropping
  // everything (documented divergence from GNU: such a window
  // over-matches).
  const mergeWindow = (lo: number | null, hi: number | null): void => {
    if (!mtimeSeen) {
      ;[g.mtimeMin, g.mtimeMax] = [lo, hi]
      mtimeSeen = true
      return
    }
    if (nested === 0 && !inOr) {
      g.mtimeMin = g.mtimeMin === null ? lo : lo === null ? g.mtimeMin : Math.max(g.mtimeMin, lo)
      g.mtimeMax = g.mtimeMax === null ? hi : hi === null ? g.mtimeMax : Math.min(g.mtimeMax, hi)
      return
    }
    g.mtimeMin = g.mtimeMin === null || lo === null ? null : Math.min(g.mtimeMin, lo)
    g.mtimeMax = g.mtimeMax === null || hi === null ? null : Math.max(g.mtimeMax, hi)
  }
  const peek = (): string | undefined => (pos < tokens.length ? tokens[pos] : undefined)
  const advance = (): string | undefined => {
    const t = peek()
    if (t !== undefined) pos += 1
    return t
  }
  // Refuse an operator the line left without a right-hand side. GNU words
  // the empty slot two ways and both name the operator, which is why this
  // runs where the operator was just consumed rather than in primary(): by
  // the time the recursion reaches a primary the token that needed an
  // operand is gone.
  const afterOperator = (op: string): void => {
    const tok = peek()
    if (tok === undefined) throw new FindParseError(`find: expected an expression after '${op}'`)
    if (tok === ')')
      throw new FindParseError(`find: expected an expression between '${op}' and ')'`)
  }

  // The words after `-exec` up to `;` or a `{} +`. GNU's rules, in GNU's
  // words: no terminator is a missing argument, a `+` counts as the
  // terminator only right after a word holding `{}`, and the batched form
  // allows exactly one `{}` and only by itself.
  function parseExec(): ExecAction {
    const argv: string[] = []
    let batch = false
    for (;;) {
      const tok = advance()
      if (tok === undefined) throw new FindParseError("find: missing argument to `-exec'")
      if (tok === EXEC_END) break
      if (
        tok === EXEC_BATCH_END &&
        argv.length > 0 &&
        (argv.at(-1) ?? '').includes(EXEC_PLACEHOLDER)
      ) {
        batch = true
        break
      }
      argv.push(tok)
    }
    if (argv.length === 0) throw new FindParseError("find: missing argument to `-exec'")
    if (batch) {
      for (const word of argv) {
        if (word.includes(EXEC_PLACEHOLDER) && word !== EXEC_PLACEHOLDER) {
          throw new FindParseError(
            `find: In '-exec ... {} +' the '{}' must appear by itself, but you specified '${word}'`,
          )
        }
      }
      if (argv.filter((w) => w === EXEC_PLACEHOLDER).length > 1) {
        throw new FindParseError('find: Only one instance of {} is supported with -exec ... +')
      }
    }
    if (nested > 0 || inOr) {
      // The executor runs the action on the matches the tree produced,
      // which is an AND with every test; under `-o`, `!` or parentheses
      // GNU would run it per position, and silently running it on the
      // wrong set is worse than refusing.
      throw new FindParseError(EXEC_PLACEMENT)
    }
    return { kind: 'exec', argv, batch }
  }

  function primary(): PredNode {
    const tok = advance()
    if (tok === undefined) throw new FindParseError('find: expected predicate')
    if (
      (g.actions.length > 0 || g.printf !== null) &&
      (tok === '-empty' ||
        (FIND_VALUE_PREDICATES.has(tok) && !['-printf', '-maxdepth', '-mindepth'].includes(tok)))
    ) {
      throw new FindParseError(`find: ${tok}: tests after actions are not supported`)
    }
    if (FIND_VALUE_PREDICATES.has(tok)) {
      const value = advance()
      if (value === undefined) throw new FindParseError(`find: missing argument to '${tok}'`)
      if (tok === '-name') return { op: 'name', pattern: value, icase: false }
      if (tok === '-iname') return { op: 'name', pattern: value, icase: true }
      if (tok === '-path') return { op: 'path', pattern: value }
      if (tok === '-type') return typeNode(value)
      if (tok === '-printf') {
        if (g.printf !== null) {
          throw new FindParseError('find: multiple -printf actions are not supported')
        }
        checkActionPlacement(tok)
        // An action, not a test: it always matches, replaces the default
        // -print rendering, and one format applies to every row (GNU
        // evaluates actions per expression position, which the flat
        // window cannot express; a single trailing -printf, the way
        // agents write it, renders identically).
        g.printf = value
        return { op: 'true' }
      }
      if (tok === '-maxdepth') {
        g.maxDepth = parseDepth(value, '-maxdepth')
        return { op: 'true' }
      }
      if (tok === '-mindepth') {
        g.minDepth = parseDepth(value, '-mindepth')
        return { op: 'true' }
      }
      if (tok === '-size') {
        ;[g.minSize, g.maxSize] = parseSize(value)
        return { op: 'true' }
      }
      if (tok === '-newer' || tok === '-newermt') {
        checkActionPlacement(tok)
        newerToken = tok
      }
      if (tok === '-newer') {
        // Resolved by the executor (`find_refs.ts`) into -newermt, since
        // only the dispatcher can stat the reference.
        g.newer.push(value)
        return { op: 'true' }
      }
      if (tok === '-newermt') {
        mergeWindow(strictlyAfter(parseNewermt(value)), null)
        return { op: 'true' }
      }
      const [mtLo, mtHi] = parseMtime(value)
      mergeWindow(mtLo, mtHi)
      return { op: 'true' }
    }
    if (FIND_EXEC_PREDICATES.has(tok)) {
      g.actions.push(parseExec())
      return { op: 'true' }
    }
    if (tok === '-empty') {
      g.usesEmpty = true
      return { op: 'empty' }
    }
    const rowKind = FIND_ROW_ACTIONS.get(tok)
    if (rowKind !== undefined) {
      checkActionPlacement(tok)
      g.actions.push({ kind: rowKind })
      if (rowKind === 'delete') g.depthFirst = true
      return { op: 'true' }
    }
    if (tok === '-depth') {
      g.depthFirst = true
      return { op: 'true' }
    }
    if (FIND_BARE_PREDICATES.has(tok)) return { op: 'true' }
    throw new FindParseError(`find: unknown predicate '${tok}'`)
  }

  function factor(): PredNode {
    depth += 1
    if (depth > FIND_MAX_DEPTH) throw new FindParseError('find: expression too deeply nested')
    try {
      const tok = peek()
      if (tok === '-not' || tok === '!') {
        advance()
        afterOperator(tok)
        nested += 1
        try {
          return { op: 'not', kid: factor() }
        } finally {
          nested -= 1
        }
      }
      if (tok === '(') {
        advance()
        nested += 1
        let node: PredNode
        try {
          node = orExpr()
        } finally {
          nested -= 1
        }
        if (peek() !== ')') throw new FindParseError('find: unbalanced parentheses')
        advance()
        return node
      }
      return primary()
    } finally {
      depth -= 1
    }
  }

  function andExpr(): PredNode {
    const factors = [factor()]
    for (;;) {
      const tok = peek()
      if (tok === '-a' || tok === '-and') {
        advance()
        afterOperator(tok)
        factors.push(factor())
        continue
      }
      if (tok === undefined || tok === '-o' || tok === '-or' || tok === ')') break
      factors.push(factor())
    }
    const [firstFactor, ...restFactors] = factors
    if (firstFactor === undefined) return { op: 'true' }
    return restFactors.length === 0 ? firstFactor : { op: 'and', kids: factors }
  }

  function orExpr(): PredNode {
    const terms = [andExpr()]
    for (;;) {
      const tok = peek()
      if (tok !== '-o' && tok !== '-or') break
      advance()
      afterOperator(tok)
      if (nested === 0) {
        inOr = true
        if (newerToken !== null) checkActionPlacement(newerToken)
        // An action already parsed sits on the left of this `-o`, which
        // is the same detachment from the tree seen from the other side:
        // `-exec false {} ; -o -print` would run the action and then
        // print nothing.
        if (execActions(g.actions).length > 0) throw new FindParseError(EXEC_PLACEMENT)
        const action = g.actions[0]
        if (action !== undefined) checkActionPlacement(`-${action.kind}`)
        if (g.printf !== null) checkActionPlacement('-printf')
      }
      terms.push(andExpr())
    }
    const [firstTerm, ...restTerms] = terms
    if (firstTerm === undefined) return { op: 'true' }
    return restTerms.length === 0 ? firstTerm : { op: 'or', kids: terms }
  }

  if (tokens.length === 0) return { tree: { op: 'true' }, ...g }
  const tree = orExpr()
  const trailing = peek()
  if (trailing !== undefined) throw new FindParseError(`find: unexpected token '${trailing}'`)
  if (execActions(g.actions).length > 0 && g.printf !== null) {
    // -printf rows are rendered by the backend's generic before the
    // executor sees them, so there is no path left to hand -exec.
    throw new FindParseError('find: -exec cannot be combined with -printf')
  }
  if (g.actions.length > 0 && g.printf !== null) {
    throw new FindParseError('find: -printf cannot be combined with other actions')
  }
  return { tree, ...g }
}
