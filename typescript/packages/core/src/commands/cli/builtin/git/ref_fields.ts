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

import { decodeText, encodeText } from '../../../../shell/bytes.ts'
import { parseDateMode, showDate } from './dates.ts'
import { GitError, UnsupportedFieldError } from './errors.ts'
import { FULL_SHA } from './format.ts'
import { mappedIdentity } from './mailmap.ts'
import {
  RefKind,
  type FieldValue,
  type RefContext,
  type RefField,
  type RefItem,
  type RefObject,
} from './types.ts'
import { rstripChars } from '../../../../utils/text.ts'

/** The fewest hex digits an abbreviated id keeps, whatever width is asked. */
export const MINIMUM_ABBREV = 4
const INT_LIMIT = 2n ** 31n
const UINT_LIMIT = 2n ** 32n
// The prefixes and suffixes a short ref name is read under, in the order
// gitrevisions(7) lists them: the git directory, then refs/, tags, branches,
// remote-tracking branches and a remote's HEAD.
const SHORT_NAME_RULES: readonly (readonly [string, string])[] = [
  ['', ''],
  ['refs/', ''],
  ['refs/tags/', ''],
  ['refs/heads/', ''],
  ['refs/remotes/', ''],
  ['refs/remotes/', '/HEAD'],
]
// The lines a signature in a commit or tag message opens with.
const SIGNATURE_MARKERS = [
  '-----BEGIN PGP SIGNATURE-----',
  '-----BEGIN PGP MESSAGE-----',
  '-----BEGIN SSH SIGNATURE-----',
  '-----BEGIN SIGNED MESSAGE-----',
]
const PEELED_SUFFIX = '^{}'
// git's fields this build refuses rather than renders: what a ref's storage
// says (deltabase, objectsize:disk, flag), a walk or a signature check
// (describe, ahead-behind, is-base, signature), push configuration, trailer
// parsing and colour.
const UNSUPPORTED = [
  'ahead-behind',
  'color',
  'deltabase',
  'describe',
  'flag',
  'is-base',
  'push',
  'signature',
  'trailers',
]
const IDENT_ROLES = ['author', 'committer', 'tagger']
const NAME_FIELDS = ['refname', 'symref']
const PERSON_ROLES = [...IDENT_ROLES, 'creator']
const ID_FIELDS = ['objectname', 'tree', 'parent']
const ALIGN_POSITIONS = ['left', 'middle', 'right']
const TRACK_WORDS = ['track', 'trackshort', 'remotename', 'remoteref']
const EMAIL_WORDS = ['trim', 'localpart', 'mailmap']
const REF_FIELDS = new Set(['HEAD', 'worktreepath', 'upstream', ...NAME_FIELDS])
const MESSAGE_FIELDS = new Set(['subject', 'body', 'contents'])
const OBJECTLESS = new Set([
  'refname',
  'symref',
  'upstream',
  'worktreepath',
  'HEAD',
  'objectname',
  'align',
  'if',
  'then',
  'else',
  'end',
])

function field(text: string, name: string, deref: boolean, argument: string | null): RefField {
  return { text, name, deref, argument, variant: '', count: 0, options: new Set(), date: null }
}

function withField(base: RefField, change: Partial<RefField>): RefField {
  return { ...base, ...change }
}

/**
 * A decimal integer as a C `int` reads it: leading white space and a sign
 * allowed, nothing after the digits, nothing past 32 bits.
 */
export function cInt(text: string): number | null {
  const found = /^[ \t\n\v\f\r]*([+-]?[0-9]+)$/.exec(text)
  if (found === null) return null
  const value = BigInt(found[1] ?? '')
  return value >= -INT_LIMIT && value < INT_LIMIT ? Number(value) : null
}

/**
 * A count as a C `unsigned` reads it, a minus refused: past 31 bits it comes
 * back negative, as the `int` it is stored in reads.
 */
export function cUint(text: string): number | null {
  const found = /^[ \t\n\v\f\r]*\+?([0-9]+)$/.exec(text)
  if (found === null) return null
  const value = BigInt(found[1] ?? '')
  if (value >= UINT_LIMIT) return null
  return Number(value >= INT_LIMIT ? value - UINT_LIMIT : value)
}

