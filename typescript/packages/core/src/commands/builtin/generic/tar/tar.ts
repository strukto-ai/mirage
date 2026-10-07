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

import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { mountKey } from '../../../../utils/key_prefix.ts'
import { IOResult, materialize, type ByteSource } from '../../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../../types.ts'
import { gzip, gunzipPartial, getCompressionCodec } from '../../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts } from '../../../config.ts'
import { readTar, writeTar, type TarEntry } from '../../tar_helper.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import {
  CHILD_NAME,
  CHILD_STATUS,
  FOREIGN_INPUT,
  COMPRESSION_SIGNATURES,
  CREATE_ERROR_EXIT,
  EMPTY_PIPE,
  ERROR_TRAILER,
  FATAL_TRAILER,
  INVALID_ARCHIVE,
  UNEXPECTED_EOF,
  MODE_CONFLICT,
  MULTIPLE_ARCHIVES,
  NO_MODE,
  STRIP_COUNT,
  TAPE_START,
  USAGE_HINT,
} from './constants.ts'
import { C_SPACE, UINTMAX } from '../../constants.ts'
import { UsageError } from '../../../errors.ts'
import type { FlagValue } from '../../../spec/types.ts'
import { checkDirectories, planCreate, type DirProbe, type StatFn, type WalkFn } from './create.ts'
import { eisdir, fsStrerror, isEacces, isFsError } from '../../../../errors/fs.ts'
import { GzipDataError } from '../../../../utils/compress.ts'
import { stdinStream } from '../../utils/stream.ts'
import { lsModeString } from '../../utils/formatting.ts'
import { ensureDir, extractDest } from '../archive/extract.ts'
import type { Compression, CompressionKind, CreateResult, ReadResult } from './types.ts'

const ENC = new TextEncoder()

const DOTDOT_NOTICE = "tar: Removing leading `../' from member names"

/**
 * Whether one -t/-x member selector keeps an archive member.
 *
 * GNU matches the stored spelling exactly (`memory/x` does not find
 * `./memory/x`), and a selector naming a directory takes its whole
 * subtree, with or without the trailing slash.
 */
function matchesSelector(name: string, selector: string): boolean {
  const base = rstripSlash(selector)
  const trimmed = rstripSlash(name)
  return trimmed === base || trimmed.startsWith(`${base}/`)
}

/**
 * Member indices the selectors keep, and the misses they report.
 *
 * No selector keeps everything. A selector that matches nothing is
 * GNU's per-operand diagnostic, reported in operand order; the caller
 * appends the one failure trailer.
 */
function selectedMembers(
  names: readonly string[],
  selectors: readonly string[],
): { keep: Set<number>; misses: string[] } {
  if (selectors.length === 0) {
    return { keep: new Set(names.map((_, index) => index)), misses: [] }
  }
  const keep = new Set<number>()
  const misses: string[] = []
  for (const selector of selectors) {
    let hit = false
    for (const [index, name] of names.entries()) {
      if (matchesSelector(name, selector)) {
        keep.add(index)
        hit = true
      }
    }
    if (!hit) misses.push(`tar: ${selector}: Not found in archive`)
  }
  return { keep, misses }
}

/**
 * The destination-relative components one member extracts to.
 *
 * GNU strips --strip-components off the stored spelling first, in which
 * a leading `.` counts as a component (--strip-components=1 turns
 * `./a/b` into `a/b`). Only then is the remainder cleaned for the
 * filesystem: `.` components vanish (a real OS resolves them; a virtual
 * path must not keep a literal `.` directory) and a leading `..` is
 * removed with GNU's one notice per run.
 */
function outParts(name: string, stripN: number, notices: string[]): string[] {
  let parts = rstripSlash(name).split('/')
  if (stripN > 0) parts = parts.slice(stripN)
  parts = parts.filter((part) => part !== '' && part !== '.')
  while (parts.length > 0 && parts[0] === '..') {
    if (!notices.includes(DOTDOT_NOTICE)) notices.push(DOTDOT_NOTICE)
    parts.shift()
  }
  return parts
}

