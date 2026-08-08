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
import { BadPrettyError, UnsupportedPrettyError } from './errors.ts'

const SHORT_SHA = 7
export const FULL_SHA = 40
const INDENT = '    '
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/** A commit as far as rendering is concerned, whoever read it. */
export interface CommitFacts {
  readonly oid: string
  readonly tree: string
  readonly message: string
  readonly authorName: string
  readonly authorEmail: string
  /** Seconds since the epoch. */
  readonly authorTime: number
  /** The author's UTC offset in minutes, git's own sign convention. */
  readonly authorTimezoneMinutes: number
  readonly committerName: string
  readonly committerEmail: string
  readonly committerTime: number
  readonly committerTimezoneMinutes: number
  readonly parents: readonly string[]
}

// The presets this build renders, and the real git presets it refuses by
// name rather than calling invalid.
const PRESET_KINDS = ['oneline', 'short', 'medium', 'full', 'fuller']
const UNSUPPORTED_PRESETS = ['raw', 'email', 'mboxrd', 'reference']
const HEX_DIGITS = /[0-9a-fA-F]/

/** Ref labels per commit id, for %d/%D. */
export type Decorations = ReadonlyMap<string, readonly string[]>

/**
 * The parsed value of `--pretty`/`--format`.
 *
 * `kind` is a preset name, or `format`/`tformat` for a placeholder template:
 * `format` separates entries with a newline while `tformat` terminates each
 * with one, and is what a bare `%` string means.
 */
export interface LogFormat {
  readonly kind: string
  readonly template: string | null
}

export const MEDIUM: LogFormat = { kind: 'medium', template: null }

/**
 * Read a --pretty/--format value the way git's pretty.c does.
 *
 * @throws UnsupportedPrettyError for a real git preset this build lacks
 * @throws BadPrettyError for a name git itself would refuse
 */
export function parsePretty(value: string): LogFormat {
  if (value.startsWith('format:')) return { kind: 'format', template: value.slice(7) }
  if (value.startsWith('tformat:')) return { kind: 'tformat', template: value.slice(8) }
  // A bare % string is tformat; so is the empty string, which renders
  // every commit as nothing and therefore prints nothing at all.
  if (value.includes('%') || value === '') return { kind: 'tformat', template: value }
  if (PRESET_KINDS.includes(value)) return { kind: value, template: null }
  if (UNSUPPORTED_PRESETS.includes(value)) throw new UnsupportedPrettyError(value)
  throw new BadPrettyError(value)
}

/**
 * Whether rendering this format has to know the refs.
 *
 * Only `%d`/`%D` read them; git turns decorations off for piped preset
 * output, which is the only output mirage produces.
 */
export function needsDecorations(fmt: LogFormat): boolean {
  if (fmt.template === null) return false
  let cursor = 0
  for (;;) {
    cursor = fmt.template.indexOf('%', cursor)
    if (cursor === -1 || cursor + 1 === fmt.template.length) return false
    const marker = fmt.template[cursor + 1]
    if (marker === 'd' || marker === 'D') return true
    cursor += 2
  }
}

/**
 * How many hex digits an abbreviated id needs in a repository.
 *
 * git widens the abbreviation as a repository grows, so `--oneline` on a large
 * repository prints nine characters where a fresh one prints seven, and a build
 * that always printed seven disagreed with real git on every line of every big
 * repository.
 *
 * Measured against git 2.50.1 rather than read off its source, and the boundary
 * is sharp: 16,383 packed objects abbreviate to 7 and 16,384 to 8, which is one
 * hex digit per two bits of object count, floored at git's seven. Confirmed
 * again at 20,102 (8), 70,102 (9) and 184,401 (9).
 *
 * Only packed objects count. The same 70,102 objects abbreviate to 7 while loose
 * and to 9 once packed, which is consistent with it being an estimate: a pack
 * index states its object count in its header, while counting loose objects
 * means walking 256 directories.
 *
 * @param packed how many objects the repository's packs hold
 */
export function abbrevLength(packed: number): number {
  const bits = packed <= 0 ? 0 : Math.floor(Math.log2(packed)) + 1
  return Math.max(SHORT_SHA, Math.ceil(bits / 2))
}