/**
 * How an argument refusal names its field: with the `*` for a name, an id or
 * a person field, without it for the rest.
 */
function label(f: RefField): string {
  const starred =
    [...NAME_FIELDS, 'upstream', 'push', ...ID_FIELDS].includes(f.name) ||
    f.name.endsWith('name') ||
    f.name.endsWith('email')
  return f.deref && starred ? `*${f.name}` : f.name
}

function unrecognized(f: RefField, argument: string): GitError {
  return new GitError(`unrecognized %(${label(f)}) argument: ${argument}`)
}

function argumentsRefused(f: RefField): void {
  if (f.argument) throw new GitError(`%(${f.name}) does not take arguments`)
}

/** `short`, `lstrip=<n>` (`strip=<n>`) or `rstrip=<n>`. */
function nameVariant(f: RefField, argument: string): RefField {
  if (argument === 'short') return withField(f, { variant: 'short' })
  for (const [prefix, variant] of [
    ['lstrip=', 'lstrip'],
    ['strip=', 'lstrip'],
    ['rstrip=', 'rstrip'],
  ] as const) {
    if (argument.startsWith(prefix)) {
      const value = argument.slice(prefix.length)
      const count = cInt(value)
      if (count === null) throw new GitError(`Integer value expected refname:${variant}=${value}`)
      return withField(f, { variant, count })
    }
  }
  throw unrecognized(f, argument)
}

function parseName(f: RefField): RefField {
  return f.argument ? nameVariant(f, f.argument) : f
}

/**
 * Each of `track`, `trackshort`, `remotename` and `remoteref` replaces the
 * one before it and `nobracket` is a switch; any other word makes the whole
 * argument one name variant.
 */
function parseUpstream(f: RefField): RefField {
  const argument = f.argument
  if (!argument) return f
  let variant = ''
  const options = new Set<string>()
  for (const word of argument.split(',')) {
    if (TRACK_WORDS.includes(word)) variant = word
    else if (word === 'nobracket') options.add(word)
    else return nameVariant(f, argument)
  }
  return withField(f, { variant, options })
}

function parseId(f: RefField): RefField {
  const argument = f.argument
  if (!argument) return f
  if (argument === 'short') return withField(f, { variant: 'short', count: 0 })
  if (argument.startsWith('short=')) {
    const value = argument.slice('short='.length)
    const width = cUint(value)
    if (width === null || width === 0) {
      throw new GitError(`positive value expected '${value}' in %(${f.text})`)
    }
    // A width past 31 bits wraps negative and reads as plain short.
    return withField(f, { variant: 'short', count: Math.max(width, 0) })
  }
  throw unrecognized(f, argument)
}

function parseObjectsize(f: RefField): RefField {
  if (!f.argument) return f
  if (f.argument === 'disk') throw new UnsupportedFieldError(f.text)
  throw new GitError(`unrecognized %(objectsize) argument: ${f.argument}`)
}

function parseRaw(f: RefField): RefField {
  if (!f.argument) return f
  if (f.argument === 'size') return withField(f, { variant: 'size' })
  throw new GitError(`unrecognized %(raw) argument: ${f.argument}`)
}

function parseRest(f: RefField): RefField {
  argumentsRefused(f)
  throw new GitError(`this command reject atom %(${f.text})`)
}

function parseBare(f: RefField): RefField {
  argumentsRefused(f)
  return f
}

/** `body` refuses an argument, and prints nothing at all after an empty one. */
function parseBody(f: RefField): RefField {
  argumentsRefused(f)
  return f.argument === null ? f : withField(f, { variant: 'blank' })
}

function parseIgnoring(f: RefField): RefField {
  return withField(f, { argument: null })
}

/**
 * `author`, `committer` and `tagger` print nothing at all once they have a
 * colon, whatever follows it.
 */
function parsePerson(f: RefField): RefField {
  return f.argument !== null ? withField(f, { variant: 'blank' }) : f
}

function parsePersonName(f: RefField): RefField {
  if (!f.argument) return f
  if (f.argument === 'mailmap') return withField(f, { options: new Set(['mailmap']) })
  throw unrecognized(f, f.argument)
}

/**
 * A comma list of `trim`, `localpart` and `mailmap`, each word read off the
 * front of what is left; the refusal names that rest.
 */