// What tar needs from the mount it runs on. `stat` and `walk` are what
// make a directory operand archivable at all; `isDir` answers on two
// channels so a prefix-store directory (no object of its own) is not
// mistaken for an absent one.
export interface TarDeps {
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>
  write: (p: PathSpec, data: Uint8Array) => Promise<void>
  mkdir: (p: PathSpec, parents?: boolean) => Promise<void>
  stat: StatFn
  walk: WalkFn
  isDir: DirProbe
}

function makePathSpec(virtual: string, prefix: string, operand?: PathSpec): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: mountKey(virtual, prefix),
    resolved: true,
    rawPath: operand?.rawPath ?? virtual,
    dotted: operand?.dotted ?? null,
    walkError: operand?.walkError ?? null,
  })
}

function detectCompression(data: Uint8Array): Compression {
  for (const kind of Object.keys(COMPRESSION_SIGNATURES) as CompressionKind[]) {
    const signature = COMPRESSION_SIGNATURES[kind]
    if (
      data.byteLength >= signature.length &&
      signature.every((byte, index) => data[index] === byte)
    ) {
      return kind
    }
  }
  return null
}

/** tar's flags as argp read them. Mirrors Python's TarFlags. */
export interface TarFlags {
  create: boolean
  extract: boolean
  list: boolean
  compression: Compression
  verbose: boolean
  dereference: boolean
  toStdout: boolean
  archive: PathSpec | null
  directories: PathSpec[]
  stripComponents: number
  exclude: string | null
  oneFileSystem: boolean
}

const MODES = ['create', 'extract', 'list'] as const
const STRIP_COUNT_PATTERN = new RegExp(`^${C_SPACE}\\+?([0-9]+)$`)

/**
 * A --strip-components value as tar reads it, or tar's refusal: xstrtoumax
 * at base 10 with no suffix, so leading blanks and one `+` pass, a sign,
 * another letter or a count past UINTMAX does not (tar 1.35). Mirrors
 * Python's strip_count.
 */
export function stripCount(raw: string): number {
  const digits = STRIP_COUNT_PATTERN.exec(raw)?.[1]
  if (digits === undefined || BigInt(digits) > UINTMAX) {
    throw new UsageError(`${STRIP_COUNT.replace('{}', raw)}\n${USAGE_HINT}`, CREATE_ERROR_EXIT)
  }
  return Number(digits)
}

/**
 * tar's flags as argp reads them, refusing what tar refuses. argp meets the
 * options in line order and stops at the first it refuses: a second main
 * operation where one is already set, or a --strip-components value that is
 * no count. After the scan, more than one archive is refused without -M,
 * which mirage does not have (tar 1.35). Mirrors Python's parse_flags.
 */
export function parseFlags(bag: Record<string, FlagValue>): TarFlags {
  const fl = new FlagView(bag, specOf('tar'))
  let mode: string | null = null
  let stripComponents = 0
  for (const [name, value] of fl.occurrences(...MODES, 'strip_components')) {
    if (name === 'strip_components') stripComponents = stripCount(String(value))
    else if (mode !== null && name !== mode) {
      throw new UsageError(`${MODE_CONFLICT}\n${USAGE_HINT}`, CREATE_ERROR_EXIT)
    } else mode = name
  }
  if (fl.occurrences('file').length > 1) {
    throw new UsageError(`${MULTIPLE_ARCHIVES}\n${USAGE_HINT}`, CREATE_ERROR_EXIT)
  }
  const compression: Compression = fl.asBool('gzip')
    ? 'gzip'
    : fl.asBool('bzip2')
      ? 'bzip2'
      : fl.asBool('xz')
        ? 'xz'
        : null
  return {
    create: fl.asBool('create'),
    extract: fl.asBool('extract'),
    list: fl.asBool('list'),
    compression,
    verbose: fl.asBool('verbose'),
    dereference: fl.asBool('dereference'),
    toStdout: fl.asBool('to_stdout'),
    archive: fl.asPath('file') ?? null,
    directories: fl.asPaths('directory'),
    stripComponents,
    exclude: fl.asStr('exclude') ?? null,
    oneFileSystem: fl.asBool('one_file_system'),
  }
}

