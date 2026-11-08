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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { atOffsets, operandStat } from '../utils/operands.ts'
import { IOResult } from '../../../io/types.ts'
import {
  CapacityState,
  DEVICE_NUMBERS_KEY,
  FileType,
  Follow,
  LINK_TARGET_KEY,
  LineFacts,
  type CapacityResult,
  type FileStat,
  type PathSpec,
} from '../../../types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { isoTimestamp, isoToEpoch } from '../../../utils/dates.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import {
  DQ_BLOCKERS,
  LEADING_SPECIAL,
  NAMED_ESCAPES,
  shellQuoteAlways,
} from '../../../utils/quote.ts'
import {
  BLOCK_UNIT,
  ALL_MODE_BITS,
  contentSize,
  deviceRdev,
  posixMode,
  sizeUnknown,
} from '../../../utils/stat_view.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { fullIsoTime, lsModeString } from '../utils/formatting.ts'
import { groupName, identityOf, ownerName, type Identity } from '../utils/identity.ts'
import { formatRecords } from '../utils/output.ts'
import { missingOperandError } from '../../spec/usage.ts'
import { byteChar, encodeText } from '../../../shell/bytes.ts'
import { linksOf, mountsOf, dispatchOf } from '../utils/links.ts'
import { vfsStatPath } from '../utils/paths.ts'

const TYPE_LABELS: Partial<Record<FileType, string>> = {
  [FileType.DIRECTORY]: 'directory',
  [FileType.SYMLINK]: 'symbolic link',
  [FileType.CHAR_DEVICE]: 'character special file',
  [FileType.FILE]: 'regular file',
  [FileType.FIFO]: 'fifo',
}

function typeLabel(s: FileStat): string {
  return TYPE_LABELS[s.type] ?? 'regular file'
}

function effectiveMode(s: FileStat): number {
  return posixMode(s) & ALL_MODE_BITS
}

function epoch(iso: string | null): string {
  if (iso === null || iso === '') return '0'
  const secs = isoToEpoch(iso)
  return Number.isNaN(secs) ? '0' : String(secs)
}

const STR_DIRECTIVES = new Set(['n', 'N', 'F'])
const FORMAT_FLAGS = new Set(["'", '-', '+', ' ', '#', '0', 'I'])
const ASCII_DIGITS = new Set('0123456789')

// The directives GNU knows (coreutils 9.7). It prints any other as a bare
// '?', which no width pads; one it knows that a VFS cannot answer is padded
// like the value it stands for.
const KNOWN = new Set([...Array.from('aAbBCdDfFgGhimnNorRstTuUwWxXyYzZ%'), 'Hd', 'Ld', 'Hr', 'Lr'])

// The placeholders for a value that is not known, which a 0 flag pads with
// spaces rather than zeros.
const PLACEHOLDERS = new Set(['-', '?'])

// The conversions %H and %L split into a device's major and minor; in
// file-system mode they are no prefix at all.
const DEVICE_HALVES = 'dr'

// GNU's file-system report (coreutils 9.7 stat -f), in its directives.
// What -t prints, as stat's own --help states it: one line of the fields a
// script splits on blanks.
const TERSE = '%n %s %b %f %u %g %D %i %h %t %T %X %Y %Z %W %o'
const TERSE_FS = '%n %i %l %t %s %S %b %f %a %c %d'

// The escapes --printf reads, each the byte it stands for.
const ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  e: 27,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '"': 34,
  '\\': 92,
}
const OCTAL = /^[0-7]$/
const HEX = /^[0-9a-fA-F]$/

const FS_LAYOUT = [
  '  File: "%n"',
  '    ID: %-8i Namelen: %-7l Type: %T',
  'Block size: %-10s Fundamental block size: %S',
  'Blocks: Total: %-10b Free: %-10f Available: %a',
  'Inodes: Total: %-10c Free: %d',
].join('\n')

// A mount reports its capacity in bytes; -f counts it in 1K blocks, the
// unit df reports in.
const FS_BLOCK = 1024

const FS_STRINGS = new Set(['n', 'T'])

const FS_KNOWN = new Set('abcdfilnsStT%')

const FS_COUNTS = new Set('abcdf')

const FS_STDIN = "using '-' to denote standard input does not work in file system mode"

type StatfsFn = (p: PathSpec) => Promise<[string, CapacityResult]>

// What -f reports outside a workspace: nothing is known about the file
// system that holds a path.
const NO_FILE_SYSTEM: [string, CapacityResult] = ['-', { state: CapacityState.UNKNOWN }]