/**
 * Abbreviate an object id the way `--oneline` prints it.
 *
 * @param sha hex object id
 * @param length how many hex digits to keep, from abbrevLength
 */
export function short(sha: string, length: number = SHORT_SHA): string {
  return sha.slice(0, length)
}

/**
 * Render a commit time in git's default date format.
 *
 * `Fri Jan 16 11:30:00 2026 +0000`: the day of the month is not padded, which is
 * why this is built by hand. The stored offset is minutes east of UTC and the
 * timestamp is read in that offset, so a commit prints the wall clock its author
 * saw.
 *
 * @param timestamp seconds since the epoch
 * @param offsetMinutes the author's UTC offset in minutes
 */
function gitDate(timestamp: number, offsetMinutes: number): string {
  const shifted = new Date((timestamp + offsetMinutes * 60) * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const hours = Math.floor(Math.abs(offsetMinutes) / 60)
  const minutes = Math.abs(offsetMinutes) % 60
  const day = DAYS[shifted.getUTCDay()] ?? ''
  const month = MONTHS[shifted.getUTCMonth()] ?? ''
  return (
    `${day} ${month} ${String(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:` +
    `${pad(shifted.getUTCSeconds())} ${String(shifted.getUTCFullYear())} ` +
    `${sign}${pad(hours)}${pad(minutes)}`
  )
}

/** The first line of a commit message. */
function subject(commit: CommitFacts): string {
  return (commit.message.split('\n', 1)[0] ?? '').replace(/\s+$/, '')
}

/**
 * One `--oneline` row: abbreviated id then subject.
 *
 * @param commit the commit to render
 * @param length how many hex digits of the id to print
 */
export function oneline(commit: CommitFacts, length: number = SHORT_SHA): string {
  return `${short(commit.oid, length)} ${subject(commit)}`
}

/**
 * A commit message indented the way log and show print it.
 *
 * Every line is indented by four spaces, blank lines included, so an empty line
 * inside a message renders as four spaces rather than as an empty one. Verified
 * against git 2.47.3; it is trailing whitespace on purpose.
 */
function messageBlock(commit: CommitFacts): string[] {
  return commit.message
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => `${INDENT}${line}`)
}

/**
 * A full log entry: the header block and the indented message.
 *
 * A merge carries an extra `Merge:` line naming its parents in abbreviated form,
 * which git prints between the id and the author for both `log` and `show`.
 *
 * @param commit the commit to render
 * @param length how many hex digits of a parent id to print
 */
function entry(commit: CommitFacts, length: number = SHORT_SHA): string[] {
  const lines = [`commit ${commit.oid}`]
  if (commit.parents.length > 1) {
    lines.push(`Merge: ${commit.parents.map((p) => short(p, length)).join(' ')}`)
  }
  lines.push(
    `Author: ${commit.authorName} <${commit.authorEmail}>`,
    `Date:   ${gitDate(commit.authorTime, commit.authorTimezoneMinutes)}`,
    '',
    ...messageBlock(commit),
  )
  return lines
}

/** The `Merge:` line every block preset prints for a merge. */
function mergeLine(commit: CommitFacts, length: number): string[] {
  if (commit.parents.length <= 1) return []
  return [`Merge: ${commit.parents.map((p) => short(p, length)).join(' ')}`]
}

/**
 * One commit as a block preset renders it (short/medium/full/fuller).
 *
 * Pinned against git 2.50: `short` is the id, author and indented subject;
 * `full` adds `Commit:` and drops both dates; `fuller` aligns four header
 * lines to the `AuthorDate:` column.
 */
export function presetBlock(commit: CommitFacts, kind: string, length: number): string[] {
  if (kind === 'medium') return entry(commit, length)
  const author = `${commit.authorName} <${commit.authorEmail}>`
  const committer = `${commit.committerName} <${commit.committerEmail}>`
  const lines = [`commit ${commit.oid}`, ...mergeLine(commit, length)]
  if (kind === 'short') {
    lines.push(`Author: ${author}`, '', `${INDENT}${subject(commit)}`)
    return lines
  }
  if (kind === 'full') {
    lines.push(`Author: ${author}`, `Commit: ${committer}`, '', ...messageBlock(commit))
    return lines
  }
  lines.push(
    `Author:     ${author}`,
    `AuthorDate: ${gitDate(commit.authorTime, commit.authorTimezoneMinutes)}`,
    `Commit:     ${committer}`,
    `CommitDate: ${gitDate(commit.committerTime, commit.committerTimezoneMinutes)}`,
    '',
    ...messageBlock(commit),
  )
  return lines
}

