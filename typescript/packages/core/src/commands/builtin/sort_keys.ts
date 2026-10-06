import { compareCodePoints } from '../../utils/sort.ts'
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

import { quoteText } from '../quote.ts'
import { SortKeyError } from './errors.ts'
import { STRTOD, strtodDouble } from './utils/strtod.ts'

// sort.c's `unit_order`: the suffixes -h ranks, lowercase only for k.
const UNIT_ORDERS: Record<string, number> = {
  K: 1,
  k: 1,
  M: 2,
  G: 3,
  T: 4,
  P: 5,
  E: 6,
  Z: 7,
  Y: 8,
  R: 9,
  Q: 10,
}

// sort.c's `blanks`: isblank() in the C locale plus the newline a -z
// record can hold. They separate fields, and -b, -n, -h and -M skip them.
const FIELD_BLANKS = ' \t\n'
// strnumcmp's number in the C locale: no `+`, exponent or thousands
// separator. find_unit_order reads the byte after the digits and points.
const NUMBER_RE = /^[ \t\n]*(-?)([0-9]*)(?:\.([0-9]*))?/
const UNIT_RE = /^[ \t\n]*(-?)([0-9.]*)(.?)/

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

const VERSION_RE = /(\d+)|(\D+)/g
// The letters sort.c's `set_ordering` takes after a KEYDEF position. R is
// recognized, so it still keeps a key off the global options and counts
// against the others it is incompatible with, but it does not shuffle.
const ORDER_LETTERS = 'bdfghiMnRrV'
// What strtoumax skips before a number, isspace() in the C locale.
const BLANKS = ' \t\n\v\f\r'

export interface KeyMods {
  numeric: boolean
  generalNumeric?: boolean
  human: boolean
  version: boolean
  month: boolean
  fold: boolean
  reverse: boolean
  dictionary?: boolean
  ignoreNonprinting?: boolean
  random?: boolean
}

export interface Key {
  startField: number
  startChar: number
  startSkip: boolean
  endField: number | null
  endChar: number | null
  endSkip: boolean
  mods: KeyMods
}

export interface SortConfig {
  keys: Key[]
  fieldSep: string | null
  reverse: boolean
  unique: boolean
  stable: boolean
}

/** A decimal with no leading or trailing zeroes; zero is never negative. */
interface NumericKey {
  readonly negative: boolean
  readonly integer: string
  readonly fraction: string
}

type SortKey = NumericKey | string | number | (NumericKey | string | number)[]

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9'
}

// sort.c's `parse_field_count`: the decimal starting at `pos`, with the
// index just past it. strtoumax's reading, so leading blanks and a `+` are
// taken and the number ends at the first byte that is not an ASCII digit,
// which the caller reads on from. A `-`, or no digit at all, is refused
// with the text from `pos` on. Mirrors _field_count in sort_keys.py.
function fieldCount(spec: string, pos: number, what: string): [number, number] {
  let end = pos
  while (end < spec.length && BLANKS.includes(spec.charAt(end))) end += 1
  if (spec.charAt(end) === '+') end += 1
  const digits = end
  while (end < spec.length && isAsciiDigit(spec.charAt(end))) end += 1
  if (end === digits) {
    throw new SortKeyError(`${what}: invalid count at start of '${quoteText(spec.slice(pos))}'`)
  }
  return [Number.parseInt(spec.slice(digits, end), 10), end]
}

function badFieldSpec(spec: string, why: string): SortKeyError {
  return new SortKeyError(`${why}: invalid field specification '${quoteText(spec)}'`)
}

function ordering(spec: string, pos: number): [string, number] {
  let end = pos
  while (end < spec.length && ORDER_LETTERS.includes(spec.charAt(end))) end += 1
  return [spec.slice(pos, end), end]
}

