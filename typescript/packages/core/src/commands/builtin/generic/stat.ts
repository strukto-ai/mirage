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
import { FlagView } from '../../spec/types.ts'
import { operandStat } from '../utils/operands.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import {
  DEVICE_NUMBERS_KEY,
  FileType,
  LINK_TARGET_KEY,
  type FileStat,
  type PathSpec,
} from '../../../types.ts'
import { isoToEpoch } from '../../../utils/dates.ts'
import { fsErrorLine, isFsError } from '../../../utils/errors.ts'
import { deviceRdev } from '../../../utils/stat_view.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { lsModeString } from '../utils/formatting.ts'
import { groupName, identityOf, ownerName, type Identity } from '../utils/identity.ts'
import { formatRecords } from '../utils/output.ts'

const ENC = new TextEncoder()

const TYPE_LABELS: Partial<Record<FileType, string>> = {
  [FileType.DIRECTORY]: 'directory',
  [FileType.SYMLINK]: 'symbolic link',
  [FileType.CHAR_DEVICE]: 'character special file',
  [FileType.FILE]: 'regular file',
}

function typeLabel(s: FileStat): string {
  return TYPE_LABELS[s.type] ?? 'regular file'
}

// The default record's type= shows a regular file's content shape and a
// non-regular node's kind, so one field reads the way it always has.
function shownType(s: FileStat): string {
  return s.type === FileType.FILE && s.content !== null ? s.content : s.type
}

function effectiveMode(s: FileStat): number {
  if (s.mode !== null) return s.mode & 0o7777
  if (s.type === FileType.DIRECTORY) return 0o755
  // A symlink carries no permission bits of its own; GNU reports 0777.
  if (s.type === FileType.SYMLINK) return 0o777
  if (s.type === FileType.CHAR_DEVICE) return 0o666
  return 0o644
}

function typeBits(s: FileStat): number {
  if (s.type === FileType.DIRECTORY) return 0o040000
  if (s.type === FileType.SYMLINK) return 0o120000
  if (s.type === FileType.CHAR_DEVICE) return 0o020000
  return 0o100000
}

function epoch(iso: string | null): string {
  if (iso === null || iso === '') return '0'
  const secs = isoToEpoch(iso)
  return Number.isNaN(secs) ? '0' : String(secs)
}

const STR_DIRECTIVES = new Set(['n', 'N', 'F'])
const FORMAT_FLAGS = new Set(['#', '0', ' ', '+', '-'])

interface FormatDirective {
  end: number
  flags: string
  width: string
  precision: string | undefined
  spec: string
}

const SHELL_SPECIAL = new Set('!"#$&()*;<=>?[\\^`{|}~')

const START_SAFE = new Set('#~')

const ESCAPE_NAMES: Record<string, string> = {
  '\x07': '\\a',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\v': '\\v',
  '\f': '\\f',
  '\r': '\\r',
}

// Whether GNU spells a character as a $'..' escape.
function needsEscape(char: string): boolean {
  return char < ' ' || char === '\x7f'
}

function escapeChar(char: string): string {
  return ESCAPE_NAMES[char] ?? '\\' + char.charCodeAt(0).toString(8).padStart(3, '0')
}