function parseEmail(f: RefField): RefField {
  let rest = f.argument
  if (!rest) return f
  const options = new Set<string>()
  for (;;) {
    const word = EMAIL_WORDS.find((w) => rest?.startsWith(w))
    if (word === undefined) throw unrecognized(f, rest)
    options.add(word)
    rest = rest.slice(word.length)
    if (!rest) break
    if (!rest.startsWith(',')) throw unrecognized(f, rest)
    rest = rest.slice(1)
  }
  return withField(f, { options })
}

function parseDate(f: RefField): RefField {
  // The style is checked where a date is shown, so a listing whose refs
  // carry no such date never refuses it.
  return withField(f, { date: f.argument })
}

function parseSubject(f: RefField): RefField {
  if (!f.argument) return f
  if (f.argument === 'sanitize') return withField(f, { variant: 'sanitize' })
  throw new GitError(`unrecognized %(subject) argument: ${f.argument}`)
}

function parseContents(f: RefField): RefField {
  const argument = f.argument
  if (!argument) return f
  if (['subject', 'body', 'signature', 'size'].includes(argument)) {
    return withField(f, { variant: argument })
  }
  if (argument === 'trailers' || argument.startsWith('trailers:')) {
    throw new UnsupportedFieldError(f.text)
  }
  if (argument.startsWith('lines=')) {
    const count = cUint(argument.slice('lines='.length))
    if (count === null) throw new GitError(`positive value expected contents:${argument}`)
    return withField(f, { variant: 'lines', count: Math.max(count, 0) })
  }
  throw new GitError(`unrecognized %(contents) argument: ${argument}`)
}

function alignWidth(text: string): number | null {
  const value = cUint(text)
  return value === null || value < 0 ? null : value
}

/** `<width>` and `<position>` in either order, by name or bare, the last of each winning. */
function parseAlign(f: RefField): RefField {
  if (!f.argument) throw new GitError('expected format: %(align:<width>,<position>)')
  let width: number | null = null
  let position = 'left'
  for (const word of f.argument.split(',')) {
    if (word.startsWith('position=')) {
      const value = word.slice('position='.length)
      if (!ALIGN_POSITIONS.includes(value)) throw new GitError(`unrecognized position:${value}`)
      position = value
    } else if (word.startsWith('width=')) {
      const value = word.slice('width='.length)
      width = alignWidth(value)
      if (width === null) throw new GitError(`unrecognized width:${value}`)
    } else if (ALIGN_POSITIONS.includes(word)) {
      position = word
    } else {
      const found = alignWidth(word)
      if (found === null) throw new GitError(`unrecognized %(align) argument: ${word}`)
      width = found
    }
  }
  if (width === null) throw new GitError('positive width expected with the %(align) atom')
  return withField(f, { variant: position, count: width })
}

function parseIf(f: RefField): RefField {
  const argument = f.argument
  if (!argument) return withField(f, { argument: null })
  for (const word of ['equals', 'notequals']) {
    if (argument.startsWith(`${word}=`)) return withField(f, { variant: word })
  }
  throw new GitError(`unrecognized %(if) argument: ${argument}`)
}

/**
 * A field this build does not render, refused as unsupported once git would
 * accept its argument; an argument git refuses is refused in git's words
 * first.
 */
function parseUnsupported(f: RefField): RefField {
  const name = f.name
  if (name === 'deltabase') {
    argumentsRefused(f)
  } else if (name === 'is-base' || name === 'ahead-behind') {
    if (!f.argument) throw new GitError(`expected format: %(${name}:<committish>)`)
  } else if (name === 'color') {
    if (!f.argument) throw new GitError('expected format: %(color:<color>)')
  } else if (name === 'push') {
    parseUpstream(f)
  }
  throw new UnsupportedFieldError(f.text)
}

