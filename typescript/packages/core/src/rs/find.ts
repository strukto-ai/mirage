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

import type { FindAction, PrintfPart } from '../commands/builtin/types.ts'
import { UsageError } from '../commands/errors.ts'
import type { ActionKind, PredNode, RowActionKind } from '../core/generic/types.ts'
import { textView, utf8Locale } from '../shell/bytes.ts'
import type { JsonValue } from '../types.ts'
import { systemNow } from '../utils/clock.ts'
import { parseDateExpr } from '../utils/dates.ts'
import { LOCAL_ZONE, UTC_ZONE, zoneFromEnv, type Zone } from '../utils/timezone.ts'
import { scanned } from './scan.ts'

export const OPERAND = ''
export const DAY = 86400
export const MINUTE = 60

type Bounds = readonly [number | null, number | null]
type Obj = Readonly<Record<string, JsonValue>>

/**
 * One parsed find expression: the predicate tree plus everything the flat
 * window lifts out of it. The tests a backend can answer per entry stay in
 * `tree`; the windows (depth, size, mtime) and the actions are global to
 * the expression, because a native find op evaluates the tree and the
 * executor applies the actions to what came back. A time test also sits in
 * the tree as an `mtime` node: only one in the top-level `-a` chain narrows
 * the time window, and the tree decides the rest per entry, as it decides
 * where a `-prune` after one fires. `newer` holds `-newer` reference
 * operands as typed, which the executor resolves against the dispatcher
 * before it binds the expression. `actions` are in the order written, since
 * GNU runs actions per position; `depthFirst` is GNU's `-depth`, which
 * `-delete` turns on; `follow` is `-follow`, which follows links as `-L`
 * does; `files0From` is `-files0-from`'s file as typed, which names the
 * start points in place of the operands; `files` every file `-fprint`,
 * `-fprint0` and `-fprintf` write, each once, in the order first named;
 * `predicates` is every predicate word typed, in order; `warnings` the
 * lines the reference prints while it parses; `start` where the expression begins
 * among the words typed. Mirrors Python's `FindExpr`.
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
  follow?: boolean
  files0From?: string | null
  files?: string[]
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
  if (value === 'Infinity' || value === '-Infinity') return Number(value)
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

function optText(value: JsonValue | undefined): string | null {
  return value === null || value === undefined ? null : textView(str(value))
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

/**
 * One `-mtime` as inclusive epoch-second bounds: `cmp` is `+`, `-` or `=`.
 * GNU drops the fraction of a file's age in days before comparing, so `+N`
 * matches only files at least N+1 whole days old.
 */
export function mtimeBounds(cmp: string, days: number, now: number): Bounds {
  if (cmp === '+') return [null, now - (days + 1) * DAY]
  if (cmp === '-') return [now - days * DAY, null]
  return [now - (days + 1) * DAY, now - days * DAY]
}

// The double just below `timestamp`, `strictlyAfter`'s other side.
function before(timestamp: number): number {
  if (!Number.isFinite(timestamp)) {
    return timestamp > 0 ? Number.MAX_VALUE : timestamp
  }
  if (timestamp === 0) return -Number.MIN_VALUE
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, timestamp)
  const bits = view.getBigUint64(0)
  view.setBigUint64(0, timestamp > 0 ? bits - 1n : bits + 1n)
  return view.getFloat64(0)
}

/**
 * One age test (`-mtime`, `-amin`...) as inclusive epoch-second bounds. A
 * day count drops the fraction of the age (`mtimeBounds`); a minute count
 * rounds it up, measured on findutils 4.10: `-mmin N` holds for an age
 * above N-1 minutes and at most N, `+N` for one above N and `-N` for one
 * below.
 */
export function ageBounds(cmp: string, amount: number, minutes: boolean, origin: number): Bounds {
  if (!minutes) return mtimeBounds(cmp, amount, origin)
  const edge = origin - amount * MINUTE
  if (cmp === '+') return [null, before(edge)]
  if (cmp === '-') return [strictlyAfter(edge), null]
  return [edge, before(edge + MINUTE)]
}

/**
 * `-daystart`'s origin: the midnight that ends today in `zone`, the
 * session's `TZ`, or in the host's local zone when null.
 */
export function nextMidnight(now: number, zone: Zone | null): number {
  const here = zone ?? LOCAL_ZONE
  const today = here.parts(new Date(now * 1000))
  const midnight = here.fromWall({
    year: today.year,
    month: today.month,
    day: today.day + 1,
    hour: 0,
    minute: 0,
    second: 0,
    ms: 0,
  })
  return midnight.getTime() / 1000
}