function modsFromLetters(letters: string): KeyMods {
  return {
    numeric: letters.includes('n'),
    generalNumeric: letters.includes('g'),
    human: letters.includes('h'),
    version: letters.includes('V'),
    month: letters.includes('M'),
    fold: letters.includes('f'),
    reverse: letters.includes('r'),
    dictionary: letters.includes('d'),
    ignoreNonprinting: letters.includes('i'),
    random: letters.includes('R'),
  }
}

// One `-k` KEYDEF, read and refused the way sort.c's option loop does:
// F[.C][OPTS][,F[.C][OPTS]], taken left to right. Each number is checked
// as it is read, so `-k0.x` names the zero field and not the bad offset,
// and ordering letters run until the first byte that is not one, where
// anything left over is a stray character. A start offset of zero is
// refused and an end offset of zero means the end of its field. A key
// that carries any letter of its own, `b` included, takes none of the
// global options. Mirrors parse_keydef in sort_keys.py.
export function parseKeydef(spec: string, globalMods: KeyMods, globalSkip: boolean): Key {
  const [startField, afterField] = fieldCount(spec, 0, 'invalid number at field start')
  if (startField === 0) throw badFieldSpec(spec, 'field number is zero')
  let pos = afterField
  let startChar = 1
  if (spec.charAt(pos) === '.') {
    ;[startChar, pos] = fieldCount(spec, pos + 1, "invalid number after '.'")
    if (startChar === 0) throw badFieldSpec(spec, 'character offset is zero')
  }
  const [startLetters, afterStart] = ordering(spec, pos)
  pos = afterStart
  let endField: number | null = null
  let endChar: number | null = null
  let endLetters = ''
  if (spec.charAt(pos) === ',') {
    ;[endField, pos] = fieldCount(spec, pos + 1, "invalid number after ','")
    if (endField === 0) throw badFieldSpec(spec, 'field number is zero')
    if (spec.charAt(pos) === '.') {
      ;[endChar, pos] = fieldCount(spec, pos + 1, "invalid number after '.'")
    }
    ;[endLetters, pos] = ordering(spec, pos)
  }
  if (pos < spec.length) throw badFieldSpec(spec, 'stray character in field spec')
  let mods: KeyMods
  let startSkip: boolean
  let endSkip: boolean
  if (startLetters !== '' || endLetters !== '') {
    mods = modsFromLetters(startLetters + endLetters)
    startSkip = startLetters.includes('b')
    endSkip = endLetters.includes('b')
  } else {
    mods = globalMods
    startSkip = globalSkip
    endSkip = globalSkip
  }
  return {
    startField,
    startChar,
    startSkip,
    endField,
    endChar,
    endSkip,
    mods,
  }
}

// The letters sort.c's `check_ordering_compatibility` refuses, or '' for a
// compatible key. A key orders by at most one of -n, -g, -h, -M and the
// group -V, -R, -d, -i, whose members combine with each other but with
// none of the rest. The refusal spells the key the way `key_to_opts` does,
// without -b and -r, and -d hides -i because GNU keeps only the stronger
// of the two filters. Mirrors _incompatible_letters in sort_keys.py.
function incompatibleLetters(mods: KeyMods): string {
  const dictionary = mods.dictionary === true
  const ignoreNonprinting = mods.ignoreNonprinting === true
  const random = mods.random === true
  const generalNumeric = mods.generalNumeric === true
  const textOrders = mods.version || random || dictionary || ignoreNonprinting
  const orderings = [mods.numeric, generalNumeric, mods.human, mods.month, textOrders].filter(
    Boolean,
  ).length
  if (orderings <= 1) return ''
  const spelled: [string, boolean][] = [
    ['d', dictionary],
    ['f', mods.fold],
    ['g', generalNumeric],
    ['h', mods.human],
    ['i', ignoreNonprinting && !dictionary],
    ['M', mods.month],
    ['n', mods.numeric],
    ['R', random],
    ['V', mods.version],
  ]
  return spelled
    .filter(([, given]) => given)
    .map(([letter]) => letter)
    .join('')
}

