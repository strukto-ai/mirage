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

import { byteChar } from '../../../../shell/bytes.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { strverscmp } from '../../../../utils/strverscmp.ts'
import { textWidth } from '../../../../utils/width.ts'
import { FormatUsageError, GitError, UnparsableFormatError } from './errors.ts'
import { fieldValue, parseField } from './ref_fields.ts'
import {
  QuoteStyle,
  RefKind,
  type FieldValue,
  type RefContext,
  type RefField,
  type RefFormat,
  type RefItem,
  type RefSortKey,
} from './types.ts'

const HEX_DIGITS = '0123456789abcdefABCDEF'
const BLOCK_FIELDS = new Set(['align', 'if', 'then', 'else', 'end'])
const SPACE = /^[ \t\n\v\f\r]*$/
// The quoting styles that cannot carry a raw object's bytes.
const TEXT_QUOTES = [QuoteStyle.SHELL, QuoteStyle.PYTHON, QuoteStyle.TCL]
const TCL_ESCAPES: Readonly<Record<string, string>> = {
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
}
const VERSION_PREFIXES = ['version:', 'v:']
// The sort a listing gets when the line names none: by name, upward.
const DEFAULT_KEY = 'refname'

/**
 * A format's text between fields: `%%` is a percent sign and `%` with two hex
 * digits the byte they spell; any other `%` is itself.
 */
export function literalText(text: string): string {
  let out = ''
  let at = 0
  while (at < text.length) {
    const ch = text.charAt(at)
    if (ch === '%' && text.charAt(at + 1) === '%') {
      out += '%'
      at += 2
    } else if (
      ch === '%' &&
      at + 2 < text.length &&
      HEX_DIGITS.includes(text.charAt(at + 1)) &&
      HEX_DIGITS.includes(text.charAt(at + 2))
    ) {
      out += byteChar(parseInt(text.slice(at + 1, at + 3), 16))
      at += 3
    } else {
      out += ch
      at += 1
    }
  }
  return out
}

/** Whether the `%` at `start` is the second half of a `%%` begun at or after `at`. */
function escaped(template: string, at: number, start: number): boolean {
  let run = 0
  while (start - run - 1 >= at && template.charAt(start - run - 1) === '%') run++
  return run % 2 === 1
}

/** A template's literal runs and fields, and where an unclosed `%(` starts, null when every one closes. */
function pieces(template: string): [(string | RefField)[], number | null] {
  const out: (string | RefField)[] = []
  let at = 0
  for (;;) {
    let start = template.indexOf('%(', at)
    while (start !== -1 && escaped(template, at, start)) start = template.indexOf('%(', start + 1)
    if (start === -1) {
      if (at < template.length) out.push(literalText(template.slice(at)))
      return [out, null]
    }
    const end = template.indexOf(')', start)
    if (end === -1) return [out, start]
    if (at < start) out.push(literalText(template.slice(at, start)))
    out.push(parseField(template.slice(start + 2, end)))
    at = end + 1
  }
}

function checkRaw(parts: readonly (string | RefField)[], quote: QuoteStyle): void {
  if (!TEXT_QUOTES.includes(quote)) return
  for (const piece of parts) {
    if (typeof piece !== 'string' && piece.name === 'raw' && !piece.variant) {
      throw new GitError(`--format=${piece.text} cannot be used with --python, --shell, --tcl`)
    }
  }
}

/**
 * Read a `--format` string once for every ref it renders.
 *
 * @throws FormatUsageError a `%(` that never closes
 * @throws GitError a field git refuses, or `%(raw)` under a quoting style
 *   that cannot carry its bytes
 */
export function parseFormat(template: string, quote: QuoteStyle = QuoteStyle.NONE): RefFormat {
  const [parts, unclosed] = pieces(template)
  if (unclosed !== null) {
    throw new FormatUsageError(`malformed format string ${template.slice(unclosed)}`)
  }
  checkRaw(parts, quote)
  return { pieces: parts, quote }
}

/**
 * `branch`'s and `tag`'s `--format`, which refuse a `%(` that never closes in
 * two lines rather than with the usage.
 */
export function listingFormat(template: string): RefFormat {
  const [parts, unclosed] = pieces(template)
  if (unclosed !== null) throw new UnparsableFormatError(template.slice(unclosed))
  return { pieces: parts, quote: QuoteStyle.NONE }
}

/** Every field a listing reads: its format's and its sort keys'. */
export function usedFields(
  fmt: RefFormat | null,
  keys: readonly RefSortKey[],
): readonly RefField[] {
  const fields = fmt ? fmt.pieces.filter((p): p is RefField => typeof p !== 'string') : []
  return [...fields, ...keys.map((key) => key.field)]
}