// Whether a name holding an apostrophe still fits in double quotes. GNU only
// reaches for them when nothing else in the name would stay live inside them,
// so a'b renders as "a'b" but a'b$c does not. # and ~ count as special only
// away from the front.
function doubleQuotable(name: string): boolean {
  for (let index = 0; index < name.length; index += 1) {
    const char = name.charAt(index)
    if (needsEscape(char)) return false
    if (SHELL_SPECIAL.has(char) && !(index === 0 && START_SAFE.has(char))) return false
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
      for (let at = index; at < end; at += 1) text += escapeChar(name.charAt(at))
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

function applyFlags(
  value: string,
  flags: string,
  width: string,
  precision: string | undefined,
  spec: string,
): string {
  if (flags.includes('#') && spec === 'a' && !value.startsWith('0')) value = '0' + value
  if (precision !== undefined && STR_DIRECTIVES.has(spec)) {
    value = precision === '' ? '' : value.slice(0, Number(precision))
  }
  if (width !== '' && value.length < Number(width)) {
    const w = Number(width)
    if (flags.includes('-')) value = value.padEnd(w)
    else if (flags.includes('0')) value = value.padStart(w, '0')
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
  if (spec === 's') return String(s.size ?? 0)
  if (spec === 'F') return typeLabel(s)
  if (spec === 'a') return effectiveMode(s).toString(8)
  if (spec === 'A') return lsModeString(s)
  if (spec === 'f') return (typeBits(s) | effectiveMode(s)).toString(16)
  if (spec === 'u' || spec === 'U') return ownerName(s.uid, identity)
  if (spec === 'g' || spec === 'G') return groupName(s.gid, identity)
  if (spec === 'x') return s.atime ?? s.modified ?? ''
  if (spec === 'X') return epoch(s.atime ?? s.modified)
  if (spec === 'y' || spec === 'z') return s.modified ?? ''
  if (spec === 'Y' || spec === 'Z') return epoch(s.modified)
  if (spec === 'w') return '-'
  if (spec === 'W') return '0'
  if (spec === 'B') return '512'
  const device = s.extra[DEVICE_NUMBERS_KEY]
  const numbers = Array.isArray(device) && device.length === 2 ? (device as [number, number]) : null
  if (spec === 't') return numbers !== null ? numbers[0].toString(16) : '0'
  if (spec === 'T') return numbers !== null ? numbers[1].toString(16) : '0'
  if (spec === 'r' || spec === 'R') {
    const rdev = deviceRdev(s)
    return spec === 'r' ? String(rdev) : rdev.toString(16)
  }
  if (spec.length === 2 && (spec.startsWith('H') || spec.startsWith('L'))) {
    if (spec[1] === 'r' || spec[1] === 'R') {
      if (numbers === null) return '0'
      return String(spec.startsWith('H') ? numbers[0] : numbers[1])
    }
    return '?'
  }
  return '?'
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
  if (d.spec === 'N') {
    // GNU formats the name and a symlink's target as two separate fields,
    // so a width pads each one rather than the joined line.
    const bare = d.flags === '' && d.width === '' && d.precision === undefined
    return nameParts(s, name, bare)
      .map((part) => applyFlags(part, d.flags, d.width, d.precision, d.spec))
      .join(' -> ')
  }
  return applyFlags(
    directiveValue(d.spec, s, name, identity),
    d.flags,
    d.width,
    d.precision,
    d.spec,
  )
}

function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

function isConversion(char: string | undefined): boolean {
  return (
    char === '%' ||
    (char !== undefined && ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')))
  )
}

function parseFormatDirective(fmt: string, start: number): FormatDirective | null {
  let cursor = start + 1
  let flags = ''
  while (cursor < fmt.length && FORMAT_FLAGS.has(fmt[cursor] ?? '')) {
    flags += fmt.charAt(cursor)
    cursor += 1
  }

  let width = ''
  while (isAsciiDigit(fmt[cursor])) {
    width += fmt.charAt(cursor)
    cursor += 1
  }

  let precision: string | undefined
  if (fmt[cursor] === '.') {
    cursor += 1
    precision = ''
    while (isAsciiDigit(fmt[cursor])) {
      precision += fmt.charAt(cursor)
      cursor += 1
    }
  }

  const first = fmt.charAt(cursor)
  if (!isConversion(first)) return null
  let spec = first
  cursor += 1
  if ((first === 'H' || first === 'L') && isConversion(fmt[cursor])) {
    spec += fmt.charAt(cursor)
    cursor += 1
  }
  return { end: cursor, flags, width, precision, spec }
}

function formatStat(fmt: string, s: FileStat, name: string, identity: Identity | null): string {
  const parts: string[] = []
  let cursor = 0
  while (cursor < fmt.length) {
    const start = fmt.indexOf('%', cursor)
    if (start === -1) {
      parts.push(fmt.slice(cursor))
      break
    }
    parts.push(fmt.slice(cursor, start))
    const directive = parseFormatDirective(fmt, start)
    if (directive === null) {
      parts.push('%')
      cursor = start + 1
      continue
    }
    parts.push(renderDirective(directive, s, name, identity))
    cursor = directive.end
  }
  return parts.join('')
}

export async function statGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stat: (p: PathSpec) => Promise<FileStat>,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('stat'))
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('stat: missing operand\n') })]
  }
  const fmt = fl.asStr('c') ?? fl.asStr('f') ?? null
  const lines: string[] = []
  let err = ''
  const links = fl.asBool('L') ? null : (opts.ns?.links ?? null)
  const identity = identityOf(opts)
  for (const p of paths) {
    // GNU stat lstats: a symlink operand reports the link itself, not
    // its target, unless -L asks to dereference. A link has no backend
    // inode, so the namespace is the only authority for it.
    const linked = links?.statAt(p.virtual) ?? null
    if (linked !== null) {
      if (fmt !== null) {
        lines.push(formatStat(fmt, linked, p.rawPath, identity))
      } else {
        const sizeStr = linked.size === null ? 'None' : String(linked.size)
        const modStr = linked.modified ?? 'None'
        lines.push(
          `name=${linked.name} size=${sizeStr} modified=${modStr} type=${shownType(linked)}`,
        )
      }
      continue
    }
    let s: FileStat
    try {
      s = await operandStat(p, stat, opts.statPath, opts.ns?.mounts)
    } catch (e) {
      // GNU stat keeps reporting the remaining operands, exit 1.
      if (!isFsError(e)) throw e
      err += fsErrorLine('stat', p, e)
      continue
    }
    if (fmt !== null) {
      lines.push(formatStat(fmt, s, p.rawPath, identity))
    } else {
      const sizeStr = s.size === null ? 'None' : String(s.size)
      const modStr = s.modified ?? 'None'
      lines.push(`name=${s.name} size=${sizeStr} modified=${modStr} type=${shownType(s)}`)
    }
  }
  const io = new IOResult({
    exitCode: err === '' ? 0 : 1,
    stderr: err === '' ? null : ENC.encode(err),
  })
  if (lines.length === 0) return [null, io]
  const out: ByteSource = formatRecords(lines)
  return [out, io]
}
