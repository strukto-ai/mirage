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
import { mountKey } from '../../../utils/key_prefix.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { gzip, gunzipPartial, getCompressionCodec } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts, WritesFn } from '../../config.ts'
import { readTar, writeTar, type TarEntry } from '../tar_helper.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import {
  CHILD_STATUS,
  COMPRESSION_SIGNATURES,
  CREATE_ERROR_EXIT,
  ERROR_TRAILER,
  FATAL_TRAILER,
  INVALID_ARCHIVE,
} from './tar/constants.ts'
import { planCreate, type DirProbe, type StatFn, type WalkFn } from './tar/create.ts'
import { fsStrerror, isEacces, type GzipDataError } from '../../../utils/errors.ts'
import { ensureDir, extractDest } from './archive/extract.ts'
import type { Compression, CompressionKind, CreateResult, ReadResult } from './tar/types.ts'

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

function makePathSpec(virtual: string, prefix: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: mountKey(virtual, prefix),
    resolved: true,
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

function compressionOf(opts: CommandOpts): Compression {
  const fl = new FlagView(opts.flags, specOf('tar'))
  if (fl.asBool('z')) return 'gzip'
  if (fl.asBool('j')) return 'bzip2'
  if (fl.asBool('J')) return 'xz'
  return null
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
 * Complete deflate bodies survive a damaged or missing gzip trailer. Data
 * cut off inside a body is still discarded; GNU tar can recover partial
 * entries there. Mirrors Python's _open_archive for listing and extraction.
 */
async function readArchive(data: Uint8Array, kind: Compression): Promise<ReadResult> {
  const detected = kind ?? detectCompression(data)
  let failure: GzipDataError | null = null
  if (detected === 'gzip') {
    ;[data, failure] = await gunzipPartial(data)
    if (failure !== null && (!failure.keepsOutput || data.byteLength === 0))
      return { entries: [], failure, notices: [] }
  } else if (detected !== null) {
    const codec = getCompressionCodec(detected)
    if (codec !== undefined) data = await codec.decompress(data)
  }
  try {
    return { entries: await readTar(data), failure, notices: [] }
  } catch (err) {
    if (failure === null) throw err
    return { entries: [], failure, notices: data.byteLength >= 512 ? [...INVALID_ARCHIVE] : [] }
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
  return ENC.encode(
    failure.render('gzip', 'stdin') + [...lines, status, FATAL_TRAILER].join('\n') + '\n',
  )
}

function stderrOf(lines: readonly string[]): Uint8Array | null {
  return lines.length > 0 ? ENC.encode(`${lines.join('\n')}\n`) : null
}

async function writeArchive(
  plan: CreateResult,
  archivePath: string,
  mountPrefix: string,
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
  await deps.write(makePathSpec(archivePath, mountPrefix), archive)
  const stderr = stderrOf(notices)
  const stdout = verbose && names.length > 0 ? ENC.encode(`${names.join('\n')}\n`) : null
  return [
    stdout,
    new IOResult({
      writes: { [archivePath]: archive },
      exitCode,
      ...(stderr !== null ? { stderr } : {}),
    }),
  ]
}

// Whether a tar invocation writes: -c writes the archive and -x its members,
// while -t only lists them and -x -O extracts to stdout. The modes are read
// in tar's own order, create before list before extract. Mirrors Python's
// tar_writes.
export const tarWrites: WritesFn = (flags) => {
  const fl = new FlagView(flags, specOf('tar'))
  return fl.asBool('c') || (fl.asBool('x') && !fl.asBool('t') && !fl.asBool('to_stdout'))
}

export async function tarGeneric(
  paths: PathSpec[],
  texts: readonly string[],
  opts: CommandOpts,
  deps: TarDeps,
  relay = false,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('tar'))
  const create = fl.asBool('c')
  const extract = fl.asBool('x')
  const list = fl.asBool('t')
  const compression = compressionOf(opts)
  const verbose = fl.asBool('v')
  const missing = unsupportedKind(compression, create)
  if (missing !== null) {
    return [
      null,
      new IOResult({ exitCode: 1, stderr: ENC.encode(`tar: ${missing} not supported\n`) }),
    ]
  }
  const fFlag = fl.asStr('f') ?? null
  const CFlags = fl.asList('C')
  // Only the last -C is a destination; create checks every one.
  const CFlag = CFlags.length > 0 ? (CFlags[CFlags.length - 1] ?? null) : null
  const stripN = fl.asInt('strip_components') ?? 0
  const exclude = fl.asStr('exclude') ?? null
  const toStdout = fl.asBool('to_stdout')
  const mountPrefix = relay ? '' : (opts.mountPrefix ?? '')
  const archivePath = fFlag
  const destPath = extractDest(CFlag, opts.cwd)
  const selectors = [...texts]
  const verboseLines: string[] = []

  if (create) {
    if (archivePath === null) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tar: -f is required\n') })]
    }
    const plan = await planCreate(paths, {
      archive: makePathSpec(archivePath, mountPrefix),
      exclude,
      dereference: fl.asBool('h'),
      stat: deps.stat,
      walk: deps.walk,
      isDir: deps.isDir,
      directories: CFlags.map((c) => makePathSpec(c, mountPrefix)),
      links: opts.ns?.links ?? null,
      mounts: opts.ns?.mounts ?? null,
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
    return writeArchive(plan, archivePath, mountPrefix, compression, verbose, deps)
  }

  if (list) {
    if (archivePath === null) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tar: -f is required\n') })]
    }
    const raw = await materialize(deps.stream(makePathSpec(archivePath, mountPrefix)))
    const { entries, failure, notices } = await readArchive(raw, compression)
    const names = entries.map((e) => (e.isDir === true ? `${rstripSlash(e.name)}/` : e.name))
    const { keep, misses } = selectedMembers(names, selectors)
    const shown = names.filter((_, index) => keep.has(index))
    const out: ByteSource | null = shown.length > 0 ? ENC.encode(shown.join('\n') + '\n') : null
    if (failure !== null) {
      return [out, new IOResult({ exitCode: 2, stderr: childFailure(failure, notices) })]
    }
    if (misses.length > 0) {
      const missStderr = stderrOf([...misses, ERROR_TRAILER])
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
    if (archivePath === null) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tar: -f is required\n') })]
    }
    const raw = await materialize(deps.stream(makePathSpec(archivePath, mountPrefix)))
    const { entries, failure, notices } = await readArchive(raw, compression)
    const writes: Record<string, Uint8Array> = {}
    const listed = entries.map((e) => (e.isDir === true ? `${rstripSlash(e.name)}/` : e.name))
    const { keep, misses } = selectedMembers(listed, selectors)
    const made = new Set<string>()
    const chunks: Uint8Array[] = []
    const toSpec = (virtual: string): PathSpec => makePathSpec(virtual, mountPrefix)
    for (const [index, entry] of entries.entries()) {
      if (!keep.has(index)) continue
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
            await ensureDir(outDir, toSpec, deps.mkdir, deps.stat, made)
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
      if (parent !== '/') await ensureDir(parent, toSpec, deps.mkdir, deps.stat, made)
      await deps.write(makePathSpec(outPath, mountPrefix), entry.data)
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
    if (failure !== null) {
      return [stdout, new IOResult({ writes, exitCode: 2, stderr: childFailure(failure, notices) })]
    }
    const errLines = [...notices, ...(misses.length > 0 ? [...misses, ERROR_TRAILER] : [])]
    const stderr = stderrOf(errLines)
    return [
      stdout,
      new IOResult({
        writes,
        exitCode: misses.length > 0 ? 2 : 0,
        ...(stderr !== null ? { stderr } : {}),
      }),
    ]
  }

  return [
    null,
    new IOResult({ exitCode: 1, stderr: ENC.encode('tar: must specify -c, -x, or -t\n') }),
  ]
}
