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

import { DWIM_RULES } from './constants.ts'
import { parseDateMode, showDate } from './dates.ts'
import { GitError, UnsupportedFieldError } from './errors.ts'
import { mappedIdentity } from './mailmap.ts'
import {
  FieldCompare,
  FieldSource,
  RefKind,
  type FieldValue,
  type RefContext,
  type RefField,
  type RefItem,
  type RefObject,
} from './types.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()
const TEXT = FieldCompare.TEXT
const NUMBER = FieldCompare.NUMBER
const TIME = FieldCompare.TIME
const REF = FieldSource.REF
const OBJECT = FieldSource.OBJECT
const INFO = FieldSource.OBJECT_INFO

// git's valid_atom table: every field a format or a sort key may name, with
// where its value comes from and how it sorts.
const FIELDS: ReadonlyMap<string, readonly [FieldSource, FieldCompare]> = new Map([
  ['refname', [REF, TEXT]],
  ['objecttype', [INFO, TEXT]],
  ['objectsize', [INFO, NUMBER]],
  ['objectname', [INFO, TEXT]],
  ['deltabase', [INFO, TEXT]],
  ['tree', [OBJECT, TEXT]],
  ['parent', [OBJECT, TEXT]],
  ['numparent', [OBJECT, NUMBER]],
  ['object', [OBJECT, TEXT]],
  ['type', [OBJECT, TEXT]],
  ['tag', [OBJECT, TEXT]],
  ['author', [OBJECT, TEXT]],
  ['authorname', [OBJECT, TEXT]],
  ['authoremail', [OBJECT, TEXT]],
  ['authordate', [OBJECT, TIME]],
  ['committer', [OBJECT, TEXT]],
  ['committername', [OBJECT, TEXT]],
  ['committeremail', [OBJECT, TEXT]],
  ['committerdate', [OBJECT, TIME]],
  ['tagger', [OBJECT, TEXT]],
  ['taggername', [OBJECT, TEXT]],
  ['taggeremail', [OBJECT, TEXT]],
  ['taggerdate', [OBJECT, TIME]],
  ['creator', [OBJECT, TEXT]],
  ['creatordate', [OBJECT, TIME]],
  ['describe', [OBJECT, TEXT]],
  ['subject', [OBJECT, TEXT]],
  ['body', [OBJECT, TEXT]],
  ['trailers', [OBJECT, TEXT]],
  ['contents', [OBJECT, TEXT]],
  ['signature', [OBJECT, TEXT]],
  ['raw', [OBJECT, TEXT]],
  ['upstream', [REF, TEXT]],
  ['push', [REF, TEXT]],
  ['symref', [REF, TEXT]],
  ['flag', [REF, TEXT]],
  ['HEAD', [REF, TEXT]],
  ['color', [REF, TEXT]],
  ['worktreepath', [REF, TEXT]],
  ['align', [REF, TEXT]],
  ['end', [REF, TEXT]],
  ['if', [REF, TEXT]],
  ['then', [REF, TEXT]],
  ['else', [REF, TEXT]],
  ['rest', [REF, TEXT]],
  ['ahead-behind', [INFO, TEXT]],
  ['is-base', [INFO, TEXT]],
])

// Real git fields this build does not render: a GPG check, a trailer parser, a
// describe walk, pack internals, push destinations, colors, reachability
// counts and the packed/symref flag word.
const UNSUPPORTED = new Set([
  'deltabase',
  'describe',
  'trailers',
  'signature',
  'push',
  'color',
  'flag',
  'ahead-behind',
  'is-base',
])