// The already-parsed global ordering options, named the way Python's
// `build_config` keyword arguments are. It takes values rather than a flag
// bag because the caller has read them through FlagView once; re-minting a
// short-letter bag here made the letters a second, undeclared flag
// vocabulary that no spec could validate.
export interface SortGlobals {
  keyDefs: readonly string[]
  fieldSep: string | null
  reverse: boolean
  numeric: boolean
  unique: boolean
  foldCase: boolean
  humanNumeric: boolean
  versionSort: boolean
  monthSort: boolean
  ignoreBlanks: boolean
  stable: boolean
  generalNumeric: boolean
  dictionary: boolean
  ignoreNonprinting: boolean
}

// The comparison sort runs, refusing a key that mixes orderings. GNU checks
// the orderings once the option loop is done, key by key in the order the
// keys were typed, so a bad KEYDEF, a second -o or a second check mode
// outranks it and it outranks -c's operand checks. The global options
// count only through the keys that inherit them, so `sort -n -g -k1,1n`
// runs; with no -k they are the one key. Mirrors build_config in
// sort_keys.py.
export function buildConfig(globals: SortGlobals): SortConfig {
  const globalMods: KeyMods = {
    numeric: globals.numeric,
    generalNumeric: globals.generalNumeric,
    human: globals.humanNumeric,
    version: globals.versionSort,
    month: globals.monthSort,
    fold: globals.foldCase,
    reverse: globals.reverse,
    dictionary: globals.dictionary,
    ignoreNonprinting: globals.ignoreNonprinting,
  }
  const ignoreBlanks = globals.ignoreBlanks
  const keyDefs = globals.keyDefs
  let keys: Key[]
  if (keyDefs.length > 0) {
    keys = keyDefs.map((spec) => parseKeydef(spec, globalMods, ignoreBlanks))
  } else {
    keys = [
      {
        startField: 1,
        startChar: 1,
        startSkip: ignoreBlanks,
        endField: null,
        endChar: null,
        endSkip: ignoreBlanks,
        mods: globalMods,
      },
    ]
  }
  for (const key of keys) {
    const letters = incompatibleLetters(key.mods)
    if (letters !== '') throw new SortKeyError(`options '-${letters}' are incompatible`)
  }
  return {
    keys,
    fieldSep: globals.fieldSep,
    reverse: globals.reverse,
    unique: globals.unique,
    stable: globals.stable,
  }
}

export function computeFields(line: string, fieldSep: string | null): [number, number, number][] {
  const fields: [number, number, number][] = []
  const n = line.length
  if (fieldSep !== null && fieldSep !== '') {
    let pos = 0
    const seplen = fieldSep.length
    for (;;) {
      const nxt = line.indexOf(fieldSep, pos)
      if (nxt === -1) {
        fields.push([pos, pos, n])
        break
      }
      fields.push([pos, pos, nxt])
      pos = nxt + seplen
    }
    return fields
  }
  let i = 0
  while (i < n) {
    const leadStart = i
    while (i < n && FIELD_BLANKS.includes(line.charAt(i))) i += 1
    const contentStart = i
    while (i < n && !FIELD_BLANKS.includes(line.charAt(i))) i += 1
    fields.push([leadStart, contentStart, i])
  }
  return fields
}

export function extract(line: string, fields: [number, number, number][], key: Key): string {
  const n = line.length
  const nf = fields.length
  if (key.startField > nf) return ''
  const startField = fields[key.startField - 1]
  if (startField === undefined) return ''
  const [leadStart, contentStart] = startField
  const base = key.startSkip ? contentStart : leadStart
  const start = Math.min(base + (key.startChar - 1), n)
  let end: number
  if (key.endField === null || key.endField > nf) {
    end = n
  } else {
    const endField = fields[key.endField - 1]
    if (endField === undefined) return ''
    const [eLead, eContent, eEnd] = endField
    if (key.endChar === null || key.endChar === 0) {
      end = eEnd
    } else {
      const eBase = key.endSkip ? eContent : eLead
      end = Math.min(eBase + key.endChar, n)
    }
  }
  return line.slice(start, Math.max(end, start))
}