interface FormatDirective {
  end: number
  flags: string
  width: string
  precision: string | undefined
  spec: string
}

// Whether GNU spells a character as a $'..' escape: a control character, or
// any byte past ASCII, as the C locale prints it.
function needsEscape(char: string): boolean {
  return char < ' ' || char >= '\x7f'
}

// Spell one character the way bash's $'..' does, a character past ASCII as
// the octal escape of each of its UTF-8 bytes.
function escapeChar(char: string): string {
  const named = NAMED_ESCAPES.get(char)
  if (named !== undefined) return `\\${named}`
  return Array.from(encodeText(char), (byte) => '\\' + byte.toString(8).padStart(3, '0')).join('')
}

// Whether a name holding an apostrophe still fits in double quotes. GNU only
// reaches for them when nothing else in the name would stay live inside them,
// so a'b renders as "a'b" but a'b$c does not. # and ~ count as special only
// away from the front.
function doubleQuotable(name: string): boolean {
  for (let index = 0; index < name.length; index += 1) {
    const char = name.charAt(index)
    if (needsEscape(char)) return false
    if (DQ_BLOCKERS.has(char) && !(index === 0 && LEADING_SPECIAL.has(char))) return false
  }
  return true
}

// Single-quoted runs spliced with $'..' escape segments.
function singleQuoted(name: string): string {
  const parts: string[] = []
  let index = 0
  while (index < name.length) {
    const escaped = needsEscape(name.charAt(index))
    let end = index
    while (end < name.length && needsEscape(name.charAt(end)) === escaped) end += 1
    if (escaped) {
      // A leading escape keeps the empty quotes GNU emits; a trailing one does not.
      if (index === 0) parts.push("''")
      let text = ''
      for (const char of name.slice(index, end)) text += escapeChar(char)
      parts.push("$'" + text + "'")
    } else {
      parts.push("'" + name.slice(index, end).replaceAll("'", "'\\''") + "'")
    }
    index = end
  }
  return parts.length > 0 ? parts.join('') : "''"
}

// Shell-safe quoting for %N, mirroring GNU's default: single quotes are the
// rule, with each apostrophe escaped as '\'' and every unprintable character
// lifted into a $'..' segment. A name whose only awkward character is an
// apostrophe reads better in double quotes, and GNU renders that one case
// that way.
function quoteName(name: string): string {
  if (name.includes("'") && doubleQuotable(name)) return `"${name}"`
  return singleQuoted(name)
}

// Apply GNU printf flags, width and precision to a rendered directive; a
// precision cuts short only a directive that prints a string (`text`).
function applyFlags(
  value: string,
  flags: string,
  width: string,
  precision: string | undefined,
  text: boolean,
): string {
  if (precision !== undefined && text) {
    value = precision === '' ? '' : value.slice(0, Number(precision))
  }
  if (width !== '' && value.length < Number(width)) {
    const w = Number(width)
    if (flags.includes('-')) value = value.padEnd(w)
    else if (flags.includes('0') && !PLACEHOLDERS.has(value)) value = value.padStart(w, '0')
    else value = value.padStart(w)
  }
  return value
}

function directiveValue(
  spec: string,
  s: FileStat,
  name: string,
  identity: Identity | null,
): string {
  if (spec === '%') return '%'
  if (spec === 'n') return name
  if (spec === 's') return sizeUnknown(s) ? '-' : String(contentSize(s))
  if (spec === 'F') return typeLabel(s)
  if (spec === 'a') return effectiveMode(s).toString(8)
  if (spec === 'A') return lsModeString(s)
  if (spec === 'f') return posixMode(s).toString(16)
  if (spec === 'u' || spec === 'U') return ownerName(s.uid, identity)
  if (spec === 'g' || spec === 'G') return groupName(s.gid, identity)
  if (spec === 'x') return statTime(s.atime ?? s.modified)
  if (spec === 'X') return epoch(s.atime ?? s.modified)
  if (spec === 'y') return statTime(s.modified)
  if (spec === 'Y') return epoch(s.modified)
  if (spec === 'z') return statTime(s.ctime)
  if (spec === 'Z') return epoch(s.ctime)
  if (spec === 'w') return statTime(s.birthtime)
  if (spec === 'W') return epoch(s.birthtime)
  if (spec === 'B') return String(BLOCK_UNIT)
  if (spec === 'd') return s.dev === null ? '?' : String(s.dev)
  if (spec === 'D') return s.dev === null ? '?' : s.dev.toString(16)
  const device = s.extra[DEVICE_NUMBERS_KEY]
  const numbers = Array.isArray(device) && device.length === 2 ? (device as [number, number]) : null
  if (spec === 't') return numbers !== null ? numbers[0].toString(16) : '0'
  if (spec === 'T') return numbers !== null ? numbers[1].toString(16) : '0'
  if (spec === 'r' || spec === 'R') {
    const rdev = deviceRdev(s)
    return spec === 'r' ? String(rdev) : rdev.toString(16)
  }
  if (spec.length === 2 && (spec.startsWith('H') || spec.startsWith('L'))) {
    // %Hr/%Lr are rdev major/minor in decimal; %Hd/%Ld are the device the
    // file resides on: its mount's.
    const half = spec.startsWith('H') ? 0 : 1
    if (spec[1] === 'r' || spec[1] === 'R') {
      if (numbers === null) return '0'
      return String(numbers[half])
    }
    return s.dev === null ? '?' : String(deviceHalves(s.dev)[half])
  }
  return '?'
}