// Intersect one top-level time test with the expression's window. Every test
// in the top-level `-a` chain must hold, so the windows intersect: `-newer old
// -newer new` keeps only what is newer than both, and `-mtime +2 -mtime -1`
// keeps nothing, as GNU answers. A test under `-o` or `!` need not hold for a
// match, so it never reaches here; its `mtime` node decides it per entry.
function merge(window: Bounds | null, bounds: Bounds): Bounds {
  if (window === null) return bounds
  const [oldLo, oldHi] = window
  const [lo, hi] = bounds
  return [
    oldLo === null ? lo : lo === null ? oldLo : Math.max(oldLo, lo),
    oldHi === null ? hi : hi === null ? oldHi : Math.min(oldHi, hi),
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
      ...(flag(raw.dir) ? { inDir: true } : {}),
    }
  }
  const file = optText(raw.file)
  const target = file === null ? {} : { file }
  if (kind === 'printf') {
    const parts: PrintfPart[] = array(raw.parts).map((item) => {
      const part = object(item)
      if ('lit' in part) return { lit: textView(str(part.lit)) }
      if ('dir' in part) return { dir: str(part.dir) }
      return { time: str(part.time) }
    })
    return {
      kind: 'printf',
      format: textView(str(raw.format)),
      parts,
      stat: flag(raw.stat),
      ...target,
    }
  }
  return { kind: rowKind(kind), ...target }
}

interface Binding {
  readonly refs: readonly number[]
  readonly now: number
  readonly zone: Zone | null
  readonly utf8: boolean
  readonly profile: string | null
  window: Bounds | null
}

function permBits(bits: string): 'exact' | 'all' | 'any' {
  if (bits === 'exact' || bits === 'all' || bits === 'any') return bits
  throw new TypeError(`find: mirage-rs answered the -perm kind ${JSON.stringify(bits)}`)
}

function countField(name: string): 'links' | 'uid' | 'gid' {
  if (name === 'links' || name === 'uid' || name === 'gid') return name
  throw new TypeError(`find: mirage-rs answered the count ${JSON.stringify(name)}`)
}

function cmp(sign: string): '+' | '-' | '=' {
  if (sign === '+' || sign === '-' || sign === '=') return sign
  throw new TypeError(`find: mirage-rs answered the comparison ${JSON.stringify(sign)}`)
}

function accessMode(mode: string): 'r' | 'w' | 'x' {
  if (mode === 'r' || mode === 'w' || mode === 'x') return mode
  throw new TypeError(`find: mirage-rs answered the access ${JSON.stringify(mode)}`)
}

function stamp(field: string): 'm' | 'a' | 'c' {
  if (field === 'm' || field === 'a' || field === 'c') return field
  throw new TypeError(`find: mirage-rs answered the stamp ${JSON.stringify(field)}`)
}

function dialect(name: string): 'emacs' | 'posix' {
  if (name === 'emacs' || name === 'posix') return name
  throw new TypeError(`find: mirage-rs answered the dialect ${JSON.stringify(name)}`)
}

function node(raw: Obj, binding: Binding, top = true): PredNode {
  const op = str(raw.op)
  switch (op) {
    case 'name':
      return { op: 'name', pattern: textView(str(raw.pattern)), icase: flag(raw.icase) }
    case 'path':
      return flag(raw.icase)
        ? { op: 'path', pattern: textView(str(raw.pattern)), icase: true }
        : { op: 'path', pattern: textView(str(raw.pattern)) }
    case 'regex':
      return {
        op: 'regex',
        pattern: textView(str(raw.pattern)),
        icase: flag(raw.icase),
        dialect: dialect(str(raw.dialect)),
        extended: flag(raw.extended),
        utf8: binding.utf8,
        hits: new Map(),
      }
    case 'lname':
      return { op: 'lname', pattern: textView(str(raw.pattern)), icase: flag(raw.icase) }
    case 'type':
      return { op: 'type', kind: str(raw.kind) }
    case 'xtype':
      return { op: 'xtype', kind: str(raw.kind) }
    case 'perm':
      return {
        op: 'perm',
        mode: int(raw.mode),
        bits: permBits(str(raw.bits)),
      }
    case 'count':
      return {
        op: 'count',
        field: countField(str(raw.field)),
        cmp: cmp(str(raw.cmp)),
        count: int(raw.count),
      }
    case 'owner':
      return {
        op: 'owner',
        name: textView(str(raw.name)),
        group: flag(raw.group),
        profile: binding.profile,
      }
    case 'nouser':
      return { op: 'nouser', group: flag(raw.group) }
    case 'access':
      return { op: 'access', mode: accessMode(str(raw.mode)) }
    case 'empty':
      return { op: 'empty' }
    case 'true':
      return { op: 'true' }
    case 'prune':
      return { op: 'prune', pruned: [], pending: [] }
    case 'quit':
      return { op: 'quit', fired: [] }
    case 'not':
      return { op: 'not', kid: node(object(raw.kid), binding, false) }
    // Only a test every match must pass is in the top-level -a chain.
    case 'and':
      return { op: 'and', kids: array(raw.kids).map((kid) => node(object(kid), binding, top)) }
    case 'or':
      return { op: 'or', kids: array(raw.kids).map((kid) => node(object(kid), binding, false)) }
    case 'action': {
      const kind = actionKind(str(raw.kind))
      return flag(raw.batch) ? { op: 'action', kind, batch: true } : { op: 'action', kind }
    }
    default:
      return timeNode(op, raw, binding, top)
  }
}