const PARSERS = new Map<string, (f: RefField) => RefField>([
  ['refname', parseName],
  ['symref', parseName],
  ['upstream', parseUpstream],
  ['worktreepath', parseIgnoring],
  ['HEAD', parseBare],
  ['objecttype', parseBare],
  ['objectsize', parseObjectsize],
  ['objectname', parseId],
  ['tree', parseId],
  ['parent', parseId],
  ['numparent', parseIgnoring],
  ['object', parseIgnoring],
  ['type', parseIgnoring],
  ['tag', parseIgnoring],
  ['raw', parseRaw],
  ['rest', parseRest],
  ['creator', parseIgnoring],
  ['creatordate', parseDate],
  ['subject', parseSubject],
  ['body', parseBody],
  ['contents', parseContents],
  ['align', parseAlign],
  ['if', parseIf],
  ['then', parseIgnoring],
  ['else', parseIgnoring],
  ['end', parseIgnoring],
  ...UNSUPPORTED.map((name) => [name, parseUnsupported] as const),
  ...IDENT_ROLES.flatMap((role) => [
    [role, parsePerson] as const,
    [`${role}name`, parsePersonName] as const,
    [`${role}email`, parseEmail] as const,
    [`${role}date`, parseDate] as const,
  ]),
])

/**
 * Read one field as a format's `%(...)` or a sort key spells it.
 *
 * @throws GitError a name git does not have, or an argument it refuses
 * @throws UnsupportedFieldError a field git has that this build does not render
 */
export function parseField(text: string): RefField {
  const deref = text.startsWith('*')
  const body = deref ? text.slice(1) : text
  const colon = body.indexOf(':')
  const name = colon === -1 ? body : body.slice(0, colon)
  if (!name && colon === -1) throw new GitError(`malformed field name: ${text}`)
  const parser = PARSERS.get(name)
  if (parser === undefined) throw new GitError(`unknown field name: ${text}`)
  return parser(field(text, name, deref, colon === -1 ? null : body.slice(colon + 1)))
}

/** Whether a field reads the ref's object, not only its name. */
export function needsObject(f: RefField): boolean {
  return !OBJECTLESS.has(f.name) || (f.deref && f.name === 'objectname')
}

/**
 * The shortest name that still reads back as `name`. Each way of spelling a
 * short name, most specific first, gives a candidate; one is taken when no
 * other way (`strict`), or no way rev-parse tries before it (loose), turns it
 * into another ref that exists.
 */
export function shortenRef(name: string, known: ReadonlySet<string>, strict = true): string {
  for (let at = SHORT_NAME_RULES.length - 1; at > 0; at--) {
    const [prefix, suffix] = SHORT_NAME_RULES[at] ?? ['', '']
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue
    const short = name.slice(prefix.length, name.length - suffix.length)
    if (!short) continue
    const rivals = strict ? SHORT_NAME_RULES : SHORT_NAME_RULES.slice(0, at)
    const taken = rivals.some(([p, s], i) => {
      const spelled = `${p}${short}${s}`
      return i !== at && spelled !== name && known.has(spelled)
    })
    if (!taken) return short
  }
  return name
}

/**
 * `name` less `count` components from the front; a negative count keeps that
 * many from the back instead.
 */
export function lstripRef(name: string, count: number): string {
  const parts = name.split('/')
  if (count < 0) return parts.slice(Math.max(parts.length + count, 0)).join('/')
  return count < parts.length ? parts.slice(count).join('/') : ''
}

/**
 * `name` less `count` components from the back; a negative count keeps that
 * many from the front instead.
 */
export function rstripRef(name: string, count: number): string {
  const parts = name.split('/')
  if (count < 0) return -count < parts.length ? parts.slice(0, -count).join('/') : name
  return count < parts.length ? parts.slice(0, parts.length - count).join('/') : ''
}

function nameText(f: RefField, name: string, ctx: RefContext): string {
  if (f.variant === 'short') return shortenRef(name, ctx.known, ctx.strict)
  if (f.variant === 'lstrip') return lstripRef(name, f.count)
  if (f.variant === 'rstrip') return rstripRef(name, f.count)
  return name
}

/**
 * The instant and offset an identity line records: the seconds since the
 * epoch and the offset in minutes east of UTC, null when the line has no date
 * after its email. The date follows the email's `>` and a space: seconds, then
 * an optional `+hhmm` offset.
 */
export function identDate(ident: string): [number, number] | null {
  const close = ident.lastIndexOf('>')
  if (close === -1) return null
  const found = /^ +([0-9]+)(?: +([+-])([0-9]{2})([0-9]{2}))?/.exec(ident.slice(close + 1))
  if (found === null) return null
  const seconds = Number(found[1])
  if (found[2] === undefined) return [seconds, 0]
  const offset = Number(found[3]) * 60 + Number(found[4])
  return [seconds, found[2] === '-' ? -offset : offset]
}

