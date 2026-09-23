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
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { deflateRaw } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { lstripSlash, rstripSlash } from '../../../utils/slash.ts'
import { respellOne } from '../../../utils/path.ts'
import type { MemberKind } from './archive/types.ts'
import { OTHER_FILESYSTEM, scanOperand, type StatFn, type WalkFn } from './archive/walk.ts'

const ENC = new TextEncoder()

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.byteLength; i++) {
    c = (CRC_TABLE[((c ^ (data[i] ?? 0)) & 0xff) >>> 0] ?? 0) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function writeU16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
}

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
  buf[offset + 2] = (value >>> 16) & 0xff
  buf[offset + 3] = (value >>> 24) & 0xff
}

interface ZipItem {
  name: string
  data: Uint8Array
  compressed: Uint8Array
  crc: number
  method: number
  // Unix mode bits in the high half of external_attr, which is where
  // Info-ZIP puts them and where a symlink entry is told from a file.
  externalAttr: number
  localOffset: number
}

// One entry the plan decided to store, before its bytes are read.
interface ZipMember {
  name: string
  kind: MemberKind
  path: PathSpec | null
  target: string
}

// What one `zip` run decided. `write` is false when nothing matched, in
// which case Info-ZIP leaves no archive behind at all.
interface ZipPlan {
  members: ZipMember[]
  warnings: string[]
  write: boolean
  // The warning for two paths that store under one name, empty when every
  // name is unique.
  repeated: string
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

// The stamp every member carries: 1980-01-01 00:00, the DOS epoch and
// Python zipfile's default, which Info-ZIP lists as `80-Jan-01 00:00`.
// A zero date has month 0 and day 0, which is no date at all.
const DOS_EPOCH_DATE = (1 << 5) | 1

function buildZip(items: ZipItem[]): Uint8Array {
  const parts: Uint8Array[] = []
  let offset = 0
  for (const item of items) {
    item.localOffset = offset
    const nameBytes = ENC.encode(item.name)
    const header = new Uint8Array(30 + nameBytes.byteLength)
    writeU32LE(header, 0, 0x04034b50)
    writeU16LE(header, 4, 20)
    writeU16LE(header, 6, 0)
    writeU16LE(header, 8, item.method)
    writeU16LE(header, 10, 0)
    writeU16LE(header, 12, DOS_EPOCH_DATE)
    writeU32LE(header, 14, item.crc)
    writeU32LE(header, 18, item.compressed.byteLength)
    writeU32LE(header, 22, item.data.byteLength)
    writeU16LE(header, 26, nameBytes.byteLength)
    writeU16LE(header, 28, 0)
    header.set(nameBytes, 30)
    parts.push(header)
    parts.push(item.compressed)
    offset += header.byteLength + item.compressed.byteLength
  }
  const centralStart = offset
  for (const item of items) {
    const nameBytes = ENC.encode(item.name)
    const central = new Uint8Array(46 + nameBytes.byteLength)
    writeU32LE(central, 0, 0x02014b50)
    // Unix in the high byte, so the mode bits below are read as such.
    writeU16LE(central, 4, (3 << 8) | 20)
    writeU16LE(central, 6, 20)
    writeU16LE(central, 8, 0)
    writeU16LE(central, 10, item.method)
    writeU16LE(central, 12, 0)
    writeU16LE(central, 14, DOS_EPOCH_DATE)
    writeU32LE(central, 16, item.crc)
    writeU32LE(central, 20, item.compressed.byteLength)
    writeU32LE(central, 24, item.data.byteLength)
    writeU16LE(central, 28, nameBytes.byteLength)
    writeU16LE(central, 30, 0)
    writeU16LE(central, 32, 0)
    writeU16LE(central, 34, 0)
    writeU16LE(central, 36, 0)
    writeU32LE(central, 38, item.externalAttr)
    writeU32LE(central, 42, item.localOffset)
    central.set(nameBytes, 46)
    parts.push(central)
    offset += central.byteLength
  }
  const centralSize = offset - centralStart
  const end = new Uint8Array(22)
  writeU32LE(end, 0, 0x06054b50)
  writeU16LE(end, 4, 0)
  writeU16LE(end, 6, 0)
  writeU16LE(end, 8, items.length)
  writeU16LE(end, 10, items.length)
  writeU32LE(end, 12, centralSize)
  writeU32LE(end, 16, centralStart)
  writeU16LE(end, 20, 0)
  parts.push(end)
  return concat(parts)
}

// Info-ZIP 3.0's wording, pinned on debian:stable-slim. A warning is
// indented with a tab and -q silences it; the "Nothing to do!" error is
// not a warning and survives -q. Exit 12 is Info-ZIP's ZE_NONE.
const WARNING_PREFIX = '\tzip warning: '
// What Info-ZIP calls a path it could not reach. It does not distinguish
// absent from unreadable, and a dangling symlink under the default
// follow prints exactly this too.
const NOT_MATCHED = 'name not matched: '
const NOTHING_TO_DO_EXIT = 12
// Two operands that store under one name refuse the whole run (Info-ZIP's
// check_dup, ZE_PARMS). -q silences the warning, not the error, and the
// warning's later lines are indented with spaces under its first.
const REPEATED_EXIT = 16
const REPEATED_ERROR = '\nzip error: Invalid command arguments (cannot repeat names in zip file)\n'
const REPEATED_INDENT = ' '.repeat(21)
// Unix mode bits in the high half of external_attr.
const DIR_MODE = ((0o40755 << 16) | 0x10) >>> 0
const FILE_MODE = (0o100644 << 16) >>> 0
const LINK_MODE = (0o120777 << 16) >>> 0

// What zip needs from the mount it runs on. `stat` and `walk` are what
// make a directory operand archivable at all.
export interface ZipDeps {
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>
  write: (p: PathSpec, data: Uint8Array) => Promise<void>
  stat: StatFn
  walk: WalkFn
}

// The name Info-ZIP forms for a path before it stores it. A directory
// carries the slash zip appends to it before descending, so `d` and `d/`
// are one path.
function fullName(spelled: string, kind: MemberKind): string {
  if (kind === 'dir' && !spelled.endsWith('/')) return `${spelled}/`
  return spelled
}

function relative(name: string): string {
  let out = lstripSlash(name)
  while (out.startsWith('./')) out = out.slice(2)
  return out
}

// The entry name Info-ZIP stores for a path as the operand typed it.
// Leading slashes go in silence (unlike tar, which warns), and so does
// every `./` after them: `zip -r out.zip .` stores `a.txt`, not `./a.txt`,
// and `.` itself, formed as `./`, names nothing and is not stored. Only
// that leading run goes, so `d/./x` keeps its `./` and `.//x` stores `/x`.
// `-j` keeps what follows the last slash, which for a directory is
// nothing: `-j` stores no directory.
function memberName(spelled: string, kind: MemberKind, junk: boolean): string {
  const name = relative(fullName(spelled, kind))
  return junk ? name.slice(name.lastIndexOf('/') + 1) : name
}

// Whether an Info-ZIP `-x` pattern matches this entry name. Info-ZIP
// matches the whole stored name, anchored, with wildcards crossing
// slashes: `d/sub/*` takes `d/sub/` and everything under it, `*.txt`
// takes every `.txt` at any depth, and a bare `b.txt` matches nothing
// below the top. That is the opposite of GNU tar's unanchored
// `--exclude`, which is why the two have separate matchers. A pattern
// loses its leading slashes and `./` the way a name does, so `./sub/*`
// still takes `sub/`.
function excluded(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => fnmatch(name, relative(pattern)))
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// Info-ZIP's warning for the first name two paths would share: check_dup
// sorts the stored names and reports the first one reached from two
// different paths, those two in sorted order.
function repeatedWarning(formed: ReadonlyMap<string, string[]>, junk: boolean): string {
  const clashes = [...formed.entries()]
    .filter(([, fulls]) => fulls.length > 1)
    .map(([name]) => name)
    .sort(byCodeUnit)
  const name = clashes[0]
  if (name === undefined) return ''
  const [first, second] = [...(formed.get(name) ?? [])].sort(byCodeUnit)
  let warning =
    `  first full name: ${first ?? ''}\n` +
    `${REPEATED_INDENT} second full name: ${second ?? ''}\n` +
    `${REPEATED_INDENT}name in zip file repeated: ${name}`
  if (junk) warning += `\n${REPEATED_INDENT}this may be a result of using -j`
  return warning
}

/**
 * Decide every entry of a new archive, before writing any of it.
 *
 * Info-ZIP's defaults are tar's inverted twice over: a directory operand
 * contributes only itself unless `-r` says to descend, and a symlink is
 * followed unless `-y` says to store the link. Both are parameters of the
 * shared scan, so the traversal is the same one `tar -c` uses.
 */
async function planZip(
  paths: readonly PathSpec[],
  archive: PathSpec,
  deps: ZipDeps,
  opts: CommandOpts,
): Promise<ZipPlan> {
  const fl = new FlagView(opts.flags, specOf('zip'))
  const recurse = fl.asBool('r')
  const junk = fl.asBool('j')
  const exclude = fl.asList('x')
  const members: ZipMember[] = []
  const warnings: string[] = []
  const formed = new Map<string, string[]>()
  for (const path of paths) {
    const raw = path.rawPath
    const base = rstripSlash(path.virtual) || '/'
    // Info-ZIP walks a bare `.` with an empty prefix, so what it finds there
    // is named bare: `zip -r out.zip . a.txt` names a.txt once.
    const spelling = raw === '.' ? '' : raw
    const scan = await scanOperand(path, {
      stat: deps.stat,
      walk: deps.walk,
      links: opts.ns?.links ?? null,
      mounts: opts.ns?.mounts ?? null,
      dereference: !fl.asBool('y'),
      recurse,
    })
    for (const problem of scan.problems) {
      // Info-ZIP stores the directory it could not open and says nothing
      // about it (pinned on debian:stable-slim).
      if (problem.unreadable === true) continue
      const shown = respellOne(problem.path, base, raw)
      if (problem.fatal === true) warnings.push(NOT_MATCHED + shown)
      else warnings.push(`${shown}: ${problem.reason ?? ''}`)
    }
    if (scan.missing) continue
    for (const crossing of scan.crossings) {
      warnings.push(`${respellOne(crossing, base, raw)}: ${OTHER_FILESYSTEM}`)
    }
    for (const entry of scan.entries) {
      const spelled = respellOne(entry.namePath, base, spelling)
      const name = memberName(spelled, entry.kind, junk)
      if (name === '' || excluded(name, exclude)) continue
      const read = entry.read ?? null
      // Info-ZIP never stores the archive it is writing, and says
      // nothing about it.
      if (read !== null && read.virtual === archive.virtual) continue
      // One path named twice is stored once; two paths under one name are
      // the run's error, reported once everything is seen.
      const fulls = formed.get(name) ?? []
      formed.set(name, fulls)
      const full = fullName(spelled, entry.kind)
      if (fulls.includes(full)) continue
      fulls.push(full)
      if (fulls.length > 1) continue
      members.push({ name, kind: entry.kind, path: read, target: entry.target ?? '' })
    }
  }
  return {
    members,
    warnings,
    write: members.length > 0,
    repeated: repeatedWarning(formed, junk),
  }
}

function warningText(warnings: readonly string[], quiet: boolean): string {
  if (quiet) return ''
  return warnings.map((line) => WARNING_PREFIX + line + '\n').join('')
}

export async function zipGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  deps: ZipDeps,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('zip'))
  if (paths.length === 0) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode('zip: usage: zip archive.zip file1 [file2 ...]\n'),
      }),
    ]
  }
  const archivePath = paths[0]
  if (archivePath === undefined) return [null, new IOResult()]
  const quiet = fl.asBool('q')
  const plan = await planZip(paths.slice(1), archivePath, deps, opts)
  if (plan.repeated !== '') {
    const message = warningText([...plan.warnings, plan.repeated], quiet) + REPEATED_ERROR
    return [null, new IOResult({ exitCode: REPEATED_EXIT, stderr: ENC.encode(message) })]
  }
  if (!plan.write) {
    // Info-ZIP writes no archive when nothing matched, and the error is
    // not a warning: -q does not silence it.
    const message =
      warningText(plan.warnings, quiet) + `\nzip error: Nothing to do! (${archivePath.rawPath})\n`
    return [null, new IOResult({ exitCode: NOTHING_TO_DO_EXIT, stderr: ENC.encode(message) })]
  }

  const items: ZipItem[] = []
  const outputLines: string[] = []
  // A member the session may not read (a rule refused it below the
  // operand) aborts the run with zip's name on the refusal and writes no
  // archive. Deliberate divergence: Info-ZIP writes the rest, echoes
  // `could not open for reading` beside the adding line, and closes with
  // a read/skipped summary that needs every member's size and exit 18;
  // none of that is reproduced.
  for (const member of plan.members) {
    let data = new Uint8Array(0)
    if (member.kind === 'link') {
      data = ENC.encode(member.target)
    } else if (member.path !== null) {
      const raw = await materialize(deps.stream(member.path))
      data = new Uint8Array(raw.byteLength)
      data.set(raw)
    }
    const stored = member.kind === 'dir'
    const compressed = stored ? data : await deflateRaw(data)
    items.push({
      name: member.name,
      data,
      compressed,
      crc: crc32(data),
      method: stored ? 0 : 8,
      externalAttr:
        member.kind === 'dir' ? DIR_MODE : member.kind === 'link' ? LINK_MODE : FILE_MODE,
      localOffset: 0,
    })
    outputLines.push(`  adding: ${member.name}`)
  }
  const archive = buildZip(items)
  await deps.write(archivePath, archive)
  const stdout: ByteSource | null =
    !quiet && outputLines.length > 0 ? ENC.encode(outputLines.join('\n') + '\n') : null
  return [
    stdout,
    new IOResult({
      writes: { [archivePath.mountPath]: archive },
      stderr: ENC.encode(warningText(plan.warnings, quiet)),
    }),
  ]
}
