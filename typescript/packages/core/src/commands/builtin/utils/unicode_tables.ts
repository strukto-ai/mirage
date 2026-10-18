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

// The \h and \v lists are those of PCRE2 10.43 and 10.46 (BSD-3-Clause
// WITH PCRE2-exception; see licenses/third_party/pcre2.txt).

import { ALL, CharSet, MAX_CODE_POINT, type Range } from './charset.ts'

// The planes that hold assigned characters other than private use are the
// ones `scanRegions` spells out; the rest is private use (planes 15 and 16) or
// unassigned, so the category scan stays a quarter of the code space.
// Mirrors `unicode_tables.py`.
const PRIVATE_USE: Range[] = [
  [0xf0000, 0xffffd],
  [0x100000, 0x10fffd],
]
// Where every cased letter lives, for the case-folding scan.
const CASED_LIMIT = 0x20000

const CATEGORIES = [
  'Lu',
  'Ll',
  'Lt',
  'Lm',
  'Lo',
  'Mn',
  'Mc',
  'Me',
  'Nd',
  'Nl',
  'No',
  'Pc',
  'Pd',
  'Ps',
  'Pe',
  'Pi',
  'Pf',
  'Po',
  'Sm',
  'Sc',
  'Sk',
  'So',
  'Zs',
  'Zl',
  'Zp',
  'Cc',
  'Cf',
  'Co',
  'Cn',
]

const GROUPS: Readonly<Record<string, readonly string[]>> = {
  L: ['Lu', 'Ll', 'Lt', 'Lm', 'Lo'],
  LC: ['Lu', 'Ll', 'Lt'],
  M: ['Mn', 'Mc', 'Me'],
  N: ['Nd', 'Nl', 'No'],
  P: ['Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po'],
  S: ['Sm', 'Sc', 'Sk', 'So'],
  Z: ['Zs', 'Zl', 'Zp'],
  C: ['Cc', 'Cf', 'Cs', 'Co', 'Cn'],
}

// UAX #44's long names for the General_Category values, the spelling both
// Rust's `\p{Letter}` and PCRE2's `\p{Letter}` accept.
const LONG_NAMES: Readonly<Record<string, string>> = {
  letter: 'L',
  casedletter: 'LC',
  uppercaseletter: 'Lu',
  lowercaseletter: 'Ll',
  titlecaseletter: 'Lt',
  modifierletter: 'Lm',
  otherletter: 'Lo',
  mark: 'M',
  combiningmark: 'M',
  nonspacingmark: 'Mn',
  spacingmark: 'Mc',
  enclosingmark: 'Me',
  number: 'N',
  decimalnumber: 'Nd',
  digit: 'Nd',
  letternumber: 'Nl',
  othernumber: 'No',
  punctuation: 'P',
  punct: 'P',
  connectorpunctuation: 'Pc',
  dashpunctuation: 'Pd',
  openpunctuation: 'Ps',
  closepunctuation: 'Pe',
  initialpunctuation: 'Pi',
  finalpunctuation: 'Pf',
  otherpunctuation: 'Po',
  symbol: 'S',
  mathsymbol: 'Sm',
  currencysymbol: 'Sc',
  modifiersymbol: 'Sk',
  othersymbol: 'So',
  separator: 'Z',
  spaceseparator: 'Zs',
  lineseparator: 'Zl',
  paragraphseparator: 'Zp',
  other: 'C',
  control: 'Cc',
  cntrl: 'Cc',
  format: 'Cf',
  surrogate: 'Cs',
  privateuse: 'Co',
  unassigned: 'Cn',
}

// White_Space (PropList.txt), what Rust's Unicode `\s` is.
export const WHITE_SPACE = CharSet.of(
  [0x09, 0x0d],
  [0x20, 0x20],
  [0x85, 0x85],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
)
// PCRE2's `\h` and `\v`, its fixed horizontal and vertical space lists, whose
// union is its UCP `\s` (U+180E stays in `\h`: pcre2_tables.c).
export const PCRE_HSPACE = CharSet.of(
  [0x09, 0x09],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x180e, 0x180e],
  [0x2000, 0x200a],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
)
export const PCRE_VSPACE = CharSet.of([0x0a, 0x0d], [0x85, 0x85], [0x2028, 0x2029])
// The Alphabetic code points that are neither a letter, a letter number nor a
// mark: the circled and squared Latin letters, which Rust's `\w` counts
// (`rg -o '\w+'` over `aⒶb` is one word).
const OTHER_ALPHABETIC_SYMBOLS = CharSet.of(
  [0x24b6, 0x24e9],
  [0x1f130, 0x1f149],
  [0x1f150, 0x1f169],
  [0x1f170, 0x1f189],
)
const JOIN_CONTROL = CharSet.of([0x200c, 0x200d])