/**
 * The `--sort` keys, the last given first, as git orders them. Each is an
 * optional `-` (descending), then an optional `version:` or `v:`, then a
 * field.
 */
export function parseSortKeys(spellings: readonly string[]): RefSortKey[] {
  const keys: RefSortKey[] = []
  for (const spelling of [...spellings].reverse()) {
    const reverse = spelling.startsWith('-')
    const rest = reverse ? spelling.slice(1) : spelling
    const prefix = VERSION_PREFIXES.find((p) => rest.startsWith(p)) ?? ''
    keys.push({ field: parseField(rest.slice(prefix.length)), reverse, version: prefix !== '' })
  }
  return keys
}

/** One field's text quoted for the language a quoting option names. */
export function quoteText(text: string, style: QuoteStyle): string {
  if (style === QuoteStyle.SHELL) {
    return `'${text.replaceAll("'", "'\\''").replaceAll('!', "'\\!'")}'`
  }
  if (style === QuoteStyle.PERL) return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  if (style === QuoteStyle.PYTHON) {
    const escapedText = text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
    return `'${escapedText.replaceAll('\n', '\\n')}'`
  }
  if (style === QuoteStyle.TCL) {
    let out = ''
    for (const ch of text) out += '[]{}$\\"'.includes(ch) ? `\\${ch}` : (TCL_ESCAPES[ch] ?? ch)
    return `"${out}"`
  }
  return text
}

/**
 * Which configured suffix decides where `name` sorts: of those starting at or
 * before the first difference and reaching it, the one starting earliest,
 * then the longest, then the first configured.
 */
function suffixRank(name: string, off: number, suffixes: readonly string[]): number | null {
  let best: [number, number, number] | null = null
  for (const [rank, suffix] of suffixes.entries()) {
    if (!suffix) continue
    let at = name.indexOf(suffix)
    while (at !== -1 && at <= off) {
      if (at + suffix.length >= off) {
        // Suffixes come in configured order, so a tie keeps the first.
        const earlier =
          best === null || at < best[0] || (at === best[0] && -suffix.length < best[1])
        if (earlier) best = [at, -suffix.length, rank]
      }
      at = name.indexOf(suffix, at + 1)
    }
  }
  return best === null ? null : best[2]
}

function commonPrefix(a: string, b: string): number {
  let at = 0
  while (at < a.length && at < b.length && a.charCodeAt(at) === b.charCodeAt(at)) at++
  return at
}

/**
 * Version order with `versionsort.suffix`. A name holding one of the suffixes
 * where the two first differ sorts before one holding none, and two holding
 * different ones sort in the order the suffixes were configured; an empty
 * suffix in the list places the names holding none. Anything else is
 * `strverscmp`. Fitted to git 2.47.3 on 40,950 pairs of names.
 */
export function versioncmp(a: string, b: string, suffixes: readonly string[] = []): number {
  if (suffixes.length && a !== b) {
    const off = commonPrefix(a, b)
    let rankA = suffixRank(a, off, suffixes)
    let rankB = suffixRank(b, off, suffixes)
    const empty = suffixes.indexOf('')
    if (empty !== -1) {
      rankA ??= empty
      rankB ??= empty
    }
    if (rankA !== rankB) {
      if (rankA === null) return 1
      if (rankB === null) return -1
      return rankA < rankB ? -1 : 1
    }
  }
  return strverscmp(a, b)
}

/** Each field's value for each ref, read once however often a sort or a row asks. */
export class ValueTable {
  private readonly values = new Map<RefItem, Map<RefField, FieldValue>>()

  constructor(
    readonly fields: readonly RefField[],
    readonly ctx: RefContext,
  ) {}

  /**
   * One field's value for one ref. A ref's first read reads every field the
   * listing uses, so one refused for the ref stops the listing whichever field
   * was asked for, as git's does.
   */
  value(item: RefItem, f: RefField): FieldValue {
    let row = this.values.get(item)
    if (row === undefined) {
      const read = new Map<RefField, FieldValue>()
      for (const used of this.fields) if (!read.has(used)) read.set(used, this.read(item, used))
      row = read
      this.values.set(item, row)
    }
    let found = row.get(f)
    if (found === undefined) {
      found = this.read(item, f)
      row.set(f, found)
    }
    return found
  }

  private read(item: RefItem, f: RefField): FieldValue {
    return BLOCK_FIELDS.has(f.name) ? { text: '', number: null } : fieldValue(f, item, this.ctx)
  }
}