async function compress(raw: Uint8Array, kind: Compression): Promise<Uint8Array> {
  if (kind === null) return raw
  if (kind === 'gzip') return gzip(raw)
  const codec = getCompressionCodec(kind)
  if (codec?.compress === undefined) throw new Error(`tar: ${kind} not supported`)
  return codec.compress(raw)
}

// gzip is built in; bzip2 (-j) / xz (-J) need a codec registered by the
// runtime package, and a codec may be decompress-only (bzip2 is), which only
// rules out creating an archive. Answers the kind that cannot be served, so
// the caller names it.
function unsupportedKind(compression: Compression, create: boolean): CompressionKind | null {
  if (compression !== 'bzip2' && compression !== 'xz') return null
  const codec = getCompressionCodec(compression)
  if (codec === undefined) return compression
  return create && codec.compress === undefined ? compression : null
}

/**
 * Read tar entries while retaining a failed gzip child's diagnostic.
 *
 * GNU tar 1.35 reads whatever gzip decoded before it stopped, whole blocks
 * only, and a tar parsing error must not mask the child's diagnostic and
 * exit status. A member whose data blocks ran out is the cut: GNU reaches
 * it and stops there. Mirrors Python's _open_archive for listing and
 * extraction.
 */
async function readArchive(data: Uint8Array, kind: Compression): Promise<ReadResult> {
  const foreign = kind !== null ? FOREIGN_INPUT[kind] : undefined
  if (
    foreign !== undefined &&
    !foreign.magic.every((byte, at) => data[at] === byte) &&
    (data.byteLength > 0 || foreign.emptyToo)
  ) {
    // The child refuses the input before tar reads a block.
    return {
      entries: [],
      failure: new GzipDataError([foreign.line], true, foreign.status),
      notices: [],
      cut: null,
    }
  }
  const detected = kind ?? detectCompression(data)
  let failure: GzipDataError | null = null
  if (detected === 'gzip') {
    ;[data, failure] = await gunzipPartial(data)
    if (failure !== null && data.byteLength === 0)
      return { entries: [], failure, notices: [], cut: null }
  } else if (detected !== null) {
    const codec = getCompressionCodec(detected)
    if (codec !== undefined) data = await codec.decompress(data)
  }
  const whole = data.byteLength - (data.byteLength % 512)
  try {
    const entries = await readTar(whole > 0 ? data.subarray(0, whole) : data)
    const cut = entries.findIndex((e) => (e.header?.size ?? 0) > e.data.byteLength)
    return { entries, failure, notices: [], cut: cut === -1 ? null : cut }
  } catch (err) {
    if (!(err instanceof Error)) throw err
    return {
      entries: [],
      failure,
      cut: null,
      notices:
        data.byteLength >= 512
          ? [...INVALID_ARCHIVE]
          : failure === null
            ? INVALID_ARCHIVE.slice(0, 1)
            : [],
    }
  }
}

/**
 * tar's stderr when its gzip child fails: gzip's own lines, what tar printed
 * meanwhile, then tar's two fatal lines. The run exits 2, and the child's
 * failure outranks every member that was not found. Mirrors Python's
 * _child_failure.
 */
function childFailure(failure: GzipDataError, lines: readonly string[]): Uint8Array {
  const status = CHILD_STATUS.replace('{}', String(failure.exitCode))
  return ENC.encode(failure.render('stdin') + [...lines, status, FATAL_TRAILER].join('\n') + '\n')
}

// tar's stderr when a member's data runs out: gzip's own lines first, if
// gzip stopped too, then tar's lines and its two fatal ones. tar exits
// before it waits for its child, so no child status is reported. Mirrors
// Python's _cut_short.
function cutShort(failure: GzipDataError | null, lines: readonly string[]): Uint8Array {
  const lead = failure !== null ? failure.render('stdin') : ''
  return ENC.encode(lead + [...lines, UNEXPECTED_EOF, FATAL_TRAILER].join('\n') + '\n')
}