function versionKey(s: string): (string | number)[] {
  const parts: (string | number)[] = []
  let m: RegExpExecArray | null
  VERSION_RE.lastIndex = 0
  while ((m = VERSION_RE.exec(s)) !== null) {
    if (m[1] !== undefined) parts.push(0, Number.parseInt(m[1], 10))
    else if (m[2] !== undefined) parts.push(1, m[2])
  }
  return parts
}

/** Read a C-locale GNU -n prefix without losing decimal precision. */
function leadingNumber(field: string): NumericKey {
  const match = NUMBER_RE.exec(field)
  const integer = (match?.[2] ?? '').replace(/^0+/, '')
  const fraction = (match?.[3] ?? '').replace(/0+$/, '')
  return { negative: match?.[1] === '-' && (integer !== '' || fraction !== ''), integer, fraction }
}

/**
 * sort.c's `human_numcompare` key: the unit's order, then the number.
 *
 * The unit is the byte after the run of digits and decimal points, so `5.K`
 * carries K. Its order is negated for a negative number and is zero for a zero
 * one, and it outranks the magnitude, so `1500` sorts before `1K`. Mirrors
 * _human_number in sort_keys.py.
 */
function humanNumber(field: string): [number, NumericKey] {
  const match = UNIT_RE.exec(field)
  const order = /[1-9]/.test(match?.[2] ?? '') ? (UNIT_ORDERS[match?.[3] ?? ''] ?? 0) : 0
  return [match?.[1] === '-' ? -order : order, leadingNumber(field)]
}

function isPrintingCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code > 31 && code !== 127
}

// The number strtold reads at the start of a field, null for none. The rest
// of the field is ignored, as GNU sort -g ignores it.
function parseGeneralFloat(field: string): number | null {
  const found = STRTOD.exec(field)
  return found === null ? null : strtodDouble(found)
}

function transform(field: string, mods: KeyMods): SortKey {
  if (mods.dictionary)
    field = Array.from(field)
      .filter((char) => /[\p{L}\p{N} \t\n]/u.test(char))
      .join('')
  else if (mods.ignoreNonprinting) {
    field = Array.from(field).filter(isPrintingCharacter).join('')
  }
  if (mods.month) {
    const name = field.replace(/^[ \t\n]+/, '').slice(0, 3)
    return MONTHS[name.toLowerCase()] ?? 0
  }
  if (mods.human) return humanNumber(field)
  if (mods.version) return versionKey(field)
  if (mods.numeric) return leadingNumber(field)
  if (mods.generalNumeric) {
    const value = parseGeneralFloat(field)
    if (value === null) return [0, 0]
    if (Number.isNaN(value)) return [1, 0]
    return [2, value]
  }
  if (mods.fold) return field.toLowerCase()
  return field
}

function cmpVals(a: SortKey, b: SortKey): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length)
    for (let i = 0; i < len; i++) {
      const c = cmpVals(a[i] ?? '', b[i] ?? '')
      if (c !== 0) return c
    }
    return a.length - b.length
  }
  if (typeof a === 'object' && !Array.isArray(a) && typeof b === 'object' && !Array.isArray(b)) {
    if (a.negative !== b.negative) return a.negative ? -1 : 1
    const order =
      a.integer.length - b.integer.length ||
      compareCodePoints(a.integer, b.integer) ||
      compareCodePoints(a.fraction, b.fraction)
    return a.negative ? -order : order
  }
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'string' && typeof b === 'string') return compareCodePoints(a, b)
  throw new TypeError('sort keys must have the same comparison type')
}

