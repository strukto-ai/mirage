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
import { OPERAND } from '../../spec/constants.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import { ensureDir, extractDest, type StatDoor } from './archive/extract.ts'
import {
  renderHeader,
  renderRow,
  renderTotals,
  renderVerbose,
  zipinfoLayout,
  type ZipRow,
} from './archive/zipinfo.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { inflateRaw } from '../../../utils/compress.ts'
import { type CommandFnResult, type CommandOpts } from '../../config.ts'
import { versionLine } from '../../spec/standard.ts'
import { UsageError } from '../../errors.ts'
import { lstripSlash, rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { errorVirtualPath, fsStrerror, isFsError } from '../../../utils/errors.ts'
import { isDirectory, pathExists } from '../utils/copy.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

// One central-directory entry: zipinfo's row plus a door to its bytes.
// The bytes are inflated on demand, so a listing never touches them and
// an archive using a method mirage cannot inflate still lists.
export interface ZipEntry extends ZipRow {
  content: () => Promise<Uint8Array>
}

// Info-ZIP's wording and spacing, verbatim (two spaces after the colon).
const CAUTION_PREFIX = 'caution: filename not matched:  '
const EXCLUDED_CAUTION_PREFIX = 'caution: excluded filename not matched:  '

const LOCAL_HEADER_SIG = 0x04034b50
const CENTRAL_HEADER_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const EOCD_LEN = 22
// Info-ZIP looks for the end-of-central-directory record in the last
// 65557 bytes (a 22-byte record behind a comment of at most 65535); a
// file without one is not an archive at all, whatever its name says.
const EOCD_SEARCH = 65557
// Info-ZIP's refusals verbatim (process.c). The paragraph is shared;
// unzip signs it below, zipinfo signs it below under its own name, and
// -p names the archive above it and does not sign. The exit codes are
// theirs too: 9 for no archive, 3 for a corrupt one.
const NO_EOCD =
  '  End-of-central-directory signature not found.  Either this file is not\n' +
  '  a zipfile, or it constitutes one disk of a multi-part archive.  In the\n' +
  '  latter case the central directory and zipfile comment will be found on\n' +
  '  the last disk(s) of this archive.\n'
const NO_ARCHIVE_EXIT = 9
const CORRUPT_EXIT = 3
// The end record says where the central directory should start; bytes
// before the archive (a self-extractor stub) push it later, and Info-ZIP
// reports the difference as a warning (exit 1) and carries on with every
// offset shifted, or as an error (exit 2) when bytes are missing instead.
// Info-ZIP prints this on stdout under -t, after the archive line, and
// between the header and the rows under -Z, where mirage keeps it on stderr.
const WARN_EXIT = 1
const MISSING_EXIT = 2
// What -t says when every member it tested was sound: the whole archive, or
// the members a pattern chose (Info-ZIP 6.00).
const TESTED_ALL = (archive: string): string =>
  `No errors detected in compressed data of ${archive}.\n`
const TESTED_SOME = (archive: string, count: number): string =>
  `No errors detected in ${archive} for the ${String(count)} file${count === 1 ? '' : 's'} tested.\n`
const TESTING = (name: string): string => `    testing: ${name.padEnd(22)}   OK\n`
// A -d in a mode that writes nothing (Info-ZIP 6.00).
const D_IGNORED = 'caution:  not extracting; -d ignored\n'

/**
 * The member patterns and the -x patterns, as Info-ZIP reads them: -x takes
 * every operand typed after it, up to a -d, so the operands are placed by
 * where the flag tape recorded them; the first is the archive. A line whose
 * operands the tape does not account for keeps one pattern per -x. Mirrors
 * Python's _patterns.
 */
function patterns(
  fl: FlagView,
  texts: readonly string[],
  excludes: readonly string[],
): [string[], string[]] {
  const tape = fl.occurrences('x', 'd', OPERAND)
  if (tape.filter(([name]) => name === OPERAND).length !== texts.length + 1) {
    return [[...texts], [...excludes]]
  }
  const members: string[] = []
  const excluded: string[] = []
  let listing = false
  let index = -1
  for (const [name, value] of tape) {
    if (name === OPERAND) {
      const word = texts[index]
      if (index >= 0 && word !== undefined) (listing ? excluded : members).push(word)
      index += 1
    } else if (name === 'x' && typeof value === 'string') {
      excluded.push(value)
      listing = true
    } else if (name === 'd') {
      listing = false
    }
  }
  return [members, excluded]
}

function slackWarning(slack: number, archive: string): [string, number] {
  if (slack < 0) {
    return [
      `error [${archive}]:  missing ${String(-slack)} bytes in zipfile\n  (attempting to process anyway)\n`,
      MISSING_EXIT,
    ]
  }
  const plural = slack === 1 ? '' : 's'
  return [
    `warning [${archive}]:  ${String(slack)} extra byte${plural} at beginning or within zipfile\n  (attempting to process anyway)\n`,
    WARN_EXIT,
  ]
}
// Info-ZIP answers an option it does not know with its usage block and
// exit 10; -1, -2 and -h are zipinfo's letters and mean nothing to unzip
// proper (Info-ZIP's `unzip -h` is its help screen).
const USAGE_EXIT = 10

function unzipNoDirectory(archive: string): string {
  return (
    `unzip:  cannot find zipfile directory in one of ${archive} or\n` +
    `        ${archive}.zip, and cannot find ${archive}.ZIP, period.\n`
  )
}

function zipinfoNoDirectory(archive: string): string {
  return (
    `zipinfo:  cannot find zipfile directory in one of ${archive} or\n` +
    `          ${archive}.zip, and cannot find ${archive}.ZIP, period.\n`
  )
}

function corruptCdir(archive: string): string {
  return (
    `error [${archive}]:  start of central directory not found;\n` +
    '  zipfile corrupt.\n' +
    '  (please check that you have transferred or created the zipfile in the\n' +
    '  appropriate BINARY mode and that you have compiled UnZip properly)\n'
  )
}

// What the central directory walk found wrong: no end record at all, or
// an end record whose directory is not where it says.
type ZipFault = 'no_eocd' | 'corrupt_cdir'

export class ZipFormatError extends Error {
  readonly fault: ZipFault

  constructor(fault: ZipFault) {
    super(fault)
    this.fault = fault
  }
}

// Info-ZIP's answer to a file it could not open as an archive.
function refusal(fault: ZipFault, archive: string, zipinfo: boolean, pipe: boolean): IOResult {
  if (fault === 'corrupt_cdir') {
    return new IOResult({ exitCode: CORRUPT_EXIT, stderr: ENC.encode(corruptCdir(archive)) })
  }
  const head = pipe || zipinfo ? `[${archive}]\n` : ''
  const tail = pipe ? '' : zipinfo ? zipinfoNoDirectory(archive) : unzipNoDirectory(archive)
  return new IOResult({ exitCode: NO_ARCHIVE_EXIT, stderr: ENC.encode(head + NO_EOCD + tail) })
}

// Info-ZIP matches filespecs against the encoded name, so `?` stands for
// one byte, not one code point: `?.txt` misses `é.txt` and `??.txt` hits
// it. Both sides are flattened to one UTF-16 unit per byte so the regex
// counts bytes.
function byteString(s: string): string {
  const bytes = ENC.encode(s)
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return out
}

function memberRegex(pattern: string): RegExp {
  let out = '^'
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i] ?? ''
    if (ch === '*') {
      while (pattern[i] === '*') i++
      out += '[\\s\\S]*'
      continue
    }
    if (ch === '?') {
      out += '[\\s\\S]'
      i++
      continue
    }
    if (ch === '[') {
      let j = i + 1
      if (pattern[j] === '!' || pattern[j] === '^') j++
      if (pattern[j] === ']') j++
      while (j < pattern.length && pattern[j] !== ']') j++
      if (j >= pattern.length) {
        out += '\\['
        i++
        continue
      }
      let cls = pattern.slice(i + 1, j).replace(/\\/g, '\\\\')
      if (cls.startsWith('!')) cls = '^' + cls.slice(1)
      out += '[' + cls + ']'
      i = j + 1
      continue
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    i++
  }
  return new RegExp(out + '$')
}

