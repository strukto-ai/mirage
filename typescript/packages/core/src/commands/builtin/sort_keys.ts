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

import { byteView } from '../../shell/bytes.ts'
import { UsageError } from '../errors.ts'
import { quoteText } from '../quote.ts'
import { SortKeyError } from './errors.ts'

// The ordering letters GNU sort takes after a KEYDEF position. R is
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
  fieldSep: number | null
  reverse: boolean
  unique: boolean
  stable: boolean
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9'
}

// A KEYDEF field or offset number: the decimal starting at `pos`, with the
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

// One `-k` KEYDEF, read and refused the way GNU sort 9.7 does:
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

// The letters GNU sort refuses to combine on one key, or '' for a compatible
// key. A key orders by at most one of -n, -g, -h, -M and the group -V, -R,
// -d, -i, whose members combine with each other but with none of the rest.
// The refusal spells the key's letters without -b and -r (`options '-gn' are
// incompatible`), and -d hides -i because GNU keeps only the stronger of the
// two filters. Mirrors _incompatible_letters in sort_keys.py.
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

// -t's separator as GNU sort reads it: one byte, `\0` for NUL. Mirrors
// tab_byte in sort_keys.py.
export function tabByte(text: string): number {
  const raw = byteView(text)
  if (raw === '') throw new UsageError('sort: empty tab')
  if (raw === '\\0') return 0
  if (raw.length > 1) throw new UsageError(`sort: multi-character tab '${quoteText(text)}'`)
  return raw.charCodeAt(0)
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
    fieldSep: globals.fieldSep === null ? null : tabByte(globals.fieldSep),
    reverse: globals.reverse,
    unique: globals.unique,
    stable: globals.stable,
  }
}