function stderrOf(lines: readonly string[]): Uint8Array | null {
  return lines.length > 0 ? ENC.encode(`${lines.join('\n')}\n`) : null
}

// One of tar's own lines, spoken by `who` instead of `tar`.
function voiced(line: string, who: string): string {
  return who + line.slice('tar'.length)
}

/**
 * The run's fatal lines for an archive tar cannot open or read. GNU opens
 * the archive before it reads a member, so one it cannot open (missing, the
 * empty name, a link loop) ends the run as `Cannot open`; a directory opens
 * and then fails the first read, which GNU words as `Cannot read` at the
 * beginning of the tape. With a compressor the archive is opened by tar's
 * child, which names itself on each of those lines, and tar then reports the
 * child's status. A reading child has already spawned the compressor, which
 * meets an empty pipe and says so, unless the name was missing. Exit 2 every
 * way, named as typed (tar 1.35, gzip 1.13, xz 5.4). Mirrors Python's
 * _open_failure.
 */
function openFailure(
  shown: string,
  err: unknown,
  compression: Compression,
  reading: boolean,
): IOResult {
  const who = compression !== null ? CHILD_NAME : 'tar'
  const code = (err as { code?: string }).code
  const lines =
    reading && code === 'EISDIR'
      ? [`${who}: ${shown}: Cannot read: ${String(fsStrerror(err))}`, voiced(TAPE_START, who)]
      : [`${who}: ${shown}: Cannot open: ${String(fsStrerror(err))}`]
  lines.push(voiced(FATAL_TRAILER, who))
  if (compression !== null) {
    if (reading && code !== 'ENOENT') lines.push(...(EMPTY_PIPE[compression] ?? []))
    lines.push(CHILD_STATUS.replace('{}', String(CREATE_ERROR_EXIT)), FATAL_TRAILER)
  }
  const stderr = stderrOf(lines)
  return new IOResult({ exitCode: CREATE_ERROR_EXIT, ...(stderr !== null ? { stderr } : {}) })
}

// The archive's bytes, or the run's fatal lines when GNU would stop. A
// backend that keys files alone reports a directory as absent, where GNU
// opens it and fails the read, so a miss asks `isDir` before it is worded.
// Mirrors Python's _read_archive.
async function readArchiveBytes(
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  archive: PathSpec,
  isDir: DirProbe,
  compression: Compression,
): Promise<Uint8Array | IOResult> {
  try {
    return await materialize(stream(archive))
  } catch (err) {
    if (!isFsError(err)) throw err
    const missing = (err as { code?: string }).code === 'ENOENT'
    const failure =
      missing && archive.walkError === null && (await isDir(archive)) ? eisdir(archive) : err
    return openFailure(archive.rawPath, failure, compression, true)
  }
}

