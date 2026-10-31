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

import { UsageError } from '../commands/errors.ts'
import type { FindAction, PrintfPart } from '../commands/builtin/types.ts'
import type { ActionKind, PredNode, RowActionKind } from '../core/generic/find_eval.ts'
import { textView } from '../shell/bytes.ts'
import type { JsonValue } from '../types.ts'
import { parseDateExpr } from '../utils/dates.ts'
import { UTC_ZONE } from '../utils/timezone.ts'
import { scanned } from './scan.ts'

export const OPERAND = ''
export const DAY = 86400

type Bounds = readonly [number | null, number | null]
type Obj = Readonly<Record<string, JsonValue>>

/**
 * One parsed find expression: the predicate tree plus everything the flat
 * window lifts out of it. The tests a backend can answer per entry stay in
 * `tree`; the windows (depth, size, mtime) and the actions are global to
 * the expression, because a native find op evaluates the tree and the
 * executor applies the actions to what came back. A time test also sits in
 * the tree as an `mtime` node, for its position alone: a `-prune` after it
 * fires only where the test holds. `newer` holds `-newer` reference
 * operands as typed, which the executor resolves against the dispatcher
 * before it binds the expression. `actions` are in the order written, since
 * GNU runs actions per position; `depthFirst` is GNU's `-depth`, which
 * `-delete` turns on; `predicates` is every predicate word typed, in order;
 * `warnings` the lines GNU prints while it parses; `start` where the
 * expression begins among the words typed. Mirrors Python's `FindExpr`.
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
  actions: FindAction[]
  newer: string[]
  depthFirst: boolean
  predicates: string[]
  warnings: string[]
  start: number
}

/** Where find's expression begins among the words typed, and which words an `-exec` owns. */
export interface FindLayout {
  readonly start: number
  readonly spans: readonly (readonly [number, number])[]
}

function object(value: JsonValue | undefined): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`find: mirage-rs answered ${JSON.stringify(value)}, not an object`)
  }
  return value as Obj
}

function array(value: JsonValue | undefined): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`find: mirage-rs answered ${JSON.stringify(value)}, not a list`)
  }
  return value as readonly JsonValue[]
}

function str(value: JsonValue | undefined): string {
  if (typeof value !== 'string') {
    throw new TypeError(`find: mirage-rs answered ${JSON.stringify(value)}, not text`)
  }
  return value
}

function int(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`find: mirage-rs answered ${JSON.stringify(value)}, not a count`)
  }
  return value
}

function float(value: JsonValue | undefined): number {
  if (typeof value !== 'number') {
    throw new TypeError(`find: mirage-rs answered ${JSON.stringify(value)}, not a number`)
  }
  return value
}

function flag(value: JsonValue | undefined): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`find: mirage-rs answered ${JSON.stringify(value)}, not a flag`)
  }
  return value
}

function optInt(value: JsonValue | undefined): number | null {
  return value === null || value === undefined ? null : int(value)
}

function optBound(value: JsonValue | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new TypeError(`find: mirage-rs answered ${JSON.stringify(value)}, not a bound`)
  }
  return Number(value)
}

function words(argv: readonly string[]): [string, string][] {
  return argv.map((word) => [OPERAND, word])
}

/**
 * Where the expression begins in the words typed after `find`, and which
 * words an `-exec` owns, read by mirage-rs without parsing the expression,
 * so a line that will be refused still classifies. Mirrors Python's
 * `find_layout`.
 */
export function findLayout(argv: readonly string[]): FindLayout {
  const values = scanned('find_layout', words(argv))
  return {
    start: int(values.start),
    spans: array(values.spans).map((span) => {
      const [from, to] = array(span)
      return [int(from), int(to)] as const
    }),
  }
}

/**
 * The inclusive lower bound that means "later than `timestamp`". `-newer`
 * and `-newermt` are strict (GNU: modified *more recently than*), and the
 * window is inclusive, so the bound is the next representable float: exact,
 * where adding an epsilon would either miss a timestamp or admit the
 * reference itself.
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
  const ts = parseDateExpr(value, UTC_ZONE)
  if (ts === null || !Number.isFinite(ts.getTime()) || value.trim() === '@') {
    throw new UsageError(
      `find: I cannot figure out how to interpret '${value}' as a date or time`,
      1,
    )
  }
  return ts.getTime() / 1000
}

/** One `-mtime` as inclusive epoch-second bounds: `cmp` is `+`, `-` or `=`. */
export function mtimeBounds(cmp: string, days: number, now: number): Bounds {
  if (cmp === '+') return [null, now - days * DAY]
  if (cmp === '-') return [now - days * DAY, null]
  return [now - (days + 1) * DAY, now - days * DAY]
}

// Fold one time test into the expression's single window. The flat window
// cannot evaluate a time test per predicate node, so repeated ones fold by
// where they sit. In the top-level `-a` chain every test must hold, so the
// windows intersect: `-newer old -newer new` keeps only what is newer than
// both, and `-mtime +2 -mtime -1` keeps nothing, as GNU answers. Under
// `-o`, `!` or parentheses the window cannot be exact, so they widen to the
// union: the tautology `-mtime +0 -o -mtime -1` imposes no bounds instead
// of last-wins dropping everything (documented divergence from GNU: such a
// window over-matches).
function merge(window: Bounds | null, bounds: Bounds, fold: string): Bounds {
  if (window === null) return bounds
  const [oldLo, oldHi] = window
  const [lo, hi] = bounds
  if (fold === 'all') {
    return [
      oldLo === null ? lo : lo === null ? oldLo : Math.max(oldLo, lo),
      oldHi === null ? hi : hi === null ? oldHi : Math.min(oldHi, hi),
    ]
  }
  return [
    oldLo === null || lo === null ? null : Math.min(oldLo, lo),
    oldHi === null || hi === null ? null : Math.max(oldHi, hi),
  ]
}