interface Parsed {
  readonly headers: readonly (readonly [string, string])[]
  readonly message: string
  readonly messageBytes: number
}

const PARSED = new WeakMap<RefObject, Parsed>()

/** An object's header lines and its message. */
function headers(obj: RefObject): Parsed {
  const cached = PARSED.get(obj)
  if (cached !== undefined) return cached
  const text = decodeText(obj.raw)
  const gap = text.indexOf('\n\n')
  let head = gap === -1 ? text : text.slice(0, gap)
  if (gap === -1 && text.endsWith('\n')) head = text.slice(0, -1)
  const message = gap === -1 ? '' : text.slice(gap + 2)
  const headers: [string, string][] = []
  for (const line of head.split('\n')) {
    if (!line || line.startsWith(' ')) continue
    const space = line.indexOf(' ')
    headers.push(space === -1 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)])
  }
  const result = { headers, message, messageBytes: encodeText(message).length }
  PARSED.set(obj, result)
  return result
}

function header(obj: RefObject, key: string): string | null {
  return headers(obj).headers.find(([k]) => k === key)?.[1] ?? null
}

/** Where the last signature line starts, the message's length when no line opens one. */
function signatureAt(message: string): number {
  let at = message.length
  let start = 0
  while (start < message.length) {
    const end = message.indexOf('\n', start)
    if (SIGNATURE_MARKERS.some((marker) => message.startsWith(marker, start))) at = start
    start = end === -1 ? message.length : end + 1
  }
  return at
}

function blank(line: string): boolean {
  return line === '' || line === '\r'
}

function lineEnd(message: string, at: number, sig: number): number {
  const end = message.indexOf('\n', at)
  return end === -1 || end >= sig ? -1 : end
}

/**
 * Split a message as the message fields read it: where the subject starts,
 * the subject, where the body starts and where the signature starts. The
 * subject is the first paragraph after any empty lines, its lines joined with
 * spaces (a carriage return before each newline dropped); the body starts at
 * the next line that is not empty. A signature cuts both short where its line
 * starts.
 */
export function messageParts(message: string): [number, string, number, number] {
  const sig = signatureAt(message)
  let at = 0
  while (at < sig) {
    const end = lineEnd(message, at, sig)
    if (end === -1 || !blank(message.slice(at, end))) break
    at = end + 1
  }
  const start = at
  const lines: string[] = []
  while (at < sig) {
    const end = lineEnd(message, at, sig)
    const line = message.slice(at, end === -1 ? sig : end)
    if (blank(line)) break
    lines.push(line.endsWith('\r') ? line.slice(0, -1) : line)
    at = end === -1 ? sig : end + 1
  }
  while (at < sig) {
    const end = lineEnd(message, at, sig)
    if (end === -1 || !blank(message.slice(at, end))) break
    at = end + 1
  }
  return [start, lines.join(' '), at, sig]
}

function titleChar(ch: string): boolean {
  return /^[A-Za-z0-9._]$/.test(ch)
}

/**
 * A subject as a file name: letters, digits, `.` and `_` kept, each run of
 * anything else one `-` between them, a run of dots one dot, and trailing dots
 * and dashes dropped.
 */
export function sanitizeSubject(subject: string): string {
  const out: string[] = []
  let gap = false
  for (const ch of subject) {
    if (titleChar(ch)) {
      if (gap && out.length) out.push('-')
      gap = false
      if (ch === '.' && out[out.length - 1] === '.') continue
      out.push(ch)
    } else {
      gap = true
    }
  }
  return rstripChars(out.join(''), '.-')
}

/** `contents:lines=<n>`: the first lines from the subject on, each after the first indented four spaces. */
function messageLines(message: string, start: number, sig: number, count: number): string {
  const lines: string[] = []
  let at = start
  while (at < sig && lines.length < count) {
    const end = lineEnd(message, at, sig)
    lines.push(message.slice(at, end === -1 ? sig : end))
    at = end === -1 ? sig : end + 1
  }
  return lines.join('\n    ')
}

