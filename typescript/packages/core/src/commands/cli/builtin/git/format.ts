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

import { TEMPLATE_KINDS } from './constants.ts'
import { showDate } from './dates.ts'
import { mappedIdentity } from './mailmap.ts'
import { DateKind, Decoration, type DateMode, type MailmapEntry } from './types.ts'
import { byteChar } from '../../../../shell/bytes.ts'
import { BadPrettyError, UnsupportedPrettyError } from './errors.ts'

const SHORT_SHA = 7
export const FULL_SHA = 40
const INDENT = '    '

export const DEFAULT_DATE: DateMode = {
  kind: DateKind.NORMAL,
  local: false,
  strftime: '',
  now: 0,
  zone: null,
}
const RAW_DATE: DateMode = { ...DEFAULT_DATE, kind: DateKind.RAW }

// The ident date placeholders that name a style of their own, whatever --date
// says: %ad alone follows it.
const FIXED_DATE_KINDS: ReadonlyMap<string, DateKind> = new Map([
  ['D', DateKind.RFC2822],
  ['r', DateKind.RELATIVE],
  ['t', DateKind.UNIX],
  ['i', DateKind.ISO8601],
  ['I', DateKind.ISO8601_STRICT],
  ['h', DateKind.HUMAN],
  ['s', DateKind.SHORT],
])

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
const PRESET_KINDS = ['oneline', 'short', 'medium', 'full', 'fuller', 'raw']
const UNSUPPORTED_PRESETS = ['email', 'mboxrd', 'reference']
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

/** What `log` and `show` both read off their flags to present a commit. */
export interface CommitDisplay {
  /** How the commit renders. */
  readonly pretty: LogFormat
  /**
   * Print an abbreviated id, which `--oneline` implies and `--pretty=oneline`
   * alone does not.
   */
  readonly abbrevCommit: boolean
  /** How dates render. */
  readonly date: DateMode
  /** The worktree `.mailmap`. */
  readonly mailmap: readonly MailmapEntry[]
  /** Map the header identities. */
  readonly useMailmap: boolean
  /** How the commit is labelled with its refs. */
  readonly decorate: Decoration
}

/**
 * Read a --pretty/--format value the way git reads it.
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

/** The first line of a commit message. */
export function subject(commit: CommitFacts): string {
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
 * The `Merge:` line every block preset prints for a merge, which git puts
 * between the id and the author for both `log` and `show`.
 */
function mergeLine(commit: CommitFacts, length: number): string[] {
  if (commit.parents.length <= 1) return []
  return [`Merge: ${commit.parents.map((p) => short(p, length)).join(' ')}`]
}

/**
 * One commit as a block preset renders it (short/medium/full/fuller).
 *
 * Pinned against git 2.50: `medium` is the id, author, author date and
 * indented message; `short` is the id, author and indented subject; `full`
 * adds `Commit:` and drops both dates; `fuller` aligns four header lines to
 * the `AuthorDate:` column.
 */
export function presetBlock(
  commit: CommitFacts,
  kind: string,
  length: number,
  date: DateMode = DEFAULT_DATE,
  mailmap: readonly MailmapEntry[] = [],
): string[] {
  if (kind === 'raw')
    return [
      `commit ${commit.oid}`,
      `tree ${commit.tree}`,
      ...commit.parents.map((p) => `parent ${p}`),
      `author ${commit.authorName} <${commit.authorEmail}> ${showDate(commit.authorTime, commit.authorTimezoneMinutes, RAW_DATE)}`,
      `committer ${commit.committerName} <${commit.committerEmail}> ${showDate(commit.committerTime, commit.committerTimezoneMinutes, RAW_DATE)}`,
      '',
      ...messageBlock(commit),
    ]
  const author = mappedIdentity(`${commit.authorName} <${commit.authorEmail}>`, mailmap)
  const committer = mappedIdentity(`${commit.committerName} <${commit.committerEmail}>`, mailmap)
  const lines = [`commit ${commit.oid}`, ...mergeLine(commit, length)]
  if (kind === 'medium') {
    lines.push(
      `Author: ${author}`,
      `Date:   ${showDate(commit.authorTime, commit.authorTimezoneMinutes, date)}`,
      '',
      ...messageBlock(commit),
    )
    return lines
  }
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
    `AuthorDate: ${showDate(commit.authorTime, commit.authorTimezoneMinutes, date)}`,
    `Commit:     ${committer}`,
    `CommitDate: ${showDate(commit.committerTime, commit.committerTimezoneMinutes, date)}`,
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
 * The scan matches git's behaviour pinned in docker: an unknown or
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
  date: DateMode = DEFAULT_DATE,
  mailmap: readonly MailmapEntry[] = [],
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
      const pair = identPlaceholder(marker, template[i + 2] ?? '', commit, date, mailmap)
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
 * Uppercase identity placeholders always apply the worktree mailmap.
 */
function identPlaceholder(
  who: string,
  field: string,
  commit: CommitFacts,
  date: DateMode,
  mailmap: readonly MailmapEntry[],
): string | null {
  let name = who === 'a' ? commit.authorName : commit.committerName
  let email = who === 'a' ? commit.authorEmail : commit.committerEmail
  if (field === 'N' || field === 'E') {
    const identity = mappedIdentity(`${name} <${email}>`, mailmap)
    const at = identity.lastIndexOf(' <')
    name = identity.slice(0, at)
    email = identity.slice(at + 2, -1)
  }
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
      return showDate(time, zone, date)
    default: {
      const kind = FIXED_DATE_KINDS.get(field)
      if (kind === undefined) return null
      return showDate(time, zone, { ...date, kind, local: false, strftime: '' })
    }
  }
}

/**
 * One commit's header, as `log` and `show` print it.
 *
 * `format:` is a separator, so a single commit prints with no trailing newline
 * at all; `tformat:` terminates the entry even when it renders empty, except
 * that an empty template prints nothing, which is how `--format=` stays
 * silent. The caller encodes through `encodeText` because `%xHH` names a raw
 * byte. Pinned against git 2.37 and 2.54. A decorated preset labels the commit
 * after its id.
 *
 * @param commit the commit to render
 * @param display the invocation's presentation flags
 * @param width abbreviated id width for this repository
 * @param decor ref labels when the format asked
 */
export function commitHeader(
  commit: CommitFacts,
  display: CommitDisplay,
  width: number,
  decor: Decorations | null,
): string {
  const fmt = display.pretty
  const decorated = display.decorate !== Decoration.NONE
  if (fmt.kind === 'oneline') {
    const length = display.abbrevCommit ? width : FULL_SHA
    return `${decorated ? renderTemplate('%h%d %s', commit, length, decor) : oneline(commit, length)}\n`
  }
  if (TEMPLATE_KINDS.includes(fmt.kind)) {
    const text = renderTemplate(
      fmt.template ?? '',
      commit,
      width,
      decor,
      display.date,
      display.mailmap,
    )
    if (fmt.kind === 'tformat') {
      return fmt.template === null || fmt.template === '' ? '' : `${text}\n`
    }
    return text
  }
  const block = presetBlock(
    commit,
    fmt.kind,
    width,
    display.date,
    display.useMailmap ? display.mailmap : [],
  )
  if (decorated && block[0]?.startsWith('commit '))
    block[0] += renderTemplate('%d', commit, width, decor)
  return `${block.join('\n')}\n`
}