const PEOPLE = ['author', 'committer', 'tagger'] as const
const DATE_FIELDS = new Set(['authordate', 'committerdate', 'taggerdate', 'creatordate'])
const ALIGN_POSITIONS = ['left', 'middle', 'right']
// parse_signed_buffer's markers: a line starting with one begins the signature
// a tag message carries.
const SIGNATURE_MARKERS = [
  '-----BEGIN PGP SIGNATURE-----',
  '-----BEGIN PGP MESSAGE-----',
  '-----BEGIN SIGNED MESSAGE-----',
  '-----BEGIN SSH SIGNATURE-----',
]
export const MINIMUM_ABBREV = 4
// The refname strip options and what each is: `strip=` is git's old spelling
// of `lstrip=`, and a bad count is refused under that name.
const STRIP_OPTIONS = [
  ['lstrip=', 'lstrip'],
  ['strip=', 'lstrip'],
  ['rstrip=', 'rstrip'],
] as const
const C_INTEGER = /^[ \t\n\v\f\r]*([+-]?)([0-9]+)$/
const INT_MAX = 2 ** 31 - 1
const UINT_MAX = 2 ** 32 - 1
const TITLE_CHARS = /[a-zA-Z0-9._]/
const LEADING_DIGITS = /^[ \t\n\v\f\r]*([0-9]*)/
const LEADING_ZONE = /^[ \t\n\v\f\r]*([+-]?[0-9]+)/

/** `strtol_i`: a whole decimal `int`, null for anything else. */
export function cInt(text: string): number | null {
  const found = C_INTEGER.exec(text)
  if (!found) return null
  const value = Number(`${found[1] ?? ''}${found[2] ?? ''}`)
  return value >= -INT_MAX - 1 && value <= INT_MAX ? value : null
}

/**
 * `strtoul_ui`: a whole decimal `unsigned int`, null for anything else, a minus
 * sign anywhere included.
 */
export function cUint(text: string): number | null {
  const found = C_INTEGER.exec(text)
  if (text.includes('-') || !found) return null
  const value = Number(found[2] ?? '')
  return value <= UINT_MAX ? value : null
}

/** A field's name up to its arguments, as git's refusals print it. */
function label(name: string): string {
  return name.split(':', 1)[0] ?? ''
}

/** git's `err_bad_arg`. */
function badArg(name: string, arg: string): GitError {
  return new GitError(`unrecognized %(${label(name)}) argument: ${arg}`)
}

/** git's `err_no_arg`, which names the field without its `*`. */
function noArg(word: string): GitError {
  return new GitError(`%(${word}) does not take arguments`)
}

/** `refname_atom_parser_internal`: how a ref name is shown. */
export function refnameOption(arg: string | null, name: string): [string, number] {
  if (arg === null) return ['', 0]
  if (arg === 'short') return ['short', 0]
  for (const [prefix, option] of STRIP_OPTIONS) {
    if (arg.startsWith(prefix)) {
      const count = cInt(arg.slice(prefix.length))
      if (count === null)
        throw new GitError(`Integer value expected refname:${option}=${arg.slice(prefix.length)}`)
      return [option, count]
    }
  }
  throw badArg(name, arg)
}

function parseRefname(field: RefField): RefField {
  const [option, number] = refnameOption(field.arg, field.name)
  return { ...field, option, number }
}

/**
 * `remote_ref_atom_parser`: which fact about the upstream shows.
 *
 * git hands the refname parser the whole argument rather than the word it
 * failed to recognize, so a refname option only parses as the argument's one
 * word (`upstream:short,track` is refused whole).
 */
function parseUpstream(field: RefField): RefField {
  if (field.arg === null) return { ...field, option: 'ref' }
  let option = 'ref'
  let how = ''
  let count = 0
  const words = new Set<string>()
  for (const word of field.arg.split(',')) {
    if (['track', 'trackshort', 'remotename', 'remoteref'].includes(word)) option = word
    else if (word === 'nobracket') words.add(word)
    else {
      option = 'ref'
      ;[how, count] = refnameOption(field.arg, field.name)
    }
  }
  return { ...field, option, text: how, number: count, words }
}

/** A parser for a field that refuses any argument. */
function noArgument(word: string): (field: RefField) => RefField {
  return (field) => {
    if (field.arg !== null) throw noArg(word)
    return field
  }
}