/** git's %s: the first paragraph folded onto one line. */
function subjectFolded(message: string): string {
  const head = message.split('\n\n', 1)[0] ?? ''
  return head
    .split('\n')
    .filter((part) => part !== '')
    .join(' ')
    .trim()
}

/** git's %b: everything after the subject paragraph. */
function body(message: string): string {
  const separator = message.indexOf('\n\n')
  return separator === -1 ? '' : message.slice(separator + 2)
}

/**
 * Expand a format:/tformat: template for one commit.
 *
 * The scan mirrors git's pretty.c behavior pinned in docker: an unknown or
 * incomplete placeholder stays verbatim (`%q` prints `%q`), `%%` is a literal
 * percent, and `%xHH` names a raw output byte (`%x80` is the single byte
 * 0x80, carried by the shell's byte-escape convention until `encodeText`
 * writes it). Explicit cursor, one pass, like the stat -c engine.
 */
export function renderTemplate(
  template: string,
  commit: CommitFacts,
  length: number,
  decor: Decorations | null,
): string {
  const labels = decor?.get(commit.oid) ?? []
  const out: string[] = []
  let i = 0
  while (i < template.length) {
    const char = template[i] ?? ''
    if (char !== '%' || i + 1 === template.length) {
      out.push(char)
      i += 1
      continue
    }
    const marker = template[i + 1] ?? ''
    const expanded = simplePlaceholder(marker, commit, length, labels)
    if (expanded !== null) {
      out.push(expanded)
      i += 2
      continue
    }
    if ((marker === 'a' || marker === 'c') && i + 2 < template.length) {
      const pair = identPlaceholder(marker, template[i + 2] ?? '', commit)
      if (pair !== null) {
        out.push(pair)
        i += 3
        continue
      }
    }
    if (
      marker === 'x' &&
      i + 3 < template.length &&
      HEX_DIGITS.test(template[i + 2] ?? '') &&
      HEX_DIGITS.test(template[i + 3] ?? '')
    ) {
      out.push(byteChar(parseInt(template.slice(i + 2, i + 4), 16)))
      i += 4
      continue
    }
    out.push(char + marker)
    i += 2
  }
  return out.join('')
}

/** One single-letter placeholder's value, null when it is not one. */
function simplePlaceholder(
  marker: string,
  commit: CommitFacts,
  length: number,
  labels: readonly string[],
): string | null {
  switch (marker) {
    case 'H':
      return commit.oid
    case 'h':
      return short(commit.oid, length)
    case 'T':
      return commit.tree
    case 't':
      return short(commit.tree, length)
    case 'P':
      return commit.parents.join(' ')
    case 'p':
      return commit.parents.map((p) => short(p, length)).join(' ')
    case 's':
      return subjectFolded(commit.message)
    case 'b':
      return body(commit.message)
    case 'B':
      return commit.message
    case 'D':
      return labels.join(', ')
    case 'd':
      return labels.length > 0 ? ` (${labels.join(', ')})` : ''
    case 'n':
      return '\n'
    case '%':
      return '%'
    default:
      return null
  }
}

/**
 * An author/committer placeholder's value (%an, %cd, ...).
 *
 * %aN/%aE are the mailmap variants; no mailmap is ever loaded, so they read
 * as their plain forms.
 */
function identPlaceholder(who: string, field: string, commit: CommitFacts): string | null {
  const name = who === 'a' ? commit.authorName : commit.committerName
  const email = who === 'a' ? commit.authorEmail : commit.committerEmail
  const time = who === 'a' ? commit.authorTime : commit.committerTime
  const zone = who === 'a' ? commit.authorTimezoneMinutes : commit.committerTimezoneMinutes
  switch (field) {
    case 'n':
    case 'N':
      return name
    case 'e':
    case 'E':
      return email
    case 'd':
      return gitDate(time, zone)
    case 't':
      return String(time)
    default:
      return null
  }
}