interface MemberSelection {
  selected: ZipEntry[]
  unmatched: string[]
  unmatchedExcludes: string[]
}

// Info-ZIP walks the archive in order and charges each entry to the
// first filespec that matches it, so a spec shadowed by an earlier one
// reports "filename not matched" even when its file was printed. An
// entry a member pattern chose still counts for that pattern when an
// exclude then drops it.
function selectEntries(
  entries: ZipEntry[],
  members: readonly string[],
  excludes: readonly string[],
): MemberSelection {
  if (members.length === 0 && excludes.length === 0) {
    return { selected: entries, unmatched: [], unmatchedExcludes: [] }
  }
  const regexes = members.map((m) => memberRegex(byteString(m)))
  const excludeRegexes = excludes.map((m) => memberRegex(byteString(m)))
  const hit = members.map(() => false)
  const excludedHit = excludes.map(() => false)
  const selected: ZipEntry[] = []
  for (const e of entries) {
    const name = byteString(e.name)
    if (members.length > 0) {
      const idx = regexes.findIndex((r) => r.test(name))
      if (idx === -1) continue
      hit[idx] = true
    }
    const xidx = excludeRegexes.findIndex((r) => r.test(name))
    if (xidx !== -1) {
      excludedHit[xidx] = true
      continue
    }
    selected.push(e)
  }
  const unmatched = members.filter((_, i) => hit[i] !== true)
  const unmatchedExcludes = excludes.filter((_, i) => excludedHit[i] !== true)
  return { selected, unmatched, unmatchedExcludes }
}