/**
 * A device number's major and minor, split as glibc's `major(3)` and
 * `minor(3)` split a `dev_t`. The id is up to 48 bits, past the 32 a
 * bitwise operator keeps, so the shifts are divisions.
 */
function deviceHalves(dev: number): [number, number] {
  const major =
    ((Math.floor(dev / 2 ** 8) & 0xfff) | (Math.floor(dev / 2 ** 32) & 0xfffff000)) >>> 0
  const minor = ((dev % 2 ** 8) | (Math.floor(dev / 2 ** 12) & 0xffffff00)) >>> 0
  return [major, minor]
}

// The fields %N renders: the name, plus a symlink's target. GNU shell-quotes
// each one only for a bare %N; any flag, width or precision drops the quotes.
function nameParts(s: FileStat, name: string, quoted: boolean): string[] {
  const parts = [name]
  if (s.type === FileType.SYMLINK) {
    const target = s.extra[LINK_TARGET_KEY]
    if (typeof target === 'string' && target !== '') parts.push(target)
  }
  return quoted ? parts.map(quoteName) : parts
}

function renderDirective(
  d: FormatDirective,
  s: FileStat,
  name: string,
  identity: Identity | null,
): string {
  if (!KNOWN.has(d.spec)) return '?'
  if (d.spec === 'N') {
    // GNU formats the name and a symlink's target as two separate fields,
    // so a width pads each one rather than the joined line.
    const bare = d.flags === '' && d.width === '' && d.precision === undefined
    return nameParts(s, name, bare)
      .map((part) => applyFlags(part, d.flags, d.width, d.precision, true))
      .join(' -> ')
  }
  let value = directiveValue(d.spec, s, name, identity)
  if (d.flags.includes('#') && d.spec === 'a' && !value.startsWith('0')) value = '0' + value
  return applyFlags(value, d.flags, d.width, d.precision, STR_DIRECTIVES.has(d.spec))
}

// A byte count as 1K blocks, rounded up like df, or '-' when unknown.
function fsBlocks(nbytes: number | null | undefined): string {
  return nbytes === null || nbytes === undefined ? '-' : String(Math.ceil(nbytes / FS_BLOCK))
}

// One file-system directive's value. A mount has no file system ID, name
// limit, type number or transfer size, so those print '?'. Its counts print
// '-' unless it reports a quota, as df shows them.
function fsValue(spec: string, kind: string, cap: CapacityResult, name: string): string {
  if (spec === '%') return '%'
  if (spec === 'n') return name
  if (spec === 'T') return kind
  if (spec === 'S') return String(FS_BLOCK)
  if (!FS_COUNTS.has(spec)) return '?'
  if (cap.state !== CapacityState.QUOTA) return '-'
  if (spec === 'b') return fsBlocks(cap.total)
  if (spec === 'a') return fsBlocks(cap.available)
  if (spec === 'f') {
    if (cap.total == null || cap.used == null) return '-'
    return fsBlocks(cap.total - cap.used)
  }
  if (spec === 'c') return cap.inodes == null ? '-' : String(cap.inodes)
  if (cap.inodes == null || cap.inodesUsed == null) return '-'
  return String(cap.inodes - cap.inodesUsed)
}

function renderFsDirective(
  d: FormatDirective,
  kind: string,
  cap: CapacityResult,
  name: string,
): string {
  if (!FS_KNOWN.has(d.spec)) return '?'
  return applyFlags(
    fsValue(d.spec, kind, cap, name),
    d.flags,
    d.width,
    d.precision,
    FS_STRINGS.has(d.spec),
  )
}