/** How many terminal columns a name takes. */
export function displayWidth(text: string): number {
  return textWidth(text)
}

function asciiFolded(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

function compare(
  key: RefSortKey,
  a: FieldValue,
  b: FieldValue,
  ctx: RefContext,
  icase: boolean,
): number {
  if (key.version) return versioncmp(a.text, b.text, ctx.suffixes)
  if (a.number !== null && b.number !== null) return Math.sign(a.number - b.number)
  if (icase) return compareCodePoints(asciiFolded(a.text), asciiFolded(b.text))
  return compareCodePoints(a.text, b.text)
}

/**
 * A top-down merge sort, halves split at `n / 2` rounded down and a tie taken
 * from the left, so the comparisons come in the order git's make them.
 */
function mergeSort(items: RefItem[], cmp: (a: RefItem, b: RefItem) => number): RefItem[] {
  if (items.length <= 1) return items
  const half = Math.floor(items.length / 2)
  const left = mergeSort(items.slice(0, half), cmp)
  const right = mergeSort(items.slice(half), cmp)
  const out: RefItem[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const a = left[i]
    const b = right[j]
    if (a === undefined || b === undefined) break
    if (cmp(a, b) <= 0) {
      out.push(a)
      i++
    } else {
      out.push(b)
      j++
    }
  }
  return [...out, ...left.slice(i), ...right.slice(j)]
}

/**
 * The refs in the order the keys give, the first key deciding first; a tie on
 * every key goes by name, upward whatever the keys' direction. A detached HEAD
 * leads when `detachedFirst` says so.
 *
 * The sort's first comparison of a date with a style (`committerdate:short`),
 * under whichever key, goes by the refs' instants, and every later one by the
 * dates as shown, as git's sort does (measured on 504 random ref sets and
 * eight styles against git 2.47.3 and 2.50.1, and on 1,800 random lists of up
 * to four keys against 2.50.1).
 *
 * @throws GitError a key's field refused for some ref
 */
export function sortRefs(
  items: readonly RefItem[],
  keys: readonly RefSortKey[],
  table: ValueTable,
  ctx: RefContext,
  icase: boolean,
  detachedFirst = false,
): RefItem[] {
  let fresh = true
  return mergeSort([...items], (a, b) => {
    if (detachedFirst) {
      const leadA = a.kind === RefKind.DETACHED
      const leadB = b.kind === RefKind.DETACHED
      if (leadA !== leadB) return leadA ? -1 : 1
    }
    for (const key of keys) {
      let valueA = table.value(a, key.field)
      let valueB = table.value(b, key.field)
      if (key.field.date !== null) {
        if (!fresh) {
          valueA = { text: valueA.text, number: null }
          valueB = { text: valueB.text, number: null }
        }
        fresh = false
      }
      const found = compare(key, valueA, valueB, ctx, icase)
      if (found) return key.reverse ? -found : found
    }
    if (icase) {
      return (
        compareCodePoints(asciiFolded(a.name), asciiFolded(b.name)) ||
        compareCodePoints(a.name, b.name)
      )
    }
    return compareCodePoints(a.name, b.name)
  })
}

/** An `align` or `if` block being filled while a row renders. */
interface Block {
  readonly field: RefField
  out: string[]
  condition: string | null
  then: string | null
}

function holds(f: RefField, condition: string): boolean {
  if (f.variant === 'equals') return condition === (f.argument ?? '').slice('equals='.length)
  if (f.variant === 'notequals') return condition !== (f.argument ?? '').slice('notequals='.length)
  return !SPACE.test(condition)
}

function aligned(text: string, f: RefField): string {
  const gap = f.count - textWidth(text)
  if (gap <= 0) return text
  if (f.variant === 'right') return ' '.repeat(gap) + text
  if (f.variant === 'middle') {
    const left = Math.floor(gap / 2)
    return ' '.repeat(left) + text + ' '.repeat(gap - left)
  }
  return text + ' '.repeat(gap)
}

function thenAtom(blocks: Block[]): void {
  const block = blocks[blocks.length - 1]
  if (block?.field.name !== 'if') {
    throw new GitError('format: %(then) atom used without a %(if) atom')
  }
  if (block.condition !== null) throw new GitError('format: %(then) atom used more than once')
  block.condition = block.out.join('')
  block.out = []
}

function elseAtom(blocks: Block[]): void {
  const block = blocks[blocks.length - 1]
  if (block?.field.name !== 'if') {
    throw new GitError('format: %(else) atom used without a %(if) atom')
  }
  if (block.condition === null) {
    throw new GitError('format: %(else) atom used without a %(then) atom')
  }
  if (block.then !== null) throw new GitError('format: %(else) atom used more than once')
  block.then = block.out.join('')
  block.out = []
}

function endAtom(blocks: Block[]): string {
  const block = blocks.pop()
  if (block === undefined) {
    throw new GitError('format: %(end) atom used without corresponding atom')
  }
  const body = block.out.join('')
  if (block.field.name === 'align') return aligned(body, block.field)
  if (block.condition === null) {
    throw new GitError('format: %(if) atom used without a %(then) atom')
  }
  const [then, other] = block.then !== null ? [block.then, body] : [body, '']
  return holds(block.field, block.condition) ? then : other
}

/**
 * One ref through a format: literal text as it is, each field (or each
 * outermost block) quoted on its own.
 *
 * @throws GitError blocks that do not nest, or a field refused for this ref
 */
export function renderRow(fmt: RefFormat, item: RefItem, table: ValueTable): string {
  const out: string[] = []
  const blocks: Block[] = []
  const emit = (text: string, quoted: boolean): void => {
    const block = blocks[blocks.length - 1]
    if (block !== undefined) block.out.push(text)
    else out.push(quoted ? quoteText(text, fmt.quote) : text)
  }
  for (const piece of fmt.pieces) {
    if (typeof piece === 'string') emit(piece, false)
    else if (piece.name === 'align' || piece.name === 'if') {
      blocks.push({ field: piece, out: [], condition: null, then: null })
    } else if (piece.name === 'then') thenAtom(blocks)
    else if (piece.name === 'else') elseAtom(blocks)
    else if (piece.name === 'end') emit(endAtom(blocks), true)
    else emit(table.value(item, piece).text, true)
  }
  if (blocks.length) throw new GitError('format: %(end) atom missing')
  return out.join('')
}

function defaultOrder(keys: readonly RefSortKey[]): boolean {
  const [key] = keys
  return keys.length === 1 && key?.field.text === DEFAULT_KEY && !key.reverse && !key.version
}

/** How a listing writes its rows. */
export interface FormatRefsOptions {
  /** `--count`, 0 for every ref. */
  readonly count?: number
  /** `--omit-empty`: no line for an empty row. */
  readonly omitEmpty?: boolean
  /** `--ignore-case`. */
  readonly icase?: boolean
  /** A detached HEAD leads. */
  readonly detachedFirst?: boolean
  /**
   * Whether the listing may write rows as it renders, which a line naming its
   * sort, or a commit filter that walks history first, rules out.
   */
  readonly stream?: boolean
}

/**
 * A listing through `--format`, one row per ref. A listing in name order
 * (`--no-sort`, or the one sort a line gets by default, case-sensitive) writes
 * each row as it renders, in the order the refs came, so a field refused on a
 * later ref stops it with the rows before already out; a sorted one renders
 * every row first and prints none when one is refused. `--count` takes refs,
 * an omitted empty row among them.
 *
 * @returns the rows printed, and the refusal the listing stopped at
 */
export function formatRefs(
  fmt: RefFormat,
  items: readonly RefItem[],
  ctx: RefContext,
  keys: readonly RefSortKey[] | null,
  options: FormatRefsOptions = {},
): [string, GitError | null] {
  const { count = 0, omitEmpty = false, icase = false, detachedFirst = false } = options
  const table = new ValueTable(usedFields(fmt, keys ?? []), ctx)
  // Case folding reorders even the default sort, so only a case-sensitive one
  // streams.
  const streamed = (options.stream ?? true) && (keys === null || (!icase && defaultOrder(keys)))
  let ordered: RefItem[]
  try {
    ordered =
      keys === null || streamed
        ? [...items]
        : sortRefs(items, keys, table, ctx, icase, detachedFirst)
  } catch (error) {
    if (error instanceof GitError) return ['', error]
    throw error
  }
  // A streamed listing stops at its count; a sorted one renders every row
  // before the count takes the first.
  let rows: string[] = []
  let stopped: GitError | null = null
  for (const [taken, item] of ordered.entries()) {
    if (streamed && count > 0 && taken >= count) break
    try {
      rows.push(renderRow(fmt, item, table))
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      if (!streamed) return ['', error]
      stopped = error
      break
    }
  }
  if (count > 0) rows = rows.slice(0, count)
  return [
    rows
      .filter((row) => row || !omitEmpty)
      .map((row) => `${row}\n`)
      .join(''),
    stopped,
  ]
}