function cautionText(unmatched: readonly string[], excluded: readonly string[] = []): string {
  return (
    unmatched.map((m) => CAUTION_PREFIX + m + '\n').join('') +
    excluded.map((m) => EXCLUDED_CAUTION_PREFIX + m + '\n').join('')
  )
}

function readU16LE(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8)
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) |
      ((data[offset + 1] ?? 0) << 8) |
      ((data[offset + 2] ?? 0) << 16) |
      ((data[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

function findEocd(data: Uint8Array): number {
  const floor = Math.max(0, data.byteLength - EOCD_SEARCH)
  for (let i = data.byteLength - EOCD_LEN; i >= floor; i--) {
    if (readU32LE(data, i) === EOCD_SIG) return i
  }
  return -1
}

function dosDateTime(date: number, time: number): ZipRow['dateTime'] {
  return [
    1980 + ((date >> 9) & 0x7f),
    (date >> 5) & 0x0f,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  ]
}

// Read the archive the way Info-ZIP does: from the end-of-central-directory
// record back through the central directory, which is the only place the
// entry list is authoritative. A stream of local headers (the previous
// reading) accepted any file whose first four bytes were not a header as
// an empty archive, and never saw a data descriptor. Bytes prepended to
// the archive (a self-extractor stub) shift every offset by the same
// amount, which the record's own position reveals; Info-ZIP warns about
// them and mirage, like zipfile, adjusts silently. The directory ends
// where the record begins, and the record's entry count must tile it
// exactly: an entry reaching past the end, or a count that leaves bytes
// over, is a corrupt directory. Info-ZIP and zipfile read the truncated
// entry anyway (Info-ZIP lists it and exits 1 or 51; a short count makes
// Info-ZIP exit 3 after listing); mirage refuses up front on both hosts.
export function readZipEntries(data: Uint8Array): {
  entries: ZipEntry[]
  count: number
  slack: number
  comment: Uint8Array
} {
  const eocd = findEocd(data)
  if (eocd === -1) throw new ZipFormatError('no_eocd')
  const count = readU16LE(data, eocd + 10)
  const cdSize = readU32LE(data, eocd + 12)
  const cdOffset = readU32LE(data, eocd + 16)
  const shift = eocd - (cdOffset + cdSize)
  let offset = cdOffset + shift
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (offset < 0 || offset + 46 > eocd || readU32LE(data, offset) !== CENTRAL_HEADER_SIG) {
      throw new ZipFormatError('corrupt_cdir')
    }
    const madeBy = readU16LE(data, offset + 4)
    const flags = readU16LE(data, offset + 8)
    const method = readU16LE(data, offset + 10)
    const time = readU16LE(data, offset + 12)
    const date = readU16LE(data, offset + 14)
    const crc = readU32LE(data, offset + 16)
    const csize = readU32LE(data, offset + 20)
    const size = readU32LE(data, offset + 24)
    const nameLen = readU16LE(data, offset + 28)
    const extraLen = readU16LE(data, offset + 30)
    const commentLen = readU16LE(data, offset + 32)
    const internalAttr = readU16LE(data, offset + 36)
    const externalAttr = readU32LE(data, offset + 38)
    const localOffset = readU32LE(data, offset + 42) + shift
    const next = offset + 46 + nameLen + extraLen + commentLen
    if (next > eocd) throw new ZipFormatError('corrupt_cdir')
    const name = DEC.decode(data.subarray(offset + 46, offset + 46 + nameLen))
    let inflated: Promise<Uint8Array> | null = null
    const content = (): Promise<Uint8Array> => {
      inflated ??= entryContent(data, localOffset, method, csize)
      return inflated
    }
    entries.push({
      name,
      size,
      csize,
      method,
      flags,
      internalAttr,
      externalAttr,
      host: madeBy >> 8,
      hostVersion: madeBy & 0xff,
      dateTime: dosDateTime(date, time),
      hasExtra: extraLen > 0,
      crc,
      comment: data.subarray(offset + 46 + nameLen + extraLen, next),
      content,
    })
    offset = next
  }
  if (offset !== eocd) throw new ZipFormatError('corrupt_cdir')
  const comment = data.subarray(eocd + EOCD_LEN, eocd + EOCD_LEN + readU16LE(data, eocd + 20))
  return { entries, count, slack: shift, comment }
}

// Info-ZIP's line for one extracted file, `%8sing: %-22s  %s`: a stored entry
// is `extracting`, a compressed one `inflating`, and the name is padded to 22
// columns and followed by two blanks, the room Info-ZIP keeps for a -a note.
// Mirrors Python's `_extracted_line`.
function extractedLine(method: number, shown: string): string {
  const verb = method === 0 ? 'extract' : 'inflat'
  return `${verb.padStart(8)}ing: ${shown.padEnd(22)}  `
}

async function entryContent(
  data: Uint8Array,
  localOffset: number,
  method: number,
  csize: number,
): Promise<Uint8Array> {
  if (readU32LE(data, localOffset) !== LOCAL_HEADER_SIG) throw new ZipFormatError('corrupt_cdir')
  const nameLen = readU16LE(data, localOffset + 26)
  const extraLen = readU16LE(data, localOffset + 28)
  const start = localOffset + 30 + nameLen + extraLen
  const body = data.subarray(start, start + csize)
  if (method === 0) return body.slice()
  if (method === 8) return inflateRaw(body)
  throw new Error(`unzip: unsupported compression method: ${String(method)}`)
}

function makePathSpec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: stripSlash(virtual),
    resolved: true,
  })
}