function parseObjectsize(field: RefField): RefField {
  if (field.arg === null) return field
  if (field.arg === 'disk') throw new UnsupportedFieldError(field.name)
  throw badArg('objectsize', field.arg)
}

function parseSubject(field: RefField): RefField {
  if (field.arg === null) return { ...field, option: 'subject' }
  if (field.arg === 'sanitize') return { ...field, option: 'sanitize' }
  throw badArg('subject', field.arg)
}

function parseContents(field: RefField): RefField {
  const arg = field.arg
  if (arg === null) return { ...field, option: 'bare' }
  if (['body', 'signature', 'subject'].includes(arg)) return { ...field, option: arg }
  if (arg === 'size') return { ...field, option: 'size', compare: NUMBER }
  if (arg === 'trailers' || arg.startsWith('trailers:')) throw new UnsupportedFieldError(field.name)
  if (arg.startsWith('lines=')) {
    const count = cUint(arg.slice('lines='.length))
    if (count === null)
      throw new GitError(`positive value expected contents:lines=${arg.slice('lines='.length)}`)
    return { ...field, option: 'lines', number: count }
  }
  throw badArg('contents', arg)
}

function parseRaw(field: RefField): RefField {
  if (field.arg === null) return { ...field, option: 'bare' }
  if (field.arg === 'size') return { ...field, option: 'size', compare: NUMBER }
  throw badArg('raw', field.arg)
}

/** `oid_atom_parser`: a full id, or one abbreviated. */
function parseOid(field: RefField): RefField {
  const arg = field.arg
  if (arg === null) return { ...field, option: 'full' }
  if (arg === 'short') return { ...field, option: 'short' }
  if (arg.startsWith('short=')) {
    const count = cUint(arg.slice('short='.length))
    if (!count)
      throw new GitError(
        `positive value expected '${arg.slice('short='.length)}' in %(${field.name})`,
      )
    return { ...field, option: 'length', number: Math.max(count, MINIMUM_ABBREV) }
  }
  throw badArg(field.name, arg)
}

function parsePersonName(field: RefField): RefField {
  if (field.arg === null) return field
  if (field.arg === 'mailmap') return { ...field, option: 'mailmap' }
  throw badArg(field.name, field.arg)
}

/**
 * `person_email_atom_parser`: `trim`, `localpart` and `mailmap`,
 * comma-separated, each a prefix git reads off in turn.
 */
function parsePersonEmail(field: RefField): RefField {
  const words = new Set<string>()
  let rest = field.arg
  while (rest !== null) {
    const tail = rest
    const word = ['trim', 'localpart', 'mailmap'].find((w) => tail.startsWith(w))
    if (word === undefined) throw badArg(field.name, rest)
    words.add(word)
    rest = rest.slice(word.length)
    if (!rest) break
    if (!rest.startsWith(',')) throw badArg(field.name, rest)
    rest = rest.slice(1)
  }
  return { ...field, words }
}

/** `align_atom_parser`: a width and a position, in either order. */
function parseAlign(field: RefField): RefField {
  if (field.arg === null) throw new GitError('expected format: %(align:<width>,<position>)')
  let position = 'left'
  let width: number | null = null
  for (const word of field.arg.split(',')) {
    if (word.startsWith('position=')) {
      const at = word.slice('position='.length)
      if (!ALIGN_POSITIONS.includes(at)) throw new GitError(`unrecognized position:${at}`)
      position = at
    } else if (word.startsWith('width=')) {
      width = cUint(word.slice('width='.length))
      if (width === null) throw new GitError(`unrecognized width:${word.slice('width='.length)}`)
    } else if (cUint(word) !== null) {
      width = cUint(word)
    } else if (ALIGN_POSITIONS.includes(word)) {
      position = word
    } else {
      throw new GitError(`unrecognized %(align) argument: ${word}`)
    }
  }
  if (width === null) throw new GitError('positive width expected with the %(align) atom')
  return { ...field, number: width, text: position }
}