// GNU sort's `compare`: the keys, then the whole line as a last resort.
// `-s` and `-u` both stop at the keys, so under `-u` two lines whose keys
// tie are equal however else they differ, which is what makes `sort -u
// -k2,2` keep the first of them in input order and what makes `sort -c -u`
// call the pair a disorder. GNU's own condition is `diff || unique ||
// stable`. Mirrors compare_lines in sort_keys.py.
export function compareLines(a: string, b: string, cfg: SortConfig): number {
  const fa = computeFields(a, cfg.fieldSep)
  const fb = computeFields(b, cfg.fieldSep)
  for (const key of cfg.keys) {
    const ka = transform(extract(a, fa, key), key.mods)
    const kb = transform(extract(b, fb, key), key.mods)
    let c = cmpVals(ka, kb)
    if (key.mods.reverse) c = -c
    if (c !== 0) return c
  }
  if (cfg.stable || cfg.unique) return 0
  let c = compareCodePoints(a, b)
  if (cfg.reverse) c = -c
  return c
}

export function sortLines(lines: string[], cfg: SortConfig): string[] {
  const indexed = lines.map((l, i) => ({ l, i }))
  indexed.sort((x, y) => {
    const c = compareLines(x.l, y.l, cfg)
    return c !== 0 ? c : x.i - y.i
  })
  const ordered = indexed.map((x) => x.l)
  if (!cfg.unique) return ordered
  const out: string[] = []
  for (const line of ordered) {
    const previous = out[out.length - 1]
    if (previous === undefined || compareLines(previous, line, cfg) !== 0) out.push(line)
  }
  return out
}

function mergeBefore(
  runs: readonly (readonly string[])[],
  heads: readonly number[],
  a: number,
  b: number,
  cfg: SortConfig,
): boolean {
  const c = compareLines(runs[a]?.[heads[a] ?? 0] ?? '', runs[b]?.[heads[b] ?? 0] ?? '', cfg)
  return c < 0 || (c === 0 && a < b)
}

// GNU sort's `mergefps`: merge runs it trusts to be sorted already. The line
// emitted next is always the smallest head, a tie going to the earlier run,
// and a run is never reordered, so `sort -m` over an unsorted file hands it
// back as it found it, the way GNU does. The runs are kept ordered by their
// heads and a run whose head moves is reinserted by binary search, GNU's own
// `ord` table, so a merge of `k` runs costs `log k` comparisons a line.
// Under `-u` a line is dropped when it compares equal to the first line of
// the series it would extend, so only adjacent duplicates collapse: `a b a`
// stays three lines. Mirrors merge_lines in sort_keys.py.
export function mergeLines(runs: readonly (readonly string[])[], cfg: SortConfig): string[] {
  const heads = runs.map(() => 0)
  const order: number[] = []
  for (let run = 0; run < runs.length; run++) {
    if ((runs[run]?.length ?? 0) === 0) continue
    let slot = order.length
    while (slot > 0 && mergeBefore(runs, heads, run, order[slot - 1] ?? 0, cfg)) slot -= 1
    order.splice(slot, 0, run)
  }
  const merged: string[] = []
  let saved: string | null = null
  while (order.length > 0) {
    const run = order[0] ?? 0
    const lines = runs[run] ?? []
    const line = lines[heads[run] ?? 0] ?? ''
    if (!cfg.unique || saved === null || compareLines(saved, line, cfg) !== 0) {
      merged.push(line)
      saved = line
    }
    heads[run] = (heads[run] ?? 0) + 1
    if (heads[run] === lines.length) {
      order.shift()
      continue
    }
    let lo = 1
    let hi = order.length
    while (lo < hi) {
      const probe = Math.floor((lo + hi) / 2)
      if (mergeBefore(runs, heads, run, order[probe] ?? 0, cfg)) hi = probe
      else lo = probe + 1
    }
    order.splice(0, lo, ...order.slice(1, lo), run)
  }
  return merged
}