// Info-ZIP's refusals of a create: a member it cannot write (exit 50,
// PK_DISK), a directory of the chain it cannot make or that a file already
// holds (exit 2, and the next member still extracts), and an extraction
// directory it cannot make (exit 2, before any member). The strerror line
// hangs under the text after the label, as UnZip 6.00 indents it. Mirrors
// unzip.py.
const CREATE_EXIT = 50
const CHECKDIR_EXIT = 2
const DEST_EXIT = 2

function createError(verb: string, name: string, strerror: string): string {
  return `error:  cannot ${verb} ${name}\n        ${strerror}\n`
}

function checkdirError(dir: string, strerror: string, member: string): string {
  return (
    `checkdir error:  cannot create ${dir}\n                 ${strerror}\n` +
    `                 unable to process ${member}.\n`
  )
}

function checkdirFile(dir: string, member: string): string {
  return (
    `checkdir error:  ${dir} exists but is not directory\n` +
    `                 unable to process ${member}.\n`
  )
}

// The first level of `chain` below `base` that is not a directory, which
// Info-ZIP names ("exists but is not directory") instead of the mkdir that
// failed under it. Mirrors Python's `_file_in_chain`.
async function fileInChain(stat: StatDoor, base: string, chain: string): Promise<string | null> {
  let level = base
  for (const part of chain
    .slice(base.length)
    .split('/')
    .filter((p) => p !== '')) {
    level = `${level}/${part}`
    const node = makePathSpec(level)
    if (!(await pathExists(stat, node))) return null
    if (!(await isDirectory(stat, node))) return level
  }
  return null
}

