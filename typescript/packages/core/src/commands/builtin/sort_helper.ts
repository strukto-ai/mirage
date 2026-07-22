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

const HUMAN_SUFFIXES: Record<string, number> = {
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
}

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
const KEYDEF_RE = /^(\d+)(?:\.(\d+))?([a-zA-Z]*)$/
// GNU key modifier letters. n/g map to numeric; h/V/M/f/r/b are honored;
// d/i/R are recognized so they still suppress global options (per GNU
// key_init) but are not yet applied as filters.
const ORDER_LETTERS = 'bdfgiMnRrV'

export class SortKeyError extends Error {}

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

type SortVal = string | number | (string | number)[]

function parsePos(spec: string, isEnd: boolean): [number, number | null, string] {
  const match = KEYDEF_RE.exec(spec)
  if (match === null) throw new SortKeyError(`invalid field specification '${spec}'`)
  const field = Number.parseInt(match[1] ?? '', 10)
  if (field === 0) {
    throw new SortKeyError(`field number is zero: invalid field specification '${spec}'`)
  }
  const charGroup = match[2]
  const letters = match[3] ?? ''
  for (const letter of letters) {
    if (!ORDER_LETTERS.includes(letter)) {
      throw new SortKeyError(`invalid ordering option '${letter}'`)
    }
  }
  let char: number | null
  if (charGroup === undefined) {
    char = isEnd ? null : 1
  } else {
    char = Number.parseInt(charGroup, 10)
    if (!isEnd && char === 0) char = 1
  }
  return [field, char, letters]
}

function modsFromLetters(letterRuns: string): [KeyMods, boolean] {
  let hasOwn = false
  for (const letter of letterRuns) {
    if (ORDER_LETTERS.includes(letter)) hasOwn = true
  }
  const numeric = letterRuns.includes('n')
  return [
    {
      numeric,
      generalNumeric: letterRuns.includes('g'),
      human: letterRuns.includes('h'),
      version: letterRuns.includes('V'),
      month: letterRuns.includes('M'),
      fold: letterRuns.includes('f'),
      reverse: letterRuns.includes('r'),
      dictionary: letterRuns.includes('d'),
      ignoreNonprinting: letterRuns.includes('i'),
    },
    hasOwn,
  ]
}

export function parseKeydef(spec: string, globalMods: KeyMods, globalSkip: boolean): Key {
  const commaIdx = spec.indexOf(',')
  const startSpec = commaIdx === -1 ? spec : spec.slice(0, commaIdx)
  const endSpec = commaIdx === -1 ? '' : spec.slice(commaIdx + 1)
  const [startField, startChar, startLetters] = parsePos(startSpec, false)
  let endField: number | null = null
  let endChar: number | null = null
  let endLetters = ''
  if (endSpec !== '') {
    ;[endField, endChar, endLetters] = parsePos(endSpec, true)
  }
  const [ownMods, hasOwn] = modsFromLetters(startLetters + endLetters)
  let mods: KeyMods
  let startSkip: boolean
  let endSkip: boolean
  if (hasOwn) {
    mods = ownMods
    startSkip = startLetters.includes('b')
    endSkip = endLetters.includes('b')
  } else {
    mods = globalMods
    startSkip = globalSkip
    endSkip = globalSkip
  }
  return {
    startField,
    startChar: startChar ?? 1,
    startSkip,
    endField,
    endChar,
    endSkip,
    mods,
  }
}

