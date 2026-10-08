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
import { charWidth } from '../../../../utils/width.ts'
import { FormatUsageError, GitError, UnparsableFormatError } from './errors.ts'
import { fieldValue, parseField } from './ref_fields.ts'
import {
  FieldCompare,
  QuoteStyle,
  RefKind,
  type FieldValue,
  type FormatFrame,
  type RefContext,
  type RefField,
  type RefFormat,
  type RefItem,
  type RefSortKey,
} from './types.ts'

const HEX = /^[0-9a-fA-F]{2}$/
const C_SPACE = /^[ \t\n\v\f\r]*$/
const VERSION_PREFIXES = ['version:', 'v:']
// The quote styles a bare %(raw) cannot be used with: raw content may hold a
// NUL, which only perl's quoting carries.
const TEXT_QUOTES = [QuoteStyle.PYTHON, QuoteStyle.SHELL, QuoteStyle.TCL]
const TCL_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['\f', '\\f'],
  ['\r', '\\r'],
  ['\n', '\\n'],
  ['\t', '\\t'],
  ['\v', '\\v'],
])

/**
 * `find_next`: where the next `%(` starts, -1 for none; a `%%` is a quoted
 * percent and never starts one.
 */
function nextField(template: string, start: number): number {
  let i = start
  while (i < template.length) {
    if (template[i] === '%') {
      if (template.startsWith('(', i + 1)) return i
      if (template.startsWith('%', i + 1)) i += 1
    }
    i += 1
  }
  return -1
}

/** `append_literal`: `%%` is a percent and `%xx` the byte it names in hex. */
export function literalText(text: string): string {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '%') {
      if (text.startsWith('%', i + 1)) {
        out.push('%')
        i += 2
        continue
      }
      const pair = text.slice(i + 1, i + 3)
      if (HEX.test(pair)) {
        out.push(byteChar(parseInt(pair, 16)))
        i += 3
        continue
      }
    }
    out.push(text[i] ?? '')
    i += 1
  }
  return out.join('')
}

/**
 * Read a `--format` the way git's `verify_ref_format` does. Every field is
 * parsed here, before any ref is read, so a bad one is refused by a listing
 * that would print nothing.
 *
 * @param template the format as typed
 * @param quote the quoting option, which bare `%(raw)` refuses all but perl's of
 * @throws FormatUsageError a `%(` with no `)`
 * @throws GitError a field git refuses, in its words
 */
export function parseFormat(template: string, quote: QuoteStyle = QuoteStyle.NONE): RefFormat {
  const pieces: (string | RefField)[] = []
  let cursor = 0
  while (cursor < template.length) {
    const start = nextField(template, cursor)
    if (start === -1) break
    const end = template.indexOf(')', start)
    if (end === -1) throw new FormatUsageError(`malformed format string ${template.slice(start)}`)
    if (start > cursor) pieces.push(literalText(template.slice(cursor, start)))
    const name = template.slice(start + 2, end)
    const field = parseField(name)
    if (field.field === 'rest') throw new GitError(`this command reject atom %(${name})`)
    if (TEXT_QUOTES.includes(quote) && field.field === 'raw' && field.option === 'bare')
      throw new GitError(`--format=${name} cannot be used with --python, --shell, --tcl`)
    pieces.push(field)
    cursor = end + 1
  }
  if (cursor < template.length) pieces.push(literalText(template.slice(cursor)))
  return { pieces, quote }
}

/**
 * A `branch` or `tag` format, whose unclosed `%(` is refused as those verbs
 * refuse it rather than with `for-each-ref`'s usage.
 */
export function listingFormat(template: string): RefFormat {
  try {
    return parseFormat(template)
  } catch (err) {
    if (err instanceof FormatUsageError)
      throw new UnparsableFormatError(err.message.replace(/^malformed format string /, ''))
    throw err
  }
}

/**
 * `ref_sorting_options`: the sort keys, the last one given first. Each key may
 * start with `-` (reverse) and then `version:` or `v:` (compare as versions);
 * what is left is a field.
 */