// Scan one directive starting at a `%`. Any character converts, and one GNU
// does not know prints '?'; `halves` are the conversions an H or L prefix
// takes.
function parseFormatDirective(fmt: string, start: number, halves: string): FormatDirective | null {
  let cursor = start + 1
  let flags = ''
  while (cursor < fmt.length && FORMAT_FLAGS.has(fmt[cursor] ?? '')) {
    flags += fmt.charAt(cursor)
    cursor += 1
  }

  let width = ''
  while (cursor < fmt.length && ASCII_DIGITS.has(fmt[cursor] ?? '')) {
    width += fmt.charAt(cursor)
    cursor += 1
  }

  let precision: string | undefined
  if (fmt[cursor] === '.') {
    cursor += 1
    precision = ''
    while (cursor < fmt.length && ASCII_DIGITS.has(fmt[cursor] ?? '')) {
      precision += fmt.charAt(cursor)
      cursor += 1
    }
  }

  if (cursor >= fmt.length) return null
  const first = fmt.charAt(cursor)
  let spec = first
  cursor += 1
  if (
    (first === 'H' || first === 'L') &&
    cursor < fmt.length &&
    halves.includes(fmt.charAt(cursor))
  ) {
    spec += fmt.charAt(cursor)
    cursor += 1
  }
  return { end: cursor, flags, width, precision, spec }
}

/**
 * The text one `--printf` backslash escape stands for, and the index after
 * it. Up to three octal digits or two hex digits after `x` give a byte; the
 * named escapes give theirs; any other character is printed as it is, with a
 * warning, as is a backslash that ends the format. Mirrors Python's _escape.
 */
function escape(fmt: string, start: number, warnings: string[]): [string, number] {
  const cursor = start + 1
  if (cursor === fmt.length) {
    warnings.push('stat: warning: backslash at end of format\n')
    return ['\\', cursor]
  }
  const char = fmt.charAt(cursor)
  if (OCTAL.test(char)) {
    let end = cursor
    while (end < fmt.length && end - cursor < 3 && OCTAL.test(fmt.charAt(end))) end += 1
    return [byteChar(parseInt(fmt.slice(cursor, end), 8)), end]
  }
  if (char === 'x' && HEX.test(fmt.charAt(cursor + 1))) {
    let end = cursor + 1
    while (end < fmt.length && end - cursor < 3 && HEX.test(fmt.charAt(end))) end += 1
    return [byteChar(parseInt(fmt.slice(cursor + 1, end), 16)), end]
  }
  const named = ESCAPES[char]
  if (named !== undefined) return [String.fromCharCode(named), cursor + 1]
  warnings.push(`stat: warning: unrecognized escape '\\${char}'\n`)
  return [char, cursor + 1]
}

// Expand a format string, each directive through `render`. `warnings` is
// --printf's, which reads the backslash escapes and adds each warning there
// with where in the report it was said; null reads a backslash as itself.
function format(
  fmt: string,
  halves: string,
  render: (d: FormatDirective) => string,
  warnings: [number, string][] | null = null,
): string {
  const parts: string[] = []
  let length = 0
  const put = (text: string): void => {
    parts.push(text)
    length += text.length
  }
  let cursor = 0
  while (cursor < fmt.length) {
    const start = fmt.indexOf('%', cursor)
    if (warnings !== null) {
      const slash = fmt.indexOf('\\', cursor)
      if (slash !== -1 && (start === -1 || slash < start)) {
        put(fmt.slice(cursor, slash))
        const said: string[] = []
        const [text, next] = escape(fmt, slash, said)
        for (const line of said) warnings.push([length, line])
        put(text)
        cursor = next
        continue
      }
    }
    if (start === -1) {
      put(fmt.slice(cursor))
      break
    }
    put(fmt.slice(cursor, start))
    const directive = parseFormatDirective(fmt, start, halves)
    if (directive === null) {
      put('%')
      cursor = start + 1
      continue
    }
    put(render(directive))
    cursor = directive.end
  }
  return parts.join('')
}

function formatStat(
  fmt: string,
  s: FileStat,
  name: string,
  identity: Identity | null,
  warnings: [number, string][] | null = null,
): string {
  return format(fmt, DEVICE_HALVES, (d) => renderDirective(d, s, name, identity), warnings)
}

// The fraction of a second as the backend spelled it, so both hosts print
// the digits the stamp carries rather than what their clock type keeps.