export const ASCII = CharSet.of([0, 0x7f])
export const ASCII_DIGIT = CharSet.of([0x30, 0x39])
export const ASCII_WORD = CharSet.of([0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a])
export const ASCII_SPACE = CharSet.of([0x09, 0x0d], [0x20, 0x20])
// The POSIX classes in the ASCII reading both dialects give them (Rust
// always, PCRE2 without UCP), `word` included.
export const ASCII_CLASSES: Readonly<Record<string, CharSet>> = {
  alnum: CharSet.of([0x30, 0x39], [0x41, 0x5a], [0x61, 0x7a]),
  alpha: CharSet.of([0x41, 0x5a], [0x61, 0x7a]),
  ascii: ASCII,
  blank: CharSet.of([0x09, 0x09], [0x20, 0x20]),
  cntrl: CharSet.of([0, 0x1f], [0x7f, 0x7f]),
  digit: ASCII_DIGIT,
  graph: CharSet.of([0x21, 0x7e]),
  lower: CharSet.of([0x61, 0x7a]),
  print: CharSet.of([0x20, 0x7e]),
  punct: CharSet.of([0x21, 0x2f], [0x3a, 0x40], [0x5b, 0x60], [0x7b, 0x7e]),
  space: ASCII_SPACE,
  upper: CharSet.of([0x41, 0x5a]),
  word: ASCII_WORD,
  xdigit: CharSet.of([0x30, 0x39], [0x41, 0x46], [0x61, 0x66]),
}

const LOOSE = /[\s_-]+/g

// The scanned planes as strings, one per run of equal code-unit width, so a
// match index converts back to a code point.
let regions: readonly [number, string, number][] | null = null

function scanRegions(): readonly [number, string, number][] {
  if (regions !== null) return regions
  const out: [number, string, number][] = []
  const pieces: Range[] = [
    [0, 0xd7ff],
    [0xe000, 0xffff],
    [0x10000, 0x3ffff],
    [0xe0000, 0xe0fff],
  ]
  for (const [low, high] of pieces) {
    const chunk: string[] = []
    for (let cp = low; cp <= high; cp++) chunk.push(String.fromCodePoint(cp))
    out.push([low, chunk.join(''), low > 0xffff ? 2 : 1])
  }
  regions = out
  return out
}

let table: Map<string, CharSet> | null = null

/**
 * Every two-letter General_Category, from this host's Unicode data: each one
 * read with a `\p{gc=..}` scan over the planes that are assigned. Each host
 * reads its own tables -- python 3.12's are Unicode 15.0, the one ripgrep
 * 14.1.1 bundles too, while this engine carries its ICU's -- so a character
 * assigned after 15.0 may classify differently between the two hosts.
 */
function categories(): Map<string, CharSet> {
  if (table !== null) return table
  const out = new Map<string, CharSet>()
  const assigned: Range[] = []
  for (const name of CATEGORIES) {
    if (name === 'Cn' || name === 'Co') continue
    const ranges: Range[] = []
    const scan = new RegExp(`\\p{gc=${name}}+`, 'gu')
    for (const [base, text, width] of scanRegions()) {
      scan.lastIndex = 0
      for (const m of text.matchAll(scan)) {
        const start = base + m.index / width
        ranges.push([start, start + m[0].length / width - 1])
      }
    }
    const members = CharSet.of(...ranges)
    out.set(name, members)
    assigned.push(...members.ranges)
  }
  const privateUse: Range[] = [...PRIVATE_USE]
  for (const [base, text, width] of scanRegions()) {
    for (const m of text.matchAll(/\p{gc=Co}+/gu)) {
      const start = base + m.index / width
      privateUse.push([start, start + m[0].length / width - 1])
    }
  }
  out.set('Co', CharSet.of(...privateUse))
  out.set('Cs', CharSet.of([0xd800, 0xdfff]))
  const known = CharSet.of(...assigned, ...privateUse, [0xd800, 0xdfff])
  const gaps: Range[] = []
  let low = 0
  for (const [start, end] of known.ranges) {
    if (start > low) gaps.push([low, start - 1])
    low = end + 1
  }
  if (low <= MAX_CODE_POINT) gaps.push([low, MAX_CODE_POINT])
  out.set('Cn', CharSet.of(...gaps))
  table = out
  return out
}

// One General_Category value or group, by its short name.
export function category(name: string): CharSet {
  const all = categories()
  let out = new CharSet()
  for (const member of GROUPS[name] ?? [name]) out = out.union(all.get(member) ?? new CharSet())
  return out
}