function rowKind(kind: string): RowActionKind {
  if (kind === 'print' || kind === 'print0' || kind === 'ls' || kind === 'delete') return kind
  throw new TypeError(`find: mirage-rs answered the action ${JSON.stringify(kind)}`)
}

function actionKind(kind: string): ActionKind {
  if (kind === 'exec' || kind === 'printf') return kind
  return rowKind(kind)
}

function action(raw: Obj): FindAction {
  const kind = str(raw.kind)
  if (kind === 'exec') {
    return {
      kind: 'exec',
      argv: array(raw.argv).map((w) => textView(str(w))),
      batch: flag(raw.batch),
    }
  }
  if (kind === 'printf') {
    const parts: PrintfPart[] = array(raw.parts).map((item) => {
      const part = object(item)
      if ('lit' in part) return { lit: textView(str(part.lit)) }
      if ('dir' in part) return { dir: str(part.dir) }
      return { time: str(part.time) }
    })
    return { kind: 'printf', format: textView(str(raw.format)), parts, stat: flag(raw.stat) }
  }
  return { kind: rowKind(kind) }
}

interface Binding {
  readonly refs: readonly number[]
  readonly now: number
  window: Bounds | null
}

function node(raw: Obj, binding: Binding): PredNode {
  const op = str(raw.op)
  switch (op) {
    case 'name':
      return { op: 'name', pattern: textView(str(raw.pattern)), icase: flag(raw.icase) }
    case 'path':
      return { op: 'path', pattern: textView(str(raw.pattern)) }
    case 'type':
      return { op: 'type', kind: str(raw.kind) }
    case 'empty':
      return { op: 'empty' }
    case 'true':
      return { op: 'true' }
    case 'prune':
      return { op: 'prune', pruned: [], pending: [] }
    case 'not':
      return { op: 'not', kid: node(object(raw.kid), binding) }
    case 'and':
      return { op: 'and', kids: array(raw.kids).map((kid) => node(object(kid), binding)) }
    case 'or':
      return { op: 'or', kids: array(raw.kids).map((kid) => node(object(kid), binding)) }
    case 'action': {
      const kind = actionKind(str(raw.kind))
      return flag(raw.batch) ? { op: 'action', kind, batch: true } : { op: 'action', kind }
    }
    default:
      return timeNode(op, raw, binding)
  }
}

function timeNode(op: string, raw: Obj, binding: Binding): PredNode {
  const fold = str(raw.fold)
  let bounds: Bounds
  if (op === 'mtime') {
    bounds = mtimeBounds(str(raw.cmp), float(raw.days), binding.now)
  } else if (op === 'newermt') {
    bounds = [strictlyAfter(parseNewermt(textView(str(raw.date)))), null]
  } else {
    const ref = binding.refs[int(raw.index)]
    if (ref === undefined) return { op: 'true' }
    bounds = [strictlyAfter(ref), null]
  }
  binding.window = merge(binding.window, bounds, fold)
  return { op: 'mtime', lo: bounds[0], hi: bounds[1] }
}

/**
 * What mirage-rs read of a find line, before any time test is resolved.
 * Mirrors Python's `FindParse`.
 */
export class FindParse {
  readonly values: Obj

  constructor(values: Obj) {
    this.values = values
  }

  /** Where the expression begins among the words typed. */
  get start(): number {
    return int(this.values.start)
  }

  /** The `-newer` references, as typed, in expression order. */
  get newer(): string[] {
    return array(this.values.newer).map((ref) => textView(str(ref)))
  }

  /**
   * The expression with its time tests resolved. `newerTimes` is each
   * `-newer` reference's mtime in epoch seconds, in order; empty leaves
   * every `-newer` a test that always holds, as one the executor could not
   * resolve. `now` is the clock `-mtime` counts from, the current time by
   * default. Throws UsageError for a `-newermt` text that is no date.
   */
  bind(newerTimes: readonly number[] = [], now: number = Date.now() / 1000): FindExpr {
    const binding: Binding = { refs: newerTimes, now, window: null }
    const tree = node(object(this.values.tree), binding)
    const [mtimeMin, mtimeMax] = binding.window ?? [null, null]
    return {
      tree,
      maxDepth: optInt(this.values.maxdepth),
      minDepth: optInt(this.values.mindepth),
      minSize: optBound(this.values.min_size),
      maxSize: optBound(this.values.max_size),
      mtimeMin,
      mtimeMax,
      usesEmpty: flag(this.values.uses_empty),
      actions: array(this.values.actions).map((a) => action(object(a))),
      newer: this.newer,
      depthFirst: flag(this.values.depth_first),
      predicates: array(this.values.predicates).map((w) => textView(str(w))),
      warnings: array(this.values.warnings).map((w) => textView(str(w))),
      start: this.start,
    }
  }
}

/**
 * find's words read once by mirage-rs: the start points end where the
 * expression begins, and the expression becomes a tree. Throws UsageError
 * for the first word the grammar refuses, in GNU's words and with its exit
 * status. Mirrors Python's `parse_find`.
 */
export function parseFind(argv: readonly string[]): FindParse {
  return new FindParse(scanned('find', words(argv)))
}

/** `parseFind` and `bind` with no reference resolved, for a caller holding only the words. */
export function parseFindExpression(argv: readonly string[]): FindExpr {
  return parseFind(argv).bind()
}