/** A known timestamp in GNU's layout, in UTC, or '-' when unknown. A naive
 * stamp is UTC, as everywhere else a backend time is read. */
function statTime(value: string | null): string {
  return isoTimestamp(value) === null ? '-' : fullIsoTime(value)
}

/** GNU coreutils 9.7's default layout, with unknown fields marked. A VFS has
 * rendered bytes, modes, logical owners and its mount's device, but no inode,
 * allocation blocks, IO block size or link count: those print '?'. An absent size,
 * owner number or time prints '-'. Each time is the one its directive
 * prints (`%x %y %z %w`), the name is unquoted as GNU's default prints it,
 * and times are UTC. */
function renderStat(s: FileStat, name: string, identity: Identity | null): string {
  const size = directiveValue('s', s, name, identity)
  const uid = String(s.uid ?? '-').padStart(5)
  const gid = String(s.gid ?? '-').padStart(5)
  const owner = ownerName(s.uid, identity).padStart(8)
  const group = groupName(s.gid, identity).padStart(8)
  const links =
    s.type === FileType.CHAR_DEVICE
      ? `Links: ${'?'.padEnd(5)} Device type: ${directiveValue('Hr', s, name, identity)},${directiveValue('Lr', s, name, identity)}`
      : 'Links: ?'
  const device = s.dev === null ? '?' : deviceHalves(s.dev).join(',')
  return [
    `  File: ${nameParts(s, name, false).join(' -> ')}`,
    `  Size: ${size.padEnd(10)}\tBlocks: ${'?'.padEnd(10)} IO Block: ${'?'.padEnd(6)} ${typeLabel(s)}`,
    `Device: ${device}\tInode: ${'?'.padEnd(10)}  ${links}`,
    `Access: (${effectiveMode(s).toString(8).padStart(4, '0')}/${lsModeString(s)})  Uid: (${uid}/${owner})   Gid: (${gid}/${group})`,
    `Access: ${statTime(s.atime ?? s.modified)}`,
    `Modify: ${statTime(s.modified)}`,
    `Change: ${statTime(s.ctime)}`,
    ` Birth: ${statTime(s.birthtime)}`,
  ].join('\n')
}

// One operand's report: the -c format when given, else GNU's default layout.
function renderOne(
  s: FileStat,
  name: string,
  fmt: string | null,
  identity: Identity | null,
  warnings: [number, string][] | null = null,
): string {
  if (fmt !== null) return formatStat(fmt, s, name, identity, warnings)
  return renderStat(s, name, identity)
}

// The reports as output: one per line, or as --printf wrote them, with no
// newline of its own.
function records(lines: readonly string[], printf: boolean): Uint8Array {
  return printf ? encodeText(lines.join('')) : formatRecords(lines)
}

// Add one report, each warning it raised noted where in it it was said (GNU
// prints `/f` before a `\q` warning and `q` after it), leaving the warnings
// empty. Mirrors Python's _report.
function report(
  lines: string[],
  notes: [number, number, string][],
  line: string,
  warnings: [number, string][] | null,
): void {
  for (const [at, text] of warnings ?? []) notes.push([lines.length, at, text])
  if (warnings !== null) warnings.length = 0
  lines.push(line)
}

// The reports as output, each stderr line where it was said. Mirrors
// Python's _noted.
function noted(
  lines: readonly string[],
  notes: readonly [number, number, string][],
  printf: boolean,
  failed: boolean,
): CommandFnResult {
  const io = new IOResult({ exitCode: failed ? 1 : 0 })
  if (lines.length === 0) {
    const err = notes.map(([, , line]) => line).join('')
    if (err !== '') io.stderr = encodeText(err)
    return [null, io]
  }
  const starts = [0]
  for (const line of lines) starts.push((starts.at(-1) ?? 0) + records([line], printf).byteLength)
  const placed = notes.map(
    ([row, at, text]) =>
      [
        (starts[row] ?? 0) +
          (row < lines.length ? encodeText((lines[row] ?? '').slice(0, at)).byteLength : 0),
        encodeText(text),
      ] as const,
  )
  return [atOffsets(records(lines, printf), placed, io), io]
}