function requestedWidth(f: RefField, ctx: RefContext): number {
  return Math.min(Math.max(f.count || ctx.abbrev, MINIMUM_ABBREV), FULL_SHA)
}

function abbreviated(f: RefField, oid: string, ctx: RefContext): string {
  if (f.variant !== 'short') return oid
  const width = requestedWidth(f, ctx)
  return oid.slice(0, Math.max(width, ctx.abbreviations.get(oid) ?? width))
}

function shownObject(f: RefField, item: RefItem): RefObject | null {
  return f.deref ? item.peeled : item.obj
}

/** The ids an id field shows for a ref. */
function ids(f: RefField, item: RefItem): string[] {
  if (f.name === 'objectname') {
    if (f.deref) return item.peeled !== null ? [item.peeled.oid] : []
    return [item.oid]
  }
  const obj = shownObject(f, item)
  if (obj?.type !== 'commit') return []
  return headers(obj)
    .headers.filter(([k]) => k === f.name)
    .map(([, v]) => v)
}

/**
 * The ids a listing abbreviates, each at the narrowest width any of its fields
 * asks, for one pass that widens them to be unique.
 */
export function abbreviationRequests(
  fields: readonly RefField[],
  items: readonly RefItem[],
  ctx: RefContext,
): Map<string, number> {
  const widths = new Map<string, number>()
  for (const f of fields) {
    if (!ID_FIELDS.includes(f.name) || f.variant !== 'short') continue
    const width = requestedWidth(f, ctx)
    for (const item of items) {
      for (const oid of ids(f, item)) widths.set(oid, Math.min(widths.get(oid) ?? width, width))
    }
  }
  return widths
}

function upstreamText(f: RefField, item: RefItem, ctx: RefContext): string {
  const up = item.upstream
  if (up === null || item.kind !== RefKind.BRANCH) return ''
  if (f.variant === 'remotename') return up.remote
  if (f.variant === 'remoteref') return up.merge
  if (f.variant === 'trackshort') {
    if (up.gone) return ''
    if (up.ahead && up.behind) return '<>'
    return up.ahead ? '>' : up.behind ? '<' : '='
  }
  if (f.variant === 'track') {
    const state = up.gone
      ? 'gone'
      : [
          ['ahead', up.ahead],
          ['behind', up.behind],
        ]
          .filter(([, count]) => count)
          .map(([word, count]) => `${String(word)} ${String(count)}`)
          .join(', ')
    if (!state) return ''
    return f.options.has('nobracket') ? state : `[${state}]`
  }
  return nameText(f, up.ref, ctx)
}

function personRole(name: string): [string, string] {
  for (const role of PERSON_ROLES) {
    if (name.startsWith(role)) return [role, name.slice(role.length)]
  }
  return [name, '']
}

/**
 * The identity line a person field reads, null when the object has none:
 * `creator` is a commit's committer and a tag's tagger.
 */
function person(obj: RefObject | null, role: string): string | null {
  if (obj === null || (obj.type !== 'commit' && obj.type !== 'tag')) return null
  const key = role === 'creator' ? (obj.type === 'commit' ? 'committer' : 'tagger') : role
  return header(obj, key)
}

/**
 * An identity's name and its email, brackets included: the name is what
 * comes before the space ahead of `<`, empty without one.
 */
function splitIdent(ident: string): [string, string] {
  const space = ident.indexOf(' <')
  const name = space !== -1 ? ident.slice(0, space) : ''
  const lt = ident.indexOf('<')
  if (lt === -1) return [name, '']
  const gt = ident.indexOf('>', lt)
  return [name, gt === -1 ? ident.slice(lt) : ident.slice(lt, gt + 1)]
}

function mapped(ident: string, ctx: RefContext): [string, string] {
  const [name, email] = splitIdent(ident)
  if (!ctx.mailmap.length) return [name, email]
  return splitIdent(mappedIdentity(`${name} ${email}`, ctx.mailmap))
}

function value(text: string, number: number | null = null): FieldValue {
  return { text, number }
}