export function buildConfig(flags: Record<string, string | boolean | string[]>): SortConfig {
  const globalMods: KeyMods = {
    numeric: flags.n === true,
    generalNumeric: flags.g === true,
    human: flags.h === true,
    version: flags.V === true,
    month: flags.M === true,
    fold: flags.f === true,
    reverse: flags.r === true,
    dictionary: flags.d === true,
    ignoreNonprinting: flags.i === true,
  }
  const ignoreBlanks = flags.b === true
  const rawK = flags.k
  const keyDefs =
    rawK === undefined ? [] : Array.isArray(rawK) ? rawK : typeof rawK === 'string' ? [rawK] : []
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
  return {
    keys,
    fieldSep: typeof flags.t === 'string' ? flags.t : null,
    reverse: flags.r === true,
    unique: flags.u === true,
    stable: flags.s === true,
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
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i += 1
    const contentStart = i
    while (i < n && line[i] !== ' ' && line[i] !== '\t') i += 1
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

function parseHuman(s: string): number {
  const trimmed = s.trim()
  if (trimmed === '') return 0
  const suffix = trimmed[trimmed.length - 1]?.toUpperCase() ?? ''
  if (suffix in HUMAN_SUFFIXES) {
    const num = Number.parseFloat(trimmed.slice(0, -1))
    if (Number.isNaN(num)) return 0
    return num * (HUMAN_SUFFIXES[suffix] ?? 1)
  }
  const num = Number.parseFloat(trimmed)
  return Number.isNaN(num) ? 0 : num
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

function leadingNumber(field: string): number {
  const trimmed = field.replace(/^\s+/, '')
  let numEnd = 0
  for (const ch of trimmed) {
    if (/\d/.test(ch) || ((ch === '.' || ch === '+' || ch === '-') && numEnd === 0)) numEnd += 1
    else break
  }
  if (numEnd === 0) return 0
  const num = Number.parseFloat(trimmed.slice(0, numEnd))
  return Number.isNaN(num) ? 0 : num
}

function isPrintingCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code > 31 && code !== 127
}

function parseGeneralFloat(field: string): number | null {
  const trimmed = field.trim()
  if (trimmed === '') return null
  const collapsed = trimmed.replace(/(\d)_(?=\d)/g, '$1')
  if (collapsed.includes('_')) return null
  const lowered = collapsed.toLowerCase()
  if (/^[+-]?(inf(inity)?|nan)$/.test(lowered)) {
    if (lowered.endsWith('nan')) return Number.NaN
    return lowered.startsWith('-') ? -Infinity : Infinity
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(collapsed)) return null
  return Number(collapsed)
}

function transform(field: string, mods: KeyMods): SortVal {
  if (mods.dictionary)
    field = Array.from(field)
      .filter((char) => /[\p{L}\p{N} \t]/u.test(char))
      .join('')
  else if (mods.ignoreNonprinting) {
    field = Array.from(field).filter(isPrintingCharacter).join('')
  }
  if (mods.month) return MONTHS[field.trim().slice(0, 3).toLowerCase()] ?? 0
  if (mods.human) return parseHuman(field)
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

function cmpVals(a: SortVal, b: SortVal): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length)
    for (let i = 0; i < len; i++) {
      const c = cmpVals(a[i] ?? '', b[i] ?? '')
      if (c !== 0) return c
    }
    return a.length - b.length
  }
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

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
  if (cfg.stable) return 0
  let c = a < b ? -1 : a > b ? 1 : 0
  if (cfg.reverse) c = -c
  return c
}

function dedupeKeyOf(line: string, cfg: SortConfig): string {
  const fields = computeFields(line, cfg.fieldSep)
  const parts = cfg.keys.map((key) => {
    const value = transform(extract(line, fields, key), key.mods)
    return Array.isArray(value) ? value.map((x) => String(x)).join('\0') : String(value)
  })
  return parts.join('\x01')
}

export function splitSortLines(text: string): string[] {
  if (text === '') return []
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped.split('\n')
}

export function sortLines(lines: string[], cfg: SortConfig): string[] {
  const indexed = lines.map((l, i) => ({ l, i }))
  indexed.sort((x, y) => {
    const c = compareLines(x.l, y.l, cfg)
    return c !== 0 ? c : x.i - y.i
  })
  const ordered = indexed.map((x) => x.l)
  if (!cfg.unique) return ordered
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of ordered) {
    const dk = dedupeKeyOf(line, cfg)
    if (!seen.has(dk)) {
      seen.add(dk)
      out.push(line)
    }
  }
  return out
}