function checkdirDest(dir: string, strerror: string): string {
  return `checkdir:  cannot create extraction directory: ${dir}\n           ${strerror}\n`
}

export async function unzipGeneric(
  paths: PathSpec[],
  members: readonly string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  mkdir: (p: PathSpec, parents?: boolean) => Promise<void>,
  stat?: StatDoor,
  relay = false,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('unzip'))
  const verbose = fl.asBool('v')
  if (paths.length === 0) {
    // Info-ZIP answers -v without an archive with its version banner, and
    // mirage's version line is that banner here.
    if (verbose) return [ENC.encode(versionLine('unzip')), new IOResult()]
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('unzip: missing operand\n') })]
  }
  const listMode = fl.asBool('args_l')
  const testMode = fl.asBool('t')
  const pipeMode = fl.asBool('p')
  const quiet = fl.asBool('q')
  const zipinfoMode = fl.asBool('Z')
  const namesOnly = fl.asBool('args_1')
  const namesHeaders = fl.asBool('2')
  const short = fl.asBool('s')
  const medium = fl.asBool('m')
  const header = fl.asBool('h')
  const [chosen, excludes] = patterns(fl, members, fl.asList('x'))
  if (!zipinfoMode) {
    const zipinfoOnly: [string, boolean][] = [
      ['-1', namesOnly],
      ['-2', namesHeaders],
      ['-s', short],
      ['-m', medium],
      ['-h', header],
    ]
    for (const [letter, given] of zipinfoOnly) {
      if (given)
        throw new UsageError(`unzip: ${letter} is a ZipInfo option and needs -Z`, USAGE_EXIT)
    }
  }
  const operand = paths[0]
  if (operand === undefined) return [null, new IOResult()]
  // Relay doors address by full virtual path (flatten's convention),
  // not by the mount-relative key the wrapper's accessor stamped.
  const archivePath: PathSpec = relay
    ? new PathSpec({
        virtual: operand.virtual,
        directory: operand.virtual,
        vfsPath: stripSlash(operand.virtual),
        resolved: true,
        rawPath: operand.rawPath,
      })
    : operand
  const data = await materialize(stream(archivePath))
  let entries: ZipEntry[]
  let count: number
  let slack: number
  let comment: Uint8Array
  try {
    ;({ entries, count, slack, comment } = readZipEntries(data))
  } catch (err) {
    if (err instanceof ZipFormatError) {
      return [null, refusal(err.fault, archivePath.rawPath, zipinfoMode, pipeMode)]
    }
    throw err
  }
  const { selected, unmatched, unmatchedExcludes } = selectEntries(entries, chosen, excludes)
  const filtered = chosen.length > 0 || excludes.length > 0
  const [warning, floor] = slack !== 0 ? slackWarning(slack, archivePath.rawPath) : ['', 0]
  // Every pattern, member or -x, that matched nothing is reported, and a
  // filter that leaves nothing exits 11 in every mode.
  const nothingLeft = filtered && selected.length === 0
  const cautions = cautionText(unmatched, unmatchedExcludes)

  async function run(): Promise<CommandFnResult> {
    if (zipinfoMode) {
      const layout = zipinfoLayout({
        namesOnly,
        namesHeaders,
        long: listMode,
        medium,
        short,
        header,
        totals: testMode,
        hasMembers: filtered,
      })
      const parts: string[] = []
      if (layout.header) parts.push(renderHeader(archivePath.virtual, data.byteLength, count))
      if (layout.rows === 'names') {
        for (const e of selected) parts.push(e.name + '\n')
      } else if (layout.rows !== 'none') {
        for (const e of selected) parts.push(renderRow(e, layout.rows) + '\n')
      }
      if (layout.totals) parts.push(renderTotals(selected))
      const listing: ByteSource | null = parts.length > 0 ? ENC.encode(parts.join('')) : null
      const exitCode = nothingLeft ? 11 : 0
      const stderr = cautions !== '' ? ENC.encode(cautions) : null
      return [listing, new IOResult({ exitCode, stderr })]
    }
    const mountPrefix = relay ? '' : mountPrefixOf(archivePath.virtual, archivePath.vfsPath)
    const destRaw = extractDest(fl.asStr('d') ?? null, opts.cwd)
    const dest =
      mountPrefix !== '' && destRaw.startsWith(mountPrefix + '/')
        ? destRaw.slice(mountPrefix.length)
        : destRaw === mountPrefix
          ? '/'
          : destRaw

    // Info-ZIP lists only when neither -t nor -p asks for another mode,
    // and -v widens -l's columns into the verbose table.
    if ((listMode || verbose) && !(testMode || pipeMode)) {
      let out: ByteSource
      if (verbose) {
        out = renderVerbose(archivePath.virtual, selected, quiet, comment)
      } else {
        const lines = ['  Length      Name', '---------  ----']
        for (const e of selected) {
          lines.push(`${String(e.size).padStart(9, ' ')}  ${e.name}`)
        }
        out = ENC.encode(lines.join('\n') + '\n')
      }
      // GNU -l prints no caution lines and only exits 11 when the
      // patterns left nothing at all.
      if (nothingLeft) {
        return [out, new IOResult({ exitCode: 11 })]
      }
      return [out, new IOResult()]
    }

    if (testMode) {
      // GNU -t heads its report with the archive as typed and reports
      // unmatched patterns on stdout; an unmatched member counts as an
      // error, an unmatched exclude does not, and a filter that leaves
      // nothing is its own caution.
      const shown = archivePath.rawPath
      const head = (quiet ? '' : `Archive:  ${shown}\n`) + warning
      if (unmatched.length > 0) {
        const msg = head + cautions + `At least one error was detected in ${shown}.\n`
        return [ENC.encode(msg), new IOResult({ exitCode: 11 })]
      }
      if (nothingLeft) {
        const msg = head + cautions + `Caution:  zero files tested in ${shown}.\n`
        return [ENC.encode(msg), new IOResult({ exitCode: 11 })]
      }
      const tested = quiet ? '' : selected.map((e) => TESTING(e.name)).join('')
      const tail = filtered ? TESTED_SOME(shown, selected.length) : TESTED_ALL(shown)
      const out: ByteSource = ENC.encode(head + tested + cautions + tail)
      return [out, new IOResult()]
    }

    const exitCode = unmatched.length > 0 || nothingLeft ? 11 : 0
    const stderr = cautions !== '' ? ENC.encode(cautions) : null

    if (pipeMode) {
      const chunks: Uint8Array[] = []
      for (const e of selected) {
        if (!e.name.endsWith('/')) chunks.push(await e.content())
      }
      let total = 0
      for (const c of chunks) total += c.byteLength
      const merged = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) {
        merged.set(c, offset)
        offset += c.byteLength
      }
      const out: ByteSource = merged
      return [out, new IOResult({ exitCode, stderr })]
    }

    const base = rstripSlash(dest)
    // Info-ZIP names an extracted path as the -d directory was typed
    // followed by the member, or the bare member; the archive heads the
    // listing as it was typed too. Mirrors unzip.py.
    const typedDest = fl.asPaths('d')[0]?.rawPath ?? fl.asStr('d') ?? ''
    const shown = (path: string): string => {
      const rel = lstripSlash(path.slice(base.length))
      return typedDest !== '' ? `${rstripSlash(typedDest)}/${rel}` : rel
    }
    const makeDirs = async (dir: string): Promise<void> => {
      if (stat !== undefined) await ensureDir(dir, makePathSpec, mkdir, stat, made)
      else await mkdir(makePathSpec(dir), true)
    }
    const writes: Record<string, Uint8Array> = {}
    const outputLines: string[] = quiet ? [] : [`Archive:  ${archivePath.rawPath}`]
    const errors: string[] = []
    const made = new Set<string>()
    const listing = (): ByteSource | null =>
      outputLines.length > 0 ? ENC.encode(outputLines.join('\n') + '\n') : null
    if (fl.raw('d') !== undefined) {
      try {
        await makeDirs(dest)
      } catch (err) {
        if (!isFsError(err)) throw err
        return [
          listing(),
          new IOResult({
            exitCode: DEST_EXIT,
            stderr: ENC.encode(checkdirDest(typedDest, String(fsStrerror(err)))),
          }),
        ]
      }
    }
    let checkdirFailed = false
    let createFailed = false
    for (const e of selected) {
      const entryName = lstripSlash(e.name)
      const outPath = base + '/' + rstripSlash(entryName)
      const isDir = e.name.endsWith('/')
      // A directory entry is the only record an empty directory leaves, so
      // it has to be recreated even though nothing is written inside it.
      const parentEnd = outPath.lastIndexOf('/')
      const chain = isDir ? outPath : parentEnd > 0 ? outPath.slice(0, parentEnd) : ''
      let existed = false
      try {
        existed = isDir && stat !== undefined && (await pathExists(stat, makePathSpec(outPath)))
        if (chain !== '' && chain !== '/') await makeDirs(chain)
      } catch (err) {
        if (!isFsError(err)) throw err
        checkdirFailed = true
        let blocker: string | null = null
        if (stat !== undefined) {
          try {
            blocker = await fileInChain(stat, base, chain)
          } catch (probe) {
            if (!isFsError(probe)) throw probe
          }
        }
        errors.push(
          blocker !== null
            ? checkdirFile(shown(blocker), e.name)
            : checkdirError(shown(errorVirtualPath(err)), String(fsStrerror(err)), e.name),
        )
        continue
      }
      if (isDir) {
        if (!quiet && !existed) outputLines.push(`   creating: ${shown(outPath)}/`)
        continue
      }
      const content = await e.content()
      try {
        await write(makePathSpec(outPath), content)
      } catch (err) {
        if (!isFsError(err)) throw err
        // -o unlinks a file already there before it writes, so a refusal of
        // that is its own verb.
        createFailed = true
        const existed = stat !== undefined && (await pathExists(stat, makePathSpec(outPath)))
        errors.push(
          createError(existed ? 'delete old' : 'create', shown(outPath), String(fsStrerror(err))),
        )
        continue
      }
      // Relay writes land on whichever mount owns each path and
      // invalidate through the dispatcher; keying them here would have
      // the runner prefix them onto this mount.
      if (!relay) writes[outPath] = content
      if (!quiet) outputLines.push(extractedLine(e.method, shown(outPath)))
    }
    const allStderr = ENC.encode(cautions + errors.join(''))
    return [
      listing(),
      new IOResult({
        exitCode: createFailed ? CREATE_EXIT : checkdirFailed ? CHECKDIR_EXIT : exitCode,
        stderr: allStderr.byteLength > 0 ? allStderr : null,
        writes,
      }),
    ]
  }

  const result = await run()
  // A mode that writes nothing says so about -d first; -t prints the
  // offset warning on stdout, every other mode on stderr.
  const writesNothing = zipinfoMode || testMode || pipeMode || listMode || verbose
  const caution = fl.asStr('d') !== undefined && writesNothing ? D_IGNORED : ''
  const onStderr = testMode && !zipinfoMode ? '' : warning
  if ((caution === '' && onStderr === '' && slack === 0) || result === null) return result
  const [out, io] = result
  const lead = ENC.encode(caution + onStderr)
  const rest = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array()
  const merged = new Uint8Array(lead.byteLength + rest.byteLength)
  merged.set(lead, 0)
  merged.set(rest, lead.byteLength)
  return [
    out,
    new IOResult({
      exitCode: Math.max(io.exitCode, floor),
      stderr: merged.byteLength > 0 ? merged : null,
      writes: io.writes,
    }),
  ]
}