// Report the file system each operand is on, GNU `stat -f`. The operand stat
// settles that a path exists first, so a missing one fails in the words a
// plain stat would find for it; `statfs` is null outside a workspace.
async function fileSystems(
  paths: PathSpec[],
  fmt: string,
  probe: (p: PathSpec) => Promise<FileStat>,
  statfs: StatfsFn | null,
  warnings: [number, string][] | null = null,
): Promise<CommandFnResult> {
  const lines: string[] = []
  const notes: [number, number, string][] = []
  let failed = false
  for (const p of paths) {
    if (p.rawPath === '-') {
      notes.push([lines.length, 0, `stat: ${FS_STDIN}\n`])
      failed = true
      continue
    }
    let found: [string, CapacityResult]
    try {
      await probe(p)
      found = statfs !== null ? await statfs(p) : NO_FILE_SYSTEM
    } catch (e) {
      if (!isFsError(e)) throw e
      const strerror = fsStrerror(e)
      notes.push([
        lines.length,
        0,
        `stat: cannot read file system information for ${shellQuoteAlways(p.rawPath)}` +
          `${strerror !== null ? `: ${strerror}` : ''}\n`,
      ])
      failed = true
      continue
    }
    const [kind, cap] = found
    report(
      lines,
      notes,
      format(fmt, '', (d) => renderFsDirective(d, kind, cap, p.rawPath), warnings),
      warnings,
    )
  }
  return noted(lines, notes, warnings !== null, failed)
}

// statfs through the dispatcher.
async function dispatchedStatfs(
  dispatch: DispatchFn,
  path: PathSpec,
): Promise<[string, CapacityResult]> {
  const [result] = (await dispatch('statfs', path)) as [[string, CapacityResult], unknown]
  return result
}

interface StatFlags {
  readonly format: string | null
  readonly fileSystem: boolean
  readonly deref: boolean
  readonly printf: boolean
  readonly terse: boolean
}

function parseFlags(bag: Record<string, FlagValue>): StatFlags {
  const fl = new FlagView(bag, specOf('stat'))
  // The later of -c and --printf sets the format, and either one overrides -t.
  const last = fl.typedOrder('format', 'printf').at(-1)
  return {
    format: last === undefined ? null : (fl.asStr(last) ?? null),
    fileSystem: fl.asBool('file_system'),
    deref: fl.asBool('dereference'),
    printf: last === 'printf',
    terse: fl.asBool('terse'),
  }
}

export async function statGeneric(
  paths: PathSpec[],
  ctx: Context,
  stat: (p: PathSpec) => Promise<FileStat>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(ctx.flags)
  if (paths.length === 0) throw missingOperandError('stat', null)
  const fmt = parsed.format ?? (parsed.terse ? (parsed.fileSystem ? TERSE_FS : TERSE) : null)
  const warnings: [number, string][] | null = parsed.printf ? [] : null
  const statPath = vfsStatPath(ctx.vfs)
  if (parsed.fileSystem) {
    const dispatch = dispatchOf(ctx)
    const probe = (p: PathSpec): Promise<FileStat> =>
      operandStat(p, stat, statPath, mountsOf(ctx), linksOf(ctx))
    const statfs: StatfsFn | null =
      dispatch !== undefined ? (p) => dispatchedStatfs(dispatch, p) : null
    return fileSystems(paths, fmt ?? FS_LAYOUT, probe, statfs, warnings)
  }
  const lines: string[] = []
  const notes: [number, number, string][] = []
  let failed = false
  const links = parsed.deref ? null : (linksOf(ctx) ?? null)
  const identity = identityOf(ctx)
  for (const p of paths) {
    // GNU stat lstats: a symlink operand reports the link itself, not
    // its target, unless -L asks to dereference. A link has no backend
    // inode, so the namespace is the only authority for it.
    const linked = links?.statAt(p.virtual) ?? null
    if (linked !== null) {
      report(lines, notes, renderOne(linked, p.rawPath, fmt, identity, warnings), warnings)
      continue
    }
    let s: FileStat
    try {
      s = await operandStat(p, stat, statPath, mountsOf(ctx), linksOf(ctx))
    } catch (e) {
      // GNU stat keeps reporting the remaining operands, exit 1.
      if (!isFsError(e)) throw e
      notes.push([lines.length, 0, fsErrorLine('stat', p, e)])
      failed = true
      continue
    }
    report(lines, notes, renderOne(s, p.rawPath, fmt, identity, warnings), warnings)
  }
  return noted(lines, notes, parsed.printf, failed)
}

/** A stat line reports a link itself unless `-L`. Mirrors Python's `facts`. */
export function facts(fl: FlagView, _operands: readonly (string | PathSpec)[]): LineFacts {
  return new LineFacts({ follows: fl.asBool('dereference') ? Follow.LAST : Follow.NONE })
}