function parseIf(field: RefField): RefField {
  const arg = field.arg
  if (arg === null) return field
  for (const word of ['equals=', 'notequals=']) {
    if (arg.startsWith(word))
      return { ...field, option: word.slice(0, -1), text: arg.slice(word.length) }
  }
  throw badArg('if', arg)
}

const PARSERS: ReadonlyMap<string, (field: RefField) => RefField> = new Map([
  ['refname', parseRefname],
  ['symref', parseRefname],
  ['upstream', parseUpstream],
  ['objecttype', noArgument('objecttype')],
  ['objectsize', parseObjectsize],
  ['objectname', parseOid],
  ['tree', parseOid],
  ['parent', parseOid],
  ['body', noArgument('body')],
  ['subject', parseSubject],
  ['contents', parseContents],
  ['raw', parseRaw],
  ['HEAD', noArgument('HEAD')],
  ['align', parseAlign],
  ['if', parseIf],
  ['rest', noArgument('rest')],
  ...PEOPLE.map((who) => [`${who}name`, parsePersonName] as const),
  ...PEOPLE.map((who) => [`${who}email`, parsePersonEmail] as const),
])

/**
 * Read one field the way git's `parse_ref_filter_atom` does.
 *
 * @param name the text between `%(` and `)`, or a sort key without its prefixes
 * @throws GitError a malformed or unknown field, or an argument its parser
 *   refuses, in git's words
 * @throws UnsupportedFieldError a real git field this build lacks
 */
export function parseField(name: string): RefField {
  const deref = name.startsWith('*')
  const body = deref ? name.slice(1) : name
  if (!body) throw new GitError(`malformed field name: ${name}`)
  const colon = body.indexOf(':')
  const head = colon < 0 ? body : body.slice(0, colon)
  const arg = colon < 0 ? '' : body.slice(colon + 1)
  const known = FIELDS.get(head)
  if (known === undefined) throw new GitError(`unknown field name: ${name}`)
  if (UNSUPPORTED.has(head)) throw new UnsupportedFieldError(name)
  const [source, fieldCompare] = known
  const compare = DATE_FIELDS.has(head) && colon >= 0 ? TEXT : fieldCompare
  const field: RefField = {
    name,
    field: head,
    deref,
    arg: arg || null,
    compare,
    source,
    option: '',
    number: 0,
    words: new Set(),
    text: '',
  }
  const parser = PARSERS.get(head)
  return parser ? parser(field) : field
}

/** Whether a field reads the ref's object, not only its name and id. */
export function needsObject(field: RefField): boolean {
  return (
    field.deref ||
    field.source === OBJECT ||
    field.field === 'objecttype' ||
    field.field === 'objectsize'
  )
}

/**
 * `shorten_unambiguous_ref`: the shortest name that still names the ref.
 *
 * Each rev-parse rule after the first is tried from the last back, and a rule's
 * short name is kept only if no other rule (`strict`, which is
 * `core.warnAmbiguousRefs`) or no earlier one would find a ref under it:
 * `refs/remotes/origin/HEAD` is `origin`, and a branch that shares its name
 * with a tag keeps its `heads/`.
 */
export function shortenRef(name: string, known: ReadonlySet<string>, strict = true): string {
  for (let i = DWIM_RULES.length - 1; i > 0; i--) {
    const rule = DWIM_RULES[i] ?? ''
    const at = rule.indexOf('{}')
    const prefix = rule.slice(0, at)
    const suffix = rule.slice(at + 2)
    if (
      !name.startsWith(prefix) ||
      !name.endsWith(suffix) ||
      name.length < prefix.length + suffix.length
    )
      continue
    const short = name.slice(prefix.length, name.length - suffix.length)
    const tried = strict ? DWIM_RULES.length : i
    let ambiguous = false
    for (let j = 0; j < tried && !ambiguous; j++) {
      if (j !== i && known.has((DWIM_RULES[j] ?? '').replace('{}', short))) ambiguous = true
    }
    if (!ambiguous) return short
  }
  return name
}