export function parseSortKeys(spellings: readonly string[]): RefSortKey[] {
  const keys: RefSortKey[] = []
  for (const spelling of spellings) {
    const reverse = spelling.startsWith('-')
    let rest = reverse ? spelling.slice(1) : spelling
    const prefix = VERSION_PREFIXES.find((p) => rest.startsWith(p))
    if (prefix !== undefined) rest = rest.slice(prefix.length)
    keys.push({ field: parseField(rest), reverse, version: prefix !== undefined })
  }
  return keys.reverse()
}

/** Every distinct field a listing reads, format fields first. */
export function usedFields(fmt: RefFormat, keys: readonly RefSortKey[] = []): RefField[] {
  const seen = new Map<string, RefField>()
  for (const piece of fmt.pieces) {
    if (typeof piece !== 'string' && !seen.has(piece.name)) seen.set(piece.name, piece)
  }
  for (const key of keys) if (!seen.has(key.field.name)) seen.set(key.field.name, key.field)
  return [...seen.values()]
}

/** One value quoted the way `quote_formatting` does it. */
export function quoteText(text: string, style: QuoteStyle): string {
  switch (style) {
    case QuoteStyle.SHELL:
      return `'${text.replaceAll("'", "'\\''").replaceAll('!', "'\\!'")}'`
    case QuoteStyle.PERL:
      return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
    case QuoteStyle.PYTHON:
      return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`
    case QuoteStyle.TCL: {
      let out = ''
      for (const char of text) {
        if ('[]{}$\\"'.includes(char)) out += `\\${char}`
        else out += TCL_ESCAPES.get(char) ?? char
      }
      return `"${out}"`
    }
    default:
      return text
  }
}

/**
 * Each listed ref's field values, filled all at once when first read, as git's
 * `populate_value` fills them. Reading every field together is what makes an
 * error one of them raises (a date style git lacks) surface on the first ref
 * that has the field, whichever field was asked for.
 */
export class ValueTable {
  private readonly rows = new Map<string, Map<string, FieldValue>>()

  constructor(
    private readonly fields: readonly RefField[],
    private readonly ctx: RefContext,
  ) {}

  value(item: RefItem, field: RefField): FieldValue {
    let row = this.rows.get(item.name)
    if (row === undefined) {
      row = new Map(this.fields.map((f) => [f.name, fieldValue(f, item, this.ctx)]))
      this.rows.set(item.name, row)
    }
    return row.get(field.name) ?? fieldValue(field, item, this.ctx)
  }
}

/**
 * `swap_prereleases`: a `versionsort.suffix` around the first difference sorts
 * its version before the one without it.
 */
function swapPrereleases(
  a: string,
  b: string,
  off: number,
  suffixes: readonly string[],
): number | null {
  const found = [
    [-1, off, -1],
    [-1, off, -1],
  ] as [number, number, number][]
  suffixes.forEach((suffix, position) => {
    const start = suffix.length < off ? off - suffix.length : 0
    for (const [text, match] of [
      [a, found[0]],
      [b, found[1]],
    ] as [string, [number, number, number]][]) {
      const end = match[2] < suffix.length ? match[1] : match[1] - 1
      for (let i = start; i <= end; i++) {
        if (text.startsWith(suffix, i)) {
          match[0] = position
          match[1] = i
          match[2] = suffix.length
          break
        }
      }
    }
  })
  const first = found[0]?.[0] ?? -1
  const second = found[1]?.[0] ?? -1
  if (first === second) return null
  if (first >= 0 && second >= 0) return first - second
  return first >= 0 ? -1 : 1
}

/**
 * git's `versioncmp`: glibc's `strverscmp`, unless a `versionsort.suffix`
 * around the first difference decides.
 */
export function versioncmp(a: string, b: string, suffixes: readonly string[] = []): number {
  if (suffixes.length > 0 && a !== b) {
    let off = 0
    while (a[off] === b[off]) off += 1
    const swapped = swapPrereleases(a, b, off, suffixes)
    if (swapped !== null) return swapped
  }
  return strverscmp(a, b)
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/** `strcmp`, or `strcasecmp` folding ASCII only. */
function compareText(a: string, b: string, icase: boolean): number {
  return icase ? compareCodePoints(asciiLower(a), asciiLower(b)) : compareCodePoints(a, b)
}

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0)

/**
 * `ref_array_sort`: order refs by each key in turn, then by name. The name that
 * breaks a tie is never reversed, so `-committerdate` lists refs of one date in
 * name order. `branch` puts a detached HEAD first whatever the keys say.
 */
export function sortRefs(
  items: readonly RefItem[],
  keys: readonly RefSortKey[],
  table: ValueTable,
  ctx: RefContext,
  icase = false,
  detachedFirst = false,
): RefItem[] {
  const byKey = (key: RefSortKey, a: RefItem, b: RefItem): number => {
    const va = table.value(a, key.field)
    const vb = table.value(b, key.field)
    if (detachedFirst && (a.kind === RefKind.DETACHED || b.kind === RefKind.DETACHED))
      return a.kind === RefKind.DETACHED ? -1 : 1
    let cmp: number
    if (key.version) cmp = sign(versioncmp(va.text, vb.text, ctx.suffixes))
    else if (key.field.compare === FieldCompare.TEXT)
      cmp = sign(compareText(va.text, vb.text, icase))
    else cmp = sign(va.number - vb.number)
    return key.reverse ? -cmp : cmp
  }
  return [...items].sort((a, b) => {
    for (const key of keys) {
      const cmp = byKey(key, a, b)
      if (cmp) return cmp
    }
    return sign(compareText(a.name, b.name, icase && keys.length > 0))
  })
}

/** A text's display width, as `utf8_strwidth` counts it. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += Math.max(charWidth(char.codePointAt(0) ?? 0), 0)
  return width
}

/** `strbuf_utf8_align`: pad a block to a display width. */
function aligned(text: string, field: RefField): string {
  const pad = field.number - displayWidth(text)
  if (pad <= 0) return text
  if (field.text === 'left') return text + ' '.repeat(pad)
  if (field.text === 'right') return ' '.repeat(pad) + text
  const left = Math.floor(pad / 2)
  return ' '.repeat(left) + text + ' '.repeat(pad - left)
}

/** Whether an `%(if)` holds for what it read before its `then`. */
function satisfied(frame: FormatFrame, text: string): boolean {
  const field = frame.opener
  if (field?.option === 'equals') return text === field.text
  if (field?.option === 'notequals') return text !== field.text
  return !C_SPACE.test(text)
}

/** `end_atom_handler`: close the innermost `align` or `if`. */
function endBlock(stack: FormatFrame[], quote: QuoteStyle): void {
  let current = stack[stack.length - 1]
  if (current === undefined || current.kind === 'root')
    throw new GitError('format: %(end) atom used without corresponding atom')
  if (current.kind === 'align') {
    if (current.opener !== null) current.out = [aligned(current.out.join(''), current.opener)]
  } else {
    const head = current.head ?? current
    if (!head.thenSeen) throw new GitError('format: %(if) atom used without a %(then) atom')
    if (current.head !== null) {
      const branch = current
      stack.pop()
      current = head
      if (!head.satisfied) current.out = branch.out
    } else if (!head.satisfied) {
      current.out = []
    }
  }
  const block = current.out.join('')
  stack.pop()
  const outer = stack[stack.length - 1]
  outer?.out.push(stack.length === 1 ? quoteText(block, quote) : block)
}

function frame(
  kind: FormatFrame['kind'],
  opener: RefField | null,
  head: FormatFrame | null = null,
): FormatFrame {
  return { kind, opener, out: [], thenSeen: false, satisfied: false, head }
}

/**
 * `format_ref_array_item`: one ref through the format. A field's value is
 * quoted unless it sits inside an `align` or `if` block, where the whole
 * outermost block is quoted at its `%(end)` instead; literal text is never
 * quoted.
 *
 * @throws GitError blocks that do not nest, in git's words
 */
export function renderRef(fmt: RefFormat, item: RefItem, table: ValueTable): string {
  const stack: FormatFrame[] = [frame('root', null)]
  const top = (): FormatFrame => stack[stack.length - 1] ?? frame('root', null)
  for (const piece of fmt.pieces) {
    if (typeof piece === 'string') {
      top().out.push(piece)
      continue
    }
    const value = table.value(item, piece)
    const current = top()
    switch (piece.field) {
      case 'align':
        stack.push(frame('align', piece))
        break
      case 'if':
        stack.push(frame('if', piece))
        break
      case 'then':
        if (current.kind !== 'if')
          throw new GitError('format: %(then) atom used without a %(if) atom')
        if ((current.head ?? current).thenSeen)
          throw new GitError('format: %(then) atom used more than once')
        current.thenSeen = true
        current.satisfied = satisfied(current, current.out.join(''))
        current.out = []
        break
      case 'else':
        if (current.kind !== 'if')
          throw new GitError('format: %(else) atom used without a %(if) atom')
        if (!(current.head ?? current).thenSeen)
          throw new GitError('format: %(else) atom used without a %(then) atom')
        if (current.head !== null) throw new GitError('format: %(else) atom used more than once')
        stack.push(frame('if', current.opener, current))
        break
      case 'end':
        endBlock(stack, fmt.quote)
        break
      default:
        current.out.push(stack.length === 1 ? quoteText(value.text, fmt.quote) : value.text)
    }
  }
  if (stack.length > 1) throw new GitError('format: %(end) atom missing')
  return top().out.join('')
}

/** What `formatRefs` asked for beyond the format, the refs and the facts. */
export interface ListingOptions {
  /** `--count`, zero for every ref. */
  readonly count?: number
  /** `--omit-empty`: an empty row prints no newline. */
  readonly omitEmpty?: boolean
  /** `--ignore-case`. */
  readonly icase?: boolean
  /** Whether a detached HEAD leads. */
  readonly detachedFirst?: boolean
  /**
   * Whether a listing sorted by name alone may be printed ref by ref;
   * `--merged` and `branch` never are.
   */
  readonly stream?: boolean
}

/**
 * `filter_and_format_refs`: sort the refs, then print each one.
 *
 * A listing sorted by name alone is printed ref by ref, as git streams it, so a
 * field that fails on a later ref (a date style git lacks, read only off a
 * commit) fails after the refs before it printed; any other listing reads
 * every ref while sorting, before it prints one.
 *
 * @returns what was printed, and the error the listing stopped at
 */
export function formatRefs(
  fmt: RefFormat,
  items: readonly RefItem[],
  ctx: RefContext,
  keys: readonly RefSortKey[] | null,
  options: ListingOptions = {},
): [string, GitError | null] {
  const {
    count = 0,
    omitEmpty = false,
    icase = false,
    detachedFirst = false,
    stream = true,
  } = options
  const table = new ValueTable(usedFields(fmt, keys ?? []), ctx)
  const rows: string[] = []
  try {
    let ordered = [...items]
    const [only] = keys ?? []
    // Git 2.50.1's can_do_iterative_format checks the atom type, even for
    // :short/:lstrip after --no-sort removes the default tie-breaker.
    const byName =
      keys === null ||
      (keys.length === 1 &&
        only?.field.field === 'refname' &&
        !only.reverse &&
        !only.version &&
        !icase)
    if (!(stream && byName) && keys?.length)
      ordered = sortRefs(ordered, keys, table, ctx, icase, detachedFirst)
    for (const item of count ? ordered.slice(0, count) : ordered) {
      const row = renderRef(fmt, item, table)
      if (row || !omitEmpty) rows.push(`${row}\n`)
    }
  } catch (err) {
    if (err instanceof GitError) return [rows.join(''), err]
    throw err
  }
  return [rows.join(''), null]
}