function personValue(f: RefField, item: RefItem, ctx: RefContext): FieldValue {
  const [role, part] = personRole(f.name)
  const ident = person(shownObject(f, item), role)
  if (ident === null) return value('', part === 'date' ? 0 : null)
  if (part === '') return value(f.variant === 'blank' ? '' : ident)
  if (part === 'date') {
    const mode = f.date === null ? ctx.date : parseDateMode(f.date, ctx.date)
    const found = identDate(ident)
    if (found === null) return value('', 0)
    const [seconds, offset] = found
    return value(showDate(seconds, offset, mode), seconds)
  }
  const [name, email] = f.options.has('mailmap') ? mapped(ident, ctx) : splitIdent(ident)
  if (part === 'name') return value(name)
  let shown = email
  if (f.options.has('trim') || f.options.has('localpart')) {
    shown = shown.replace(/^</, '').replace(/>$/, '')
    if (f.options.has('localpart')) shown = shown.split('@')[0] ?? ''
  }
  return value(shown)
}

function messageValue(f: RefField, item: RefItem): FieldValue {
  const obj = shownObject(f, item)
  if (obj === null || (obj.type !== 'commit' && obj.type !== 'tag')) {
    // A size nothing has is nothing to print, and 0 to sort by.
    return value('', f.variant === 'size' ? 0 : null)
  }
  const { message, messageBytes } = headers(obj)
  const [start, subject, body, sig] = messageParts(message)
  const variant = f.variant
  if (f.name === 'subject' || variant === 'subject') {
    return value(variant === 'sanitize' ? sanitizeSubject(subject) : subject)
  }
  if (f.name === 'body') return value(variant === 'blank' ? '' : message.slice(body))
  if (variant === 'body') return value(message.slice(body, sig))
  if (variant === 'signature') return value(message.slice(sig))
  // The contents start at the subject: empty lines before it are no part of
  // them, each one byte.
  if (variant === 'size') return value(String(messageBytes - start), messageBytes - start)
  if (variant === 'lines') return value(messageLines(message, start, sig, f.count))
  return value(message.slice(start))
}

function objectValue(f: RefField, item: RefItem, ctx: RefContext): FieldValue {
  const name = f.name
  if (ID_FIELDS.includes(name)) {
    return value(
      ids(f, item)
        .map((oid) => abbreviated(f, oid, ctx))
        .join(' '),
    )
  }
  const obj = shownObject(f, item)
  if (obj === null) {
    const counted = name === 'objectsize' || name === 'numparent' || f.variant === 'size'
    return value('', counted ? 0 : null)
  }
  if (name === 'objecttype') return value(obj.type)
  if (name === 'objectsize') return value(String(obj.raw.length), obj.raw.length)
  if (name === 'raw') {
    if (f.variant === 'size') return value(String(obj.raw.length), obj.raw.length)
    return value(decodeText(obj.raw))
  }
  if (name === 'numparent') {
    if (obj.type !== 'commit') return value('', 0)
    const count = headers(obj).headers.filter(([k]) => k === 'parent').length
    return value(String(count), count)
  }
  if (obj.type !== 'tag') return value('')
  return value(header(obj, name) ?? '')
}

function refValue(f: RefField, item: RefItem, ctx: RefContext): FieldValue {
  const name = f.name
  if (name === 'HEAD') return value(item.name === ctx.head ? '*' : ' ')
  if (name === 'worktreepath') return value(item.worktree)
  if (name === 'upstream') return value(upstreamText(f, item, ctx))
  let text: string
  if (item.kind === RefKind.DETACHED && name === 'refname') text = ctx.headDescription
  else if (name === 'symref') text = item.symref ? nameText(f, item.symref, ctx) : ''
  else text = nameText(f, item.name, ctx)
  return value(f.deref ? `${text}${PEELED_SUFFIX}` : text)
}

/**
 * What one field prints for one ref, and what it sorts by.
 *
 * @throws GitError a date style git does not have, met on a date
 */
export function fieldValue(f: RefField, item: RefItem, ctx: RefContext): FieldValue {
  if (REF_FIELDS.has(f.name)) return refValue(f, item, ctx)
  if (MESSAGE_FIELDS.has(f.name)) return messageValue(f, item)
  if (PERSON_ROLES.includes(personRole(f.name)[0])) return personValue(f, item, ctx)
  return objectValue(f, item, ctx)
}

/** Whether a listing reads the mailmap. */
export function mailmapped(fields: readonly RefField[]): boolean {
  return fields.some((f) => f.options.has('mailmap'))
}