/** How many `/`-separated components a strip count means. */
function componentsToStrip(name: string, count: number): number {
  return count >= 0 ? count : name.split('/').length - 1 + count + 1
}

/** `lstrip_ref_components`: a ref name less its leading components. */
export function lstripRef(name: string, count: number): string {
  const remaining = componentsToStrip(name, count)
  const parts = name.split('/')
  if (remaining <= 0) return name
  return remaining >= parts.length ? '' : parts.slice(remaining).join('/')
}

/** `rstrip_ref_components`: a ref name less its trailing components. */
export function rstripRef(name: string, count: number): string {
  const remaining = componentsToStrip(name, count)
  const parts = name.split('/')
  if (remaining <= 0) return name
  return remaining >= parts.length ? '' : parts.slice(0, parts.length - remaining).join('/')
}

/** A ref name as a `refname`-style option shows it. */
export function showRef(option: string, count: number, name: string, ctx: RefContext): string {
  if (option === 'short') return shortenRef(name, ctx.known, ctx.strict)
  if (option === 'lstrip') return lstripRef(name, count)
  if (option === 'rstrip') return rstripRef(name, count)
  return name
}

function textOf(obj: RefObject): string {
  return DEC.decode(obj.raw)
}

/**
 * `find_wholine`: the rest of the buffer after the first header line that
 * starts with `who`, empty when the header has none.
 */
export function headerLine(text: string, who: string): string {
  let start = 0
  while (start < text.length) {
    if (text.startsWith(`${who} `, start)) return text.slice(start + who.length + 1)
    const end = text.indexOf('\n', start)
    if (end === -1 || text.startsWith('\n', end + 1)) return ''
    start = end + 1
  }
  return ''
}

/** Every header line's value for `word`, in order (`parent`). */
function headerValues(text: string, word: string): string[] {
  const head = text.split('\n\n', 1)[0] ?? ''
  return head
    .split('\n')
    .filter((line) => line.startsWith(`${word} `))
    .map((line) => line.slice(word.length + 1))
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? ''
}

/** `copy_name`: the name before the first ` <` of the line. */
function personName(line: string): string {
  const first = firstLine(line)
  const marker = first.indexOf(' <')
  return marker !== -1 ? first.slice(0, marker) : ''
}

/** `copy_email`: the email, bracketed unless trimmed. */
function personEmail(line: string, words: ReadonlySet<string>): string {
  let start = line.indexOf('<')
  if (start === -1) return ''
  if (words.has('trim') || words.has('localpart')) start += 1
  let end: number
  if (words.has('localpart')) {
    end = line.indexOf('@', start)
    if (end === -1) end = line.indexOf('>', start)
  } else if (words.has('trim')) {
    end = line.indexOf('>', start)
  } else {
    end = line.indexOf('>', start)
    end = end !== -1 ? end + 1 : -1
  }
  return end !== -1 ? line.slice(start, end) : ''
}

/**
 * The timestamp and offset after an ident's email, as `grab_date` reads them:
 * null when there is no `> ` to read after. The offset is in minutes east.
 */
export function identDate(line: string): [number, number] | null {
  const marker = line.indexOf('> ')
  if (marker === -1) return null
  const rest = line.slice(marker + 2)
  const stamp = LEADING_DIGITS.exec(rest)
  const digits = stamp?.[1] ?? ''
  const timestamp = digits ? Number(digits) : 0
  const zone = LEADING_ZONE.exec(rest.slice(stamp ? stamp[0].length : 0))
  const hhmm = zone ? Number(zone[1] ?? '0') : 0
  const sign = hhmm < 0 ? -1 : 1
  const hours = Math.floor(Math.abs(hhmm) / 100)
  const minutes = Math.abs(hhmm) % 100
  return [timestamp, sign * (hours * 60 + minutes)]
}

