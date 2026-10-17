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
import { fsStrerror, isFsError, isEnoent, isEisdir } from '../../../errors/fs.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { crc32, deflateRawStream } from '../../../utils/compress.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { lstripSlash, rstripSlash } from '../../../utils/slash.ts'
import { respellOne } from '../../../utils/path.ts'
import { ByteSpool, ByteSlice } from '../../../io/spool.ts'
import { chunks } from '../../../io/cooperative.ts'
import { encodeRecord, readArchive, updateArchive } from './archive/zip_update.ts'
import { ZipUpdateError } from './archive/errors.ts'
import type { MemberKind, ZipArchive, ZipRecord } from './archive/types.ts'
import { OTHER_FILESYSTEM, scanOperand, type StatFn, type WalkFn } from './archive/walk.ts'
import { linksOf, mountsOf } from '../utils/links.ts'
import { formatOptionalRecords } from '../utils/output.ts'

const ENC = new TextEncoder()

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
// An archive zip cannot create ends the run before any member is added, -q
// or not (Info-ZIP's ZE_CREAT, exit 15). Info-ZIP prints it on stdout like
// every diagnostic; mirage keeps it on stderr with the rest. Mirrors
// zip_cmd.py.
const CREATE_EXIT = 15
// Unix mode bits in the high half of external_attr.
const DIR_MODE = ((0o40755 << 16) | 0x10) >>> 0
const FILE_MODE = (0o100644 << 16) >>> 0
const LINK_MODE = (0o120777 << 16) >>> 0

// What zip needs from the mount it runs on. `stat` and `walk` are what
// make a directory operand archivable at all.
export interface ZipDeps {
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>
  write: (p: PathSpec, data: ByteSource) => Promise<void>
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
interface ZipFlags {
  readonly recursive: boolean
  readonly junkPaths: boolean
  readonly quiet: boolean
  readonly storeLinks: boolean
  readonly exclude: readonly string[]
}

function parseFlags(bag: Record<string, FlagValue>): ZipFlags {
  const fl = new FlagView(bag, specOf('zip'))
  return {
    recursive: fl.asBool('r'),
    junkPaths: fl.asBool('j'),
    quiet: fl.asBool('q'),
    storeLinks: fl.asBool('y'),
    exclude: fl.asList('x'),
  }
}

async function planZip(
  paths: readonly PathSpec[],
  archive: PathSpec,
  deps: ZipDeps,
  ctx: Context,
  parsed: ZipFlags,
): Promise<ZipPlan> {
  const { recursive: recurse, junkPaths: junk, exclude } = parsed
  const members: ZipMember[] = []
  const warnings: string[] = []
  const formed = new Map<string, string[]>()
  for (const path of paths) {
    const raw = path.rawPath
    if (path.walkError !== null) {
      // The walk refused the operand before zip ran (the empty name, a
      // link loop above the name), which Info-ZIP matches to nothing,
      // whatever the errno.
      warnings.push(NOT_MATCHED + raw)
      continue
    }
    const base = rstripSlash(path.virtual) || '/'
    // Info-ZIP walks a bare `.` with an empty prefix, so what it finds there
    // is named bare: `zip -r out.zip . a.txt` names a.txt once.
    const spelling = raw === '.' ? '' : raw
    const scan = await scanOperand(path, {
      stat: deps.stat,
      walk: deps.walk,
      links: linksOf(ctx) ?? null,
      mounts: mountsOf(ctx) ?? null,
      dereference: !parsed.storeLinks,
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

function invalidArchive(path: PathSpec): CommandFnResult {
  return [
    null,
    new IOResult({
      exitCode: 3,
      stderr: ENC.encode(`\nzip error: Zip file structure invalid (${path.rawPath})\n`),
    }),
  ]
}

function createError(path: PathSpec, reason: string, warnings = ''): CommandFnResult {
  const message =
    warnings +
    `zip I/O error: ${reason}\n` +
    `zip error: Could not create output file (${path.rawPath})\n`
  return [null, new IOResult({ exitCode: CREATE_EXIT, stderr: ENC.encode(message) })]
}

export async function zipGeneric(
  paths: PathSpec[],
  ctx: Context,
  deps: ZipDeps,
): Promise<CommandFnResult> {
  const parsed = parseFlags(ctx.flags)
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
  const originalSpool = new ByteSpool()
  const additionsSpool = new ByteSpool()
  try {
    let original: ZipArchive | null = null
    try {
      await originalSpool.fill(deps.stream(archivePath))
      original = await readArchive(originalSpool)
    } catch (err) {
      if (err instanceof ZipUpdateError || isEisdir(err)) return invalidArchive(archivePath)
      // Only absence means create; a refused or broken read must not overwrite.
      if (!isEnoent(err)) {
        if (!isFsError(err)) throw err
        return createError(archivePath, String(fsStrerror(err)))
      }
    }
    const quiet = parsed.quiet
    const plan = await planZip(paths.slice(1), archivePath, deps, ctx, parsed)
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

    const additions: ZipRecord[] = []
    const outputLines: string[] = []
    // A member the session may not read (a rule refused it below the
    // operand) aborts the run with zip's name on the refusal and writes no
    // archive. Deliberate divergence: Info-ZIP writes the rest, echoes
    // `could not open for reading` beside the adding line, and closes with
    // a read/skipped summary that needs every member's size and exit 18;
    // none of that is reproduced.
    const oldOrder = new Map(original?.records.map((entry, i) => [entry.name, i]))
    const members = [...plan.members].sort(
      (a, b) => (oldOrder.get(a.name) ?? oldOrder.size) - (oldOrder.get(b.name) ?? oldOrder.size),
    )
    for (const member of members) {
      const source =
        member.path !== null
          ? deps.stream(member.path)
          : chunks(member.kind === 'link' ? ENC.encode(member.target) : new Uint8Array())
      let size = 0
      let crc = 0
      async function* counted(): AsyncGenerator<Uint8Array> {
        for await (const data of chunks(source)) {
          size += data.length
          crc = crc32(data, crc)
          yield data
        }
      }
      const start = additionsSpool.size
      await additionsSpool.fill(member.kind === 'dir' ? counted() : deflateRawStream(counted()))
      const name = ENC.encode(member.name)
      if (name.length > 0xffff) return invalidArchive(archivePath)
      const compressed = additionsSpool.size - start
      const [head, central] = encodeRecord(
        name,
        member.kind === 'dir' ? 0 : 8,
        crc,
        compressed,
        size,
        member.kind === 'dir' ? DIR_MODE : member.kind === 'link' ? LINK_MODE : FILE_MODE,
      )
      additions.push({
        name: member.name,
        local: new ByteSlice(additionsSpool, start, compressed),
        central,
        head,
      })
      outputLines.push(`${oldOrder.has(member.name) ? 'updating:' : '  adding:'} ${member.name}`)
    }
    try {
      await deps.write(archivePath, updateArchive(original, additions))
    } catch (err) {
      if (!isFsError(err)) throw err
      return createError(archivePath, String(fsStrerror(err)), warningText(plan.warnings, quiet))
    }
    const stdout: ByteSource | null = !quiet ? formatOptionalRecords(outputLines) : null
    return [stdout, new IOResult({ stderr: ENC.encode(warningText(plan.warnings, quiet)) })]
  } finally {
    try {
      await originalSpool.close()
    } finally {
      await additionsSpool.close()
    }
  }
}