/**
 * A General_Category spelling as its short name, or null. Matching is loose,
 * as both engines match it: case, spaces, underscores and hyphens are ignored,
 * and a `gc=` or `General_Category=` prefix is allowed.
 */
export function canonicalCategory(name: string): string | null {
  let key = name.replace(LOOSE, '').toLowerCase()
  for (const prefix of ['generalcategory=', 'gc=', 'generalcategory:', 'gc:']) {
    if (key.startsWith(prefix)) key = key.slice(prefix.length)
  }
  for (const short of [...Object.keys(GROUPS), ...CATEGORIES, 'Cs']) {
    if (key === short.toLowerCase()) return short
  }
  return LONG_NAMES[key] ?? null
}

/**
 * A Unicode property both dialects spell alike, or null: General_Category
 * values and groups, `Any`, `ASCII` and `Assigned`. Scripts and the other
 * binary properties are not in python's Unicode data, so they are not here in
 * either host.
 */
export function unicodeProperty(name: string): CharSet | null {
  const key = name.replace(LOOSE, '').toLowerCase()
  if (key === 'any') return ALL
  if (key === 'ascii') return ASCII
  if (key === 'assigned') return category('Cn').negate()
  const short = canonicalCategory(name)
  return short !== null ? category(short) : null
}

let rustWordSet: CharSet | null = null
let pcreWordSet: CharSet | null = null

// Rust's Unicode `\w`: Alphabetic, marks, Nd, Pc, Join_Control.
export function rustWord(): CharSet {
  rustWordSet ??= category('L')
    .union(category('Nl'))
    .union(category('M'))
    .union(category('Nd'))
    .union(category('Pc'))
    .union(JOIN_CONTROL)
    .union(OTHER_ALPHABETIC_SYMBOLS)
  return rustWordSet
}

// PCRE2's UCP `\w`: letters, numbers, Mn and Pc (10.43).
export function pcreWord(): CharSet {
  pcreWordSet ??= category('L').union(category('N')).union(category('Mn')).union(category('Pc'))
  return pcreWordSet
}

let orbits: Map<number, readonly number[]> | null = null
let casedList: readonly number[] | null = null

/**
 * Each cased code point's simple case-folding equivalence class. Two code
 * points are linked when one is the other's lowercase or uppercase and the
 * engine's own `iu` folding (simple case folding) says they are equal: `K`
 * (U+212A) joins `k`, `ſ` joins `s`, and `ı` stays alone.
 */
export function foldOrbits(): Map<number, readonly number[]> {
  if (orbits !== null) return orbits
  const parent = new Map<number, number>()
  const find = (cp: number): number => {
    let at = cp
    while ((parent.get(at) ?? at) !== at) at = parent.get(at) ?? at
    return at
  }
  for (let cp = 0; cp < CASED_LIMIT; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const ch = String.fromCodePoint(cp)
    for (const other of [ch.toLowerCase(), ch.toUpperCase()]) {
      const code = other.codePointAt(0) ?? cp
      if (other === ch || other.length !== String.fromCodePoint(code).length) continue
      const same = new RegExp(`^\\u{${cp.toString(16)}}$`, 'iu').test(other)
      if (!same) continue
      const a = find(cp)
      const b = find(code)
      if (a !== b) parent.set(Math.max(a, b), Math.min(a, b))
    }
  }
  const members = new Map<number, number[]>()
  for (const cp of parent.keys()) {
    const root = find(cp)
    const group = members.get(root) ?? []
    group.push(cp)
    members.set(root, group)
  }
  const out = new Map<number, readonly number[]>()
  for (const [root, group] of members) {
    const orbit = [...new Set([root, ...group])].sort((a, b) => a - b)
    for (const cp of orbit) out.set(cp, orbit)
  }
  orbits = out
  return out
}

// Every code point with a non-trivial case-folding class, sorted.
export function cased(): readonly number[] {
  casedList ??= [...foldOrbits().keys()].sort((a, b) => a - b)
  return casedList
}

// A set closed under simple case folding, or under ASCII folding only.
export function fold(cs: CharSet, asciiOnly: boolean): CharSet {
  if (asciiOnly) {
    const upper = cs.intersect(CharSet.of([0x41, 0x5a]))
    const lower = cs.intersect(CharSet.of([0x61, 0x7a]))
    return cs
      .union(CharSet.of(...upper.ranges.map(([a, b]): Range => [a + 32, b + 32])))
      .union(CharSet.of(...lower.ranges.map(([a, b]): Range => [a - 32, b - 32])))
  }
  const table = foldOrbits()
  const extra: number[] = []
  for (const cp of cased()) {
    if (cs.contains(cp)) extra.push(...(table.get(cp) ?? []))
  }
  return cs.union(CharSet.chars(...extra))
}