/** An ident line with the mailmap applied, as `apply_mailmap_to_header` rewrites it. */
function mailmapped(line: string, ctx: RefContext): string {
  const newline = line.indexOf('\n')
  const first = newline === -1 ? line : line.slice(0, newline)
  const rest = newline === -1 ? '' : line.slice(newline)
  const close = first.lastIndexOf('>')
  if (close === -1) return line
  return mappedIdentity(first.slice(0, close + 1), ctx.mailmap) + first.slice(close + 1) + rest
}

/**
 * `grab_date`: an ident's date in the field's style. The style is read only
 * here, when a ref has the ident, so a bad one is refused only by a listing
 * that holds such a ref, as git's is.
 */
function dateValue(line: string, field: RefField, ctx: RefContext): FieldValue {
  const body = field.deref ? field.name.slice(1) : field.name
  const colon = body.indexOf(':')
  const mode = colon >= 0 ? parseDateMode(body.slice(colon + 1), ctx.date) : ctx.date
  const found = identDate(line)
  if (found === null) return { text: '', number: 0 }
  const [timestamp, offset] = found
  return { text: showDate(timestamp, offset, mode), number: timestamp }
}

/**
 * `grab_person`: one of an object's idents, or a part of it. `creator` is the
 * committer of a commit and the tagger of a tag; an ident field the object has
 * no header for is empty.
 */
function person(obj: RefObject, field: RefField, ctx: RefContext): FieldValue {
  const text = textOf(obj)
  const head = field.field
  if (head.startsWith('creator')) {
    const who = obj.type === 'commit' ? 'committer' : obj.type === 'tag' ? 'tagger' : null
    if (who === null) return { text: '', number: 0 }
    const line = headerLine(text, who)
    if (head === 'creator') return { text: firstLine(line), number: 0 }
    return dateValue(line, field, ctx)
  }
  const who = PEOPLE.find((w) => head.startsWith(w)) ?? 'author'
  const has =
    obj.type === 'commit'
      ? who === 'author' || who === 'committer'
      : obj.type === 'tag' && who === 'tagger'
  if (!has) return { text: '', number: 0 }
  const part = head.slice(who.length)
  if (part === '' && field.name.includes(':')) return { text: '', number: 0 }
  let line = headerLine(text, who)
  const mapped =
    (part === 'name' && field.option === 'mailmap') ||
    (part === 'email' && field.words.has('mailmap'))
  if (mapped) line = mailmapped(line, ctx)
  if (part === '') return { text: firstLine(line), number: 0 }
  if (part === 'name') return { text: personName(line), number: 0 }
  if (part === 'email') return { text: personEmail(line, field.words), number: 0 }
  return dateValue(line, field, ctx)
}

/**
 * `parse_signed_buffer`: where the last signature block begins, the message's
 * length when it has none.
 */
function signatureStart(message: string): number {
  let found = message.length
  let start = 0
  while (start < message.length) {
    if (SIGNATURE_MARKERS.some((marker) => message.startsWith(marker, start))) found = start
    const end = message.indexOf('\n', start)
    start = end === -1 ? message.length : end + 1
  }
  return found
}

/**
 * `find_subpos`: where an object's subject, body and signature lie.
 *
 * @returns the message from the subject on, the subject paragraph, and where in
 *   the message the body and the signature start (the message's length when it
 *   is unsigned)
 */
export function messageParts(text: string): [string, string, number, number] {
  let cursor = 0
  while (cursor < text.length && text[cursor] !== '\n') {
    const end = text.indexOf('\n', cursor)
    cursor = end === -1 ? text.length : end + 1
  }
  while (cursor < text.length && text[cursor] === '\n') cursor += 1
  const message = text.slice(cursor)
  const sig = signatureStart(message)
  const ends = [message.indexOf('\n\n'), message.indexOf('\r\n\r\n')].filter((i) => i !== -1)
  const end = ends.length ? Math.min(ends[0] ?? 0, sig) : sig
  const subject = message.slice(0, end).replace(/[\r\n]+$/, '')
  let body = end
  while (body < message.length && (message[body] === '\r' || message[body] === '\n')) body += 1
  return [message, subject, body, sig]
}