async function writeArchive(
  plan: CreateResult,
  archivePath: PathSpec,
  compression: Compression,
  verbose: boolean,
  deps: TarDeps,
): Promise<CommandFnResult> {
  const entries: TarEntry[] = []
  const names: string[] = []
  // A file the session may not read (a rule refused it below the
  // operand) is GNU's "Cannot open": the member is left out, the run
  // fails, and the one trailer closes the notices. The plan's notices
  // come first, so a directory the scan could not open is reported
  // before a file the write could not read.
  const notices = plan.notices.filter((n) => n !== ERROR_TRAILER)
  let exitCode = plan.exitCode
  for (const member of plan.members) {
    let data: Uint8Array = new Uint8Array(0)
    if (member.path !== null) {
      try {
        data = await materialize(deps.stream(member.path))
      } catch (err) {
        if (!isEacces(err)) throw err
        notices.push(
          `tar: ${member.spelled ?? member.name}: Cannot open: ${String(fsStrerror(err))}`,
        )
        exitCode = CREATE_ERROR_EXIT
        continue
      }
    }
    entries.push({
      name: member.name,
      data,
      isFile: member.kind === 'file',
      isDir: member.kind === 'dir',
      linkname: member.kind === 'link' ? member.target : '',
    })
    names.push(member.name)
  }
  if (exitCode !== 0) notices.push(ERROR_TRAILER)
  const raw = await writeTar(entries)
  const archive = await compress(raw, compression)
  if (archivePath.rawPath === '-') {
    const stderr = stderrOf([...notices, ...(verbose ? names : [])])
    return [archive, new IOResult({ exitCode, ...(stderr !== null ? { stderr } : {}) })]
  }
  try {
    await deps.write(archivePath, archive)
  } catch (err) {
    if (!isFsError(err)) throw err
    // GNU opens the archive before it reads a member, so an archive it
    // cannot create is the whole run's one fatal line.
    return [null, openFailure(archivePath.rawPath, err, compression, false)]
  }
  const stderr = stderrOf(notices)
  const stdout = verbose && names.length > 0 ? ENC.encode(`${names.join('\n')}\n`) : null
  return [
    stdout,
    new IOResult({
      writes: { [archivePath.virtual]: archive },
      exitCode,
      ...(stderr !== null ? { stderr } : {}),
    }),
  ]
}

function longMember(entry: TarEntry, name: string): string {
  const header = entry.header
  const kind = header?.type
  const type =
    entry.isDir === true
      ? FileType.DIRECTORY
      : kind === 'symlink'
        ? FileType.SYMLINK
        : FileType.FILE
  const mode = lsModeString(new FileStat({ name, type, mode: header?.mode ?? 0o644 }))
  const user =
    header?.uname === undefined || header.uname === '' ? String(header?.uid ?? 0) : header.uname
  const group =
    header?.gname === undefined || header.gname === '' ? String(header?.gid ?? 0) : header.gname
  const owner = `${user}/${group}`
  const size = String(header?.size ?? entry.data.byteLength).padStart(
    Math.max(1, 19 - owner.length),
  )
  const stamp = (header?.mtime ?? new Date(0)).toISOString().slice(0, 16).replace('T', ' ')
  const suffix =
    kind === 'symlink'
      ? ` -> ${entry.linkname ?? ''}`
      : kind === 'link'
        ? ` link to ${entry.linkname ?? ''}`
        : ''
  return `${mode} ${owner}${size} ${stamp} ${name}${suffix}`
}