function timeNode(op: string, raw: Obj, binding: Binding, top: boolean): PredNode {
  let bounds: Bounds
  let field: 'm' | 'a' | 'c' = 'm'
  if (op === 'age') {
    field = stamp(str(raw.field))
    const origin = flag(raw.daystart) ? nextMidnight(binding.now, binding.zone) : binding.now
    bounds = ageBounds(str(raw.cmp), float(raw.amount), flag(raw.minutes), origin)
  } else if (op === 'newermt') {
    bounds = [strictlyAfter(parseNewermt(textView(str(raw.date)))), null]
  } else {
    const ref = binding.refs[int(raw.index)]
    if (ref === undefined) return { op: 'true' }
    bounds = [strictlyAfter(ref), null]
  }
  // The flat window is the modification time's alone.
  if (top && field === 'm') binding.window = merge(binding.window, bounds)
  return field === 'm'
    ? { op: 'mtime', lo: bounds[0], hi: bounds[1] }
    : { op: 'mtime', lo: bounds[0], hi: bounds[1], field }
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
   * The first `-newermt` text that is no date, in expression order, with
   * how many `-newer` references precede it; null when every date reads.
   * GNU reads `-newer` and `-newermt` left to right, so the references
   * typed before that date are statted first and their error, if any, is
   * the one reported.
   */
  dateRefusal(): [number, UsageError] | null {
    for (const entry of array(this.values.dates)) {
      const [date, before] = array(entry)
      try {
        parseNewermt(textView(str(date)))
      } catch (err) {
        if (err instanceof UsageError) return [int(before), err]
        throw err
      }
    }
    return null
  }

  /**
   * The expression with its time tests resolved. `newerTimes` is each
   * `-newer` reference's mtime in epoch seconds, in order; empty leaves
   * every `-newer` a test that always holds, as one the executor could not
   * resolve. `now` is the clock `-mtime` counts from, the current time by
   * default. `env` is the command's environment, whose `TZ` places
   * `-daystart`'s midnight and whose locale reads a `-regex` subject;
   * `profile` the session's name, the owner `-user` sees on an entry that
   * reports none. Throws UsageError for a `-newermt` text that is no date.
   */
  bind(
    newerTimes: readonly number[] = [],
    now: number = systemNow(),
    env: Readonly<Record<string, string>> | null = null,
    profile: string | null = null,
  ): FindExpr {
    const binding: Binding = {
      refs: newerTimes,
      now,
      zone: zoneFromEnv(env),
      utf8: utf8Locale(env ?? undefined),
      profile,
      window: null,
    }
    const tree = node(object(this.values.tree), binding)
    const [mtimeMin, mtimeMax] = binding.window ?? [null, null]
    const actions = array(this.values.actions).map((a) => action(object(a)))
    const named = actions.flatMap((a) =>
      a.kind !== 'exec' && a.file !== undefined && a.file !== null ? [a.file] : [],
    )
    return {
      tree,
      maxDepth: optInt(this.values.maxdepth),
      minDepth: optInt(this.values.mindepth),
      minSize: optBound(this.values.min_size),
      maxSize: optBound(this.values.max_size),
      mtimeMin,
      mtimeMax,
      usesEmpty: flag(this.values.uses_empty),
      actions,
      newer: this.newer,
      depthFirst: flag(this.values.depth_first),
      follow: flag(this.values.follow),
      files0From: optText(this.values.files0_from),
      files: [...new Set(named)],
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