/** `format_sanitized_subject`: a subject fit for a file name. */
function sanitized(subject: string): string {
  const out: string[] = []
  let space = 2
  for (let i = 0; i < subject.length; i++) {
    const char = subject[i] ?? ''
    if (TITLE_CHARS.test(char)) {
      if (space === 1) out.push('-')
      space = 0
      out.push(char)
      if (char === '.') while (subject[i + 1] === '.') i += 1
    } else {
      space |= 1
    }
  }
  return out.join('').replace(/[.-]+$/, '')
}

/** `append_lines`: the first lines of a message, continued lines indented. */
function linesOf(text: string, count: number): string {
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines.slice(0, count).join('\n    ')
}

/**
 * `grab_sub_body_contents`: a message field of a commit or tag. `%(body)` keeps
 * a tag's signature and `%(contents:body)` drops it; both are git's own, the
 * first kept for compatibility.
 */
function message(obj: RefObject, field: RefField): FieldValue {
  if (obj.type !== 'commit' && obj.type !== 'tag') return { text: '', number: 0 }
  const [all, subject, body, sig] = messageParts(textOf(obj))
  const option = field.field === 'body' ? 'signed-body' : field.option
  switch (option) {
    case 'subject':
      return { text: subject.replaceAll('\r\n', '\n').replaceAll('\n', ' '), number: 0 }
    case 'sanitize':
      return { text: sanitized(subject), number: 0 }
    case 'signed-body':
      return { text: all.slice(body), number: 0 }
    case 'body':
      return { text: all.slice(body, sig), number: 0 }
    case 'signature':
      return { text: all.slice(sig), number: 0 }
    case 'size': {
      const size = ENC.encode(all).length
      return { text: String(size), number: size }
    }
    case 'lines':
      return { text: linesOf(all.slice(0, sig), field.number), number: 0 }
    default:
      return { text: all, number: 0 }
  }
}

/** An id as `oid_atom_parser` asked for it. */
function abbreviated(field: RefField, oid: string, ctx: RefContext): string {
  if (field.option !== 'short' && field.option !== 'length') return oid
  const width = field.option === 'short' ? ctx.abbrev : field.number
  return oid.slice(0, Math.max(width, ctx.abbreviations.get(oid) ?? 0))
}

/**
 * The smallest requested width per object id, including peeled ids, trees
 * and parents, using the same field readers as rendering.
 */
export function abbreviationRequests(
  fields: readonly RefField[],
  items: readonly RefItem[],
  ctx: RefContext,
): Map<string, number> {
  const widths = new Map<string, number>()
  for (const atom of fields) {
    if (
      !['objectname', 'tree', 'parent'].includes(atom.field) ||
      !['short', 'length'].includes(atom.option)
    )
      continue
    const width = atom.option === 'short' ? ctx.abbrev : atom.number
    const full = { ...atom, option: '' }
    for (const item of items) {
      for (const oid of fieldValue(full, item, ctx).text.split(' ').filter(Boolean))
        widths.set(oid, Math.min(width, widths.get(oid) ?? oid.length))
    }
  }
  return widths
}