export async function tarGeneric(
  paths: PathSpec[],
  texts: readonly string[],
  opts: CommandOpts,
  deps: TarDeps,
  relay = false,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  const { create, extract, list, compression, verbose } = parsed
  const missing = unsupportedKind(compression, create)
  if (missing !== null) {
    return [
      null,
      new IOResult({ exitCode: 1, stderr: ENC.encode(`tar: ${missing} not supported\n`) }),
    ]
  }
  const archiveOperand = parsed.archive
  const COperands = parsed.directories
  // Only the last -C is a destination; create checks every one.
  const CFlag = COperands.at(-1) ?? null
  const stripN = parsed.stripComponents
  const exclude = parsed.exclude
  const toStdout = parsed.toStdout
  const mountPrefix = relay ? '' : (opts.mountPrefix ?? '')
  // With no -f the archive is standard input or output, which is GNU tar's
  // compiled-in default (no TAPE in the environment).
  const archiveSpec =
    archiveOperand !== null
      ? makePathSpec(archiveOperand.virtual, mountPrefix, archiveOperand)
      : new PathSpec({
          virtual: '/dev/stdin',
          directory: '/dev/',
          vfsPath: 'dev/stdin',
          resolved: true,
          rawPath: '-',
        })
  const destPath = extractDest(CFlag, opts.cwd)
  const directories = COperands.map((operand) =>
    makePathSpec(operand.virtual, mountPrefix, operand),
  )
  const archiveStream = stdinStream(deps.stream, opts.stdin)
  const selectors = [...texts]
  const verboseLines: string[] = []

  if (create) {
    const plan = await planCreate(paths, {
      archive: archiveSpec,
      exclude,
      dereference: parsed.dereference,
      stat: deps.stat,
      walk: deps.walk,
      isDir: deps.isDir,
      directories,
      links: opts.ns?.links ?? null,
      mounts: opts.ns?.mounts ?? null,
      oneFileSystem: parsed.oneFileSystem,
    })
    if (!plan.write) {
      const stderr = stderrOf(plan.notices)
      return [
        null,
        new IOResult({
          exitCode: plan.exitCode,
          ...(stderr !== null ? { stderr } : {}),
        }),
      ]
    }
    return writeArchive(plan, archiveSpec, compression, verbose, deps)
  }

  if (list) {
    const raw = await readArchiveBytes(archiveStream, archiveSpec, deps.isDir, compression)
    if (raw instanceof IOResult) return [null, raw]
    const { entries, failure, notices, cut } = await readArchive(raw, compression)
    const names = entries.map((e) => (e.isDir === true ? `${rstripSlash(e.name)}/` : e.name))
    const { keep, misses } = selectedMembers(names, selectors)
    if (keep.size > 0) {
      const errors = await checkDirectories(directories, deps.isDir, deps.stat)
      if (errors.length > 0) return [null, new IOResult({ exitCode: 2, stderr: stderrOf(errors) })]
    }
    const shown = entries.flatMap((entry, index) => {
      const name = names[index] ?? entry.name
      const reached = cut === null || index <= cut
      return keep.has(index) && reached ? [verbose ? longMember(entry, name) : name] : []
    })
    const out: ByteSource | null = shown.length > 0 ? ENC.encode(shown.join('\n') + '\n') : null
    if (cut !== null) {
      return [out, new IOResult({ exitCode: 2, stderr: cutShort(failure, notices) })]
    }
    if (failure !== null) {
      return [out, new IOResult({ exitCode: 2, stderr: childFailure(failure, notices) })]
    }
    if (notices.length > 0 || misses.length > 0) {
      const missStderr = stderrOf([...notices, ...misses, ERROR_TRAILER])
      return [
        out,
        new IOResult({
          exitCode: 2,
          ...(missStderr !== null ? { stderr: missStderr } : {}),
        }),
      ]
    }
    return [out, new IOResult()]
  }

  if (extract) {
    const raw = await readArchiveBytes(archiveStream, archiveSpec, deps.isDir, compression)
    if (raw instanceof IOResult) return [null, raw]
    const { entries, failure, notices, cut } = await readArchive(raw, compression)
    const writes: Record<string, Uint8Array> = {}
    const listed = entries.map((e) => (e.isDir === true ? `${rstripSlash(e.name)}/` : e.name))
    const { keep, misses } = selectedMembers(listed, selectors)
    if (keep.size > 0) {
      const errors = await checkDirectories(directories, deps.isDir, deps.stat)
      if (errors.length > 0) return [null, new IOResult({ exitCode: 2, stderr: stderrOf(errors) })]
    }
    const made = new Set<string>()
    const chunks: Uint8Array[] = []
    // A member GNU cannot create (a read-only region, a missing op) is
    // reported by its own name and the run goes on to the next one,
    // closing with the one trailer and exit 2.
    let failed = notices.length > 0
    const toSpec = (virtual: string): PathSpec => makePathSpec(virtual, mountPrefix)
    for (const [index, entry] of entries.entries()) {
      if (cut !== null && index > cut) break
      if (!keep.has(index)) continue
      // Only the whole blocks that arrived are written.
      if (index === cut) notices.push(UNEXPECTED_EOF)
      // A symlink member has no bytes to write and no namespace to write
      // into from here (links are workspace state, not the backend's),
      // so extraction skips it rather than dropping an empty file where
      // a link belongs.
      const isDir = entry.isDir === true
      if (!entry.isFile && !isDir) continue
      if (isDir) {
        if (!toStdout) {
          // A directory member is the only record an empty directory
          // leaves, so it has to be recreated even though nothing is
          // written inside it. Under -O nothing reaches the
          // filesystem at all.
          const parts = outParts(entry.name, stripN, notices)
          if (parts.length > 0) {
            const outDir = `${rstripSlash(destPath)}/${parts.join('/')}`
            try {
              await ensureDir(outDir, toSpec, deps.mkdir, deps.stat, made)
            } catch (err) {
              if (!isFsError(err)) throw err
              notices.push(`tar: ${parts.join('/')}: Cannot mkdir: ${String(fsStrerror(err))}`)
              failed = true
              continue
            }
            if (verbose) verboseLines.push(`${rstripSlash(entry.name)}/`)
          }
        }
        continue
      }
      if (toStdout) {
        chunks.push(entry.data)
        if (verbose) verboseLines.push(entry.name)
        continue
      }
      const parts = outParts(entry.name, stripN, notices)
      if (parts.length === 0) continue
      const outPath = `${rstripSlash(destPath)}/${parts.join('/')}`
      const parent = outPath.slice(0, outPath.lastIndexOf('/')) || '/'
      if (parent !== '/') {
        try {
          await ensureDir(parent, toSpec, deps.mkdir, deps.stat, made)
        } catch (err) {
          if (!isFsError(err)) throw err
          // GNU tar 1.35 (debian:stable-slim) reports ENOENT for the
          // member after its parent mkdir failed.
          notices.push(
            `tar: ${parts.slice(0, -1).join('/')}: Cannot mkdir: ${String(fsStrerror(err))}`,
            `tar: ${parts.join('/')}: Cannot open: No such file or directory`,
          )
          failed = true
          continue
        }
      }
      try {
        await deps.write(makePathSpec(outPath, mountPrefix), entry.data)
      } catch (err) {
        if (!isFsError(err)) throw err
        notices.push(`tar: ${parts.join('/')}: Cannot open: ${String(fsStrerror(err))}`)
        failed = true
        continue
      }
      // Relay writes land on whichever mount owns each path and
      // invalidate through the dispatcher; keying them here would have
      // the runner prefix them onto this mount.
      if (!relay) writes[outPath] = entry.data
      if (verbose) verboseLines.push(entry.name)
    }
    if (toStdout) {
      // GNU moves the verbose listing to stderr when stdout carries the
      // member bytes.
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      const errLines = [...notices, ...(verbose ? verboseLines : [])]
      if (cut !== null) {
        return [
          merged.byteLength > 0 ? merged : null,
          new IOResult({ exitCode: 2, stderr: cutShort(failure, errLines) }),
        ]
      }
      if (failure !== null) {
        return [
          merged.byteLength > 0 ? merged : null,
          new IOResult({ exitCode: 2, stderr: childFailure(failure, errLines) }),
        ]
      }
      if (misses.length > 0) errLines.push(...misses, ERROR_TRAILER)
      const stderr = stderrOf(errLines)
      return [
        merged.byteLength > 0 ? merged : null,
        new IOResult({
          exitCode: misses.length > 0 ? 2 : 0,
          ...(stderr !== null ? { stderr } : {}),
        }),
      ]
    }
    const stdout =
      verbose && verboseLines.length > 0 ? ENC.encode(verboseLines.join('\n') + '\n') : null
    if (cut !== null) {
      return [stdout, new IOResult({ writes, exitCode: 2, stderr: cutShort(failure, notices) })]
    }
    if (failure !== null) {
      return [stdout, new IOResult({ writes, exitCode: 2, stderr: childFailure(failure, notices) })]
    }
    const errLines = [
      ...notices,
      ...(misses.length > 0 || failed ? [...misses, ERROR_TRAILER] : []),
    ]
    const stderr = stderrOf(errLines)
    return [
      stdout,
      new IOResult({
        writes,
        exitCode: misses.length > 0 || failed ? 2 : 0,
        ...(stderr !== null ? { stderr } : {}),
      }),
    ]
  }

  throw new UsageError(`${NO_MODE}\n${USAGE_HINT}`, CREATE_ERROR_EXIT)
}