/** A field read off an object's type, size or content. */
function objectValue(obj: RefObject, field: RefField, ctx: RefContext): FieldValue {
  const head = field.field
  if (head === 'objecttype') return { text: obj.type, number: 0 }
  if (head === 'objectsize') return { text: String(obj.raw.length), number: obj.raw.length }
  if (head === 'objectname') return { text: abbreviated(field, obj.oid, ctx), number: 0 }
  if (head === 'raw') {
    if (field.option === 'size') return { text: String(obj.raw.length), number: obj.raw.length }
    return { text: textOf(obj), number: 0 }
  }
  const text = textOf(obj)
  if (obj.type === 'tag' && ['tag', 'type', 'object'].includes(head))
    return { text: firstLine(headerLine(text, head)), number: 0 }
  if (obj.type === 'commit' && head === 'tree')
    return { text: abbreviated(field, firstLine(headerLine(text, 'tree')), ctx), number: 0 }
  if (obj.type === 'commit' && head === 'parent')
    return {
      text: headerValues(text, 'parent')
        .map((parent) => abbreviated(field, parent, ctx))
        .join(' '),
      number: 0,
    }
  if (obj.type === 'commit' && head === 'numparent') {
    const count = headerValues(text, 'parent').length
    return { text: String(count), number: count }
  }
  if (head === 'subject' || head === 'body' || head === 'contents') return message(obj, field)
  if (PEOPLE.some((who) => head.startsWith(who)) || head.startsWith('creator'))
    return person(obj, field, ctx)
  return { text: '', number: 0 }
}

/**
 * `fill_remote_ref_details`: what an `upstream` field shows. Only a local
 * branch has an upstream, and only one whose merge ref maps to a ref shows
 * anything; the counts come from the loader.
 */
function upstreamText(field: RefField, item: RefItem, ctx: RefContext): string {
  const up = item.upstream
  if (up === null || !item.name.startsWith('refs/heads/')) return ''
  if (field.option === 'track') {
    let text = 'gone'
    if (!up.gone) {
      const parts: string[] = []
      if (up.ahead) parts.push(`ahead ${String(up.ahead)}`)
      if (up.behind) parts.push(`behind ${String(up.behind)}`)
      text = parts.join(', ')
    }
    return text && !field.words.has('nobracket') ? `[${text}]` : text
  }
  if (field.option === 'trackshort') {
    if (up.gone) return ''
    if (up.ahead && up.behind) return '<>'
    if (up.ahead) return '>'
    return up.behind ? '<' : '='
  }
  if (field.option === 'remotename') return up.remote
  if (field.option === 'remoteref') return up.merge
  return showRef(field.text, field.number, up.ref, ctx)
}

/**
 * One field's value for one ref, as git's `populate_value` fills it.
 *
 * @param field the parsed field
 * @param item the ref, with the objects its fields read
 * @param ctx the listing's facts
 */
export function fieldValue(field: RefField, item: RefItem, ctx: RefContext): FieldValue {
  const head = field.field
  const text = (value: string): FieldValue => ({ text: value, number: 0 })
  if (head === 'refname' || head === 'symref') {
    let name: string
    if (head === 'symref')
      name = item.symref ? showRef(field.option, field.number, item.symref, ctx) : ''
    else if (item.kind === RefKind.DETACHED) name = ctx.headDescription
    else name = showRef(field.option, field.number, item.name, ctx)
    return text(field.deref ? `${name}^{}` : name)
  }
  if (head === 'worktreepath') return text(item.kind === RefKind.BRANCH ? item.worktree : '')
  if (head === 'upstream') return text(upstreamText(field, item, ctx))
  if (head === 'HEAD') return text(ctx.head !== null && item.name === ctx.head ? '*' : ' ')
  if (head === 'if') {
    const body = field.deref ? field.name.slice(1) : field.name
    return text(body.startsWith('if:') ? body.slice(3) : '')
  }
  if (['align', 'end', 'then', 'else', 'rest'].includes(head)) return text('')
  if (head === 'objectname' && !field.deref) return text(abbreviated(field, item.oid, ctx))
  if (field.deref) {
    if (item.obj?.type !== 'tag' || item.peeled === null) return text('')
    return objectValue(item.peeled, field, ctx)
  }
  if (item.obj === null) return text('')
  return objectValue(item.obj, field, ctx)
}
