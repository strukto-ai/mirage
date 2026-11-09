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

import type { util } from 'zod'
import { fsStrerror, isFsError, walkRefusal } from '../../../../errors/fs.ts'
import { type ByteSource, IOResult, materialize } from '../../../../io/types.ts'
import { StreamRefusal } from '../../../../rs/errors.ts'
import { refused } from '../../../../rs/scan.ts'
import { openStreamSync } from '../../../../rs/stream.ts'
import { byteView, decodeText } from '../../../../shell/bytes.ts'
import type { ReadStreamFn, StatFn } from '../../../../types.ts'
import { Follow, LineFacts, PathSpec } from '../../../../types.ts'
import { isoToEpoch, parseDateExprAsync } from '../../../../utils/dates.ts'
import { mountKey } from '../../../../utils/key_prefix.ts'
import { LOCAL_ZONE, zoneFromEnv } from '../../../../utils/timezone.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { FlagValue } from '../../../spec/types.ts'
import { linksOf, mountRoot, mountView } from '../../utils/links.ts'
import { formatOptionalRecords, formatRecords } from '../../utils/output.ts'
import { hostedStream, StreamHost } from '../../utils/stream_host.ts'
import { extractDest } from '../archive/extract.ts'
import type { DirProbe, WalkFn } from '../archive/walk.ts'
import {
  CREATE_ERROR_EXIT,
  FATAL_TRAILER,
  SUFFIX_CODECS,
  SUFFIX_UNAVAILABLE,
  USAGE_HINT,
  VCS_NAMES,
} from './constants.ts'
import { cannot, checkDirectories, type Exclusion, planCreate } from './create.ts'

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

/** tar's flags as argp read them. Mirrors Python's TarFlags. */
export interface TarFlags {
  create: boolean
  extract: boolean
  list: boolean
  codec: string | null
  verbose: boolean
  dereference: boolean
  toStdout: boolean
  archive: PathSpec | null
  directories: PathSpec[]
  typed: [string, string][]
  exclude: (Exclusion | ExcludeFile)[]
  listsAfter: number[]
  oneFileSystem: boolean
  append: boolean
  update: boolean
  delete: boolean
  autoCompress: boolean
  absolute: boolean
  preserve: boolean
  numeric: boolean
  mtime: string | null
  filesFrom: PathSpec[]
  null: boolean
  wildcards: boolean | null
  unanchored: boolean
}

// A -X list, and how its patterns match.
interface ExcludeFile {
  readonly path: PathSpec
  readonly anchored: boolean
  readonly wildcards: boolean
}

const MODES = ['create', 'extract', 'list', 'append', 'update', 'delete'] as const
const CODECS = ['gzip', 'bzip2', 'xz'] as const
const TYPED = [
  ...MODES,
  'strip_components',
  'file',
  ...CODECS,
  'keep_old_files',
  'overwrite',
  'skip_old_files',
  'sort',
  'owner',
  'group',
  'transform',
] as const
const MATCHING = [
  'exclude',
  'exclude_from',
  'exclude_vcs',
  'wildcards',
  'no_wildcards',
  'anchored',
  'no_anchored',
] as const

/** The options the tar engine reads, each text as a byte view. Mirrors
 * Python's `_typed`. */
function typedConfig(typed: readonly [string, string][]): util.JSONType[] {
  return typed.map(([name, text]) => [name, byteView(text)])
}

/**
 * tar's flags, refused by the tar engine as argp refuses them: the flags, or
 * tar's refusal, exit 2. Mirrors Python's parse_flags.
 */
export function parseFlags(bag: Record<string, FlagValue>): TarFlags | IOResult {
  const fl = new FlagView(bag, specOf('tar'))
  const archive = fl.asPath('file') ?? null
  const typed = fl
    .texts(...TYPED)
    .map(([name, text]): [string, string] => [
      name,
      name === 'file' && archive !== null ? archive.rawPath : text,
    ])
  try {
    openStreamSync('tar', { typed: typedConfig(typed) }).close()
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
  const rules: (Exclusion | ExcludeFile)[] = []
  const lists = fl.asPaths('exclude_from')
  let listed = 0
  let anchored = false
  let wildcards = true
  let wildcardsTyped: boolean | null = null
  let unanchored = false
  for (const [name, text] of fl.texts(...MATCHING)) {
    if (name === 'exclude') rules.push({ pattern: text, anchored, wildcards })
    else if (name === 'exclude_from') {
      const path = lists[listed]
      listed += 1
      if (path !== undefined) rules.push({ path, anchored, wildcards })
    } else if (name === 'exclude_vcs') {
      for (const vcs of VCS_NAMES) rules.push({ pattern: vcs, anchored: false, wildcards: false })
    } else if (name === 'wildcards' || name === 'no_wildcards') {
      wildcards = name === 'wildcards'
      wildcardsTyped = wildcards
    } else {
      anchored = name === 'anchored'
      unanchored = name === 'no_anchored'
    }
  }
  const listsAfter: number[] = []
  let changes = 0
  for (const [name] of fl.texts('directory', 'files_from')) {
    if (name === 'directory') changes += 1
    else listsAfter.push(changes)
  }
  return {
    create: fl.asBool('create'),
    extract: fl.asBool('extract'),
    list: fl.asBool('list'),
    codec: CODECS.find((codec) => fl.asBool(codec)) ?? null,
    verbose: fl.asBool('verbose'),
    dereference: fl.asBool('dereference'),
    toStdout: fl.asBool('to_stdout'),
    archive,
    directories: fl.asPaths('directory'),
    typed,
    exclude: rules,
    listsAfter,
    oneFileSystem: fl.asBool('one_file_system'),
    append: fl.asBool('append'),
    update: fl.asBool('update'),
    delete: fl.asBool('delete'),
    autoCompress: fl.asBool('auto_compress'),
    absolute: fl.asBool('absolute_names'),
    preserve: fl.asBool('preserve_permissions'),
    numeric: fl.asBool('numeric_owner'),
    mtime: fl.asStr('mtime') ?? null,
    filesFrom: fl.asPaths('files_from'),
    null: fl.asBool('null'),
    wildcards: wildcardsTyped,
    unanchored,
  }
}

// What the -T lists named. Mirrors Python's `_Names`.
interface Names {
  readonly names: readonly (readonly [string, PathSpec])[]
  readonly notices: readonly string[]
  readonly status: number
  readonly failure: string | null
}

async function whole(
  path: PathSpec,
  stream: ReadStreamFn,
  stdin: ByteSource | null,
): Promise<Uint8Array> {
  return path.rawPath === '-' ? materialize(stdin) : materialize(stream(path))
}

// The patterns that leave members out, each -X list read, or the line a list
// that cannot be read ends the run with. Mirrors Python's `_exclusions`.
async function exclusions(
  flags: TarFlags,
  stream: ReadStreamFn,
  stdin: ByteSource | null,
): Promise<Exclusion[] | string> {
  const rules: Exclusion[] = []
  for (const rule of flags.exclude) {
    if ('pattern' in rule) {
      rules.push(rule)
      continue
    }
    let data: Uint8Array
    try {
      data = await whole(rule.path, stream, stdin)
    } catch (err) {
      if (!isFsError(err)) throw err
      return `tar: ${rule.path.rawPath}: ${String(fsStrerror(err))}`
    }
    for (const pattern of decodeText(data).split('\n')) {
      if (pattern !== '')
        rules.push({ pattern, anchored: rule.anchored, wildcards: rule.wildcards })
    }
  }
  return rules
}

// The names in every -T list: a line each, blank lines passed over, or one per
// NUL under --null. A line that starts with a dash is an option, of which
// mirage reads -CDIR and --directory=DIR. Mirrors Python's `_listed_names`.
async function listedNames(
  flags: TarFlags,
  stream: ReadStreamFn,
  stdin: ByteSource | null,
  directories: readonly PathSpec[],
  cwd: PathSpec,
): Promise<Names> {
  const names: [string, PathSpec][] = []
  const notices: string[] = []
  let status = 0
  for (const [position, source] of flags.filesFrom.entries()) {
    let data: Uint8Array
    try {
      data = await whole(source, stream, stdin)
    } catch (err) {
      if ((err as { code?: unknown }).code === 'EISDIR') {
        console.debug(`tar: -T ${source.rawPath}: ${String(err)}`)
        continue
      }
      if (!isFsError(err)) throw err
      const failure = cannot(source.rawPath, 'stat', String(fsStrerror(err)))
      return { names: [], notices: [], status: 0, failure }
    }
    const changes = flags.listsAfter[position] ?? 0
    let base = changes > 0 ? (directories[changes - 1] ?? cwd) : cwd
    decodeText(data)
      .split(flags.null ? '\0' : '\n')
      .forEach((line, index) => {
        if (line === '') return
        if (flags.null || !line.startsWith('-')) names.push([line, base])
        else if (line.startsWith('--directory=')) {
          base = PathSpec.fromStrPath(line.slice('--directory='.length), undefined, base)
        } else if (line.startsWith('-C') && line.length > 2) {
          base = PathSpec.fromStrPath(line.slice(2).trimStart(), undefined, base)
        } else {
          notices.push(`tar: ${source.rawPath}:${String(index + 1)}: unrecognized option`)
          status = CREATE_ERROR_EXIT
        }
      })
  }
  return { names, notices, status, failure: null }
}

// A -T name as an operand, spelled as it was listed.
function listedOperand(name: string, base: PathSpec, prefix: string): PathSpec {
  const virtual = PathSpec.fromStrPath(name, undefined, base).virtual
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: mountKey(virtual, prefix),
    resolved: true,
    rawPath: name,
  })
}

function selectorViews(listed: Names, selectors: readonly string[]): util.JSONType[] {
  return [...listed.names.map(([name]) => name), ...selectors].map((selector) => byteView(selector))
}

// What -a makes of an archive's name: the codec its suffix asks for, and the
// program it would take that mirage does not have.
function codecOf(archive: PathSpec): [string | null, string | null] {
  const name = archive.rawPath.slice(archive.rawPath.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const suffix = dot > 0 ? name.slice(dot) : ''
  return [SUFFIX_CODECS[suffix] ?? null, SUFFIX_UNAVAILABLE[suffix] ?? null]
}

// What --mtime records: the time of the file it names when it starts with `/`
// or `.`, otherwise the date it spells; the time and a warning about it, or
// the refusal. Mirrors Python's `_stored_time`.
async function storedTime(
  text: string,
  stat: StatFn,
  ctx: Context,
): Promise<[number, string | null] | IOResult> {
  if (text.startsWith('/') || text.startsWith('.')) {
    try {
      const row = await stat(PathSpec.fromStrPath(text, undefined, ctx.cwd))
      return [row.modified === null ? 0 : isoToEpoch(row.modified), null]
    } catch (err) {
      if (!isFsError(err)) throw err
      return new IOResult({
        exitCode: CREATE_ERROR_EXIT,
        stderr: formatRecords([
          cannot(text, 'stat', String(fsStrerror(err))),
          'tar: Date sample file not found',
          USAGE_HINT,
        ]),
      })
    }
  }
  const zone = zoneFromEnv(ctx.env) ?? LOCAL_ZONE
  const placed = await parseDateExprAsync(text, zone, undefined, ctx.signal)
  if (placed === null) {
    return [0, `tar: Substituting -9223372036854775807 for unknown date format '${text}'`]
  }
  return [Math.floor(placed.getTime() / 1000), null]
}

/**
 * Plan what the host decides and run mirage-rs's tar over it: -c walks its
 * operands and checks every -C here, then the engine encodes; -t and -x
 * check every -C here, and the engine reads the archive and writes what it
 * extracts where the last -C or the working directory says, on whichever
 * mount owns it. Mirrors Python's tar.
 */
export async function tarGeneric(
  flags: TarFlags,
  paths: PathSpec[],
  texts: readonly string[],
  ctx: Context,
  // What tar needs from the mount it runs on. `stat` and `walk` are what
  // make a directory operand archivable at all; `isDir` answers on two
  // channels so a prefix-store directory (no object of its own) is not
  // mistaken for an absent one.
  deps: {
    stream: (p: PathSpec) => AsyncIterable<Uint8Array>
    stat: StatFn
    walk: WalkFn
    isDir: DirProbe
  },
  relay = false,
): Promise<CommandFnResult> {
  const prefix = relay ? '' : mountRoot(ctx)
  // With no -f the archive is standard input or output, which is GNU tar's
  // compiled-in default (no TAPE in the environment).
  const archive =
    flags.archive !== null
      ? makePathSpec(flags.archive.virtual, prefix, flags.archive)
      : new PathSpec({
          virtual: '/dev/stdin',
          directory: '/dev/',
          vfsPath: 'dev/stdin',
          resolved: true,
          rawPath: '-',
        })
  const directories = flags.directories.map((dir) => makePathSpec(dir.virtual, prefix, dir))
  const stdin = ctx.stdin ?? null
  const listed = await listedNames(flags, deps.stream, stdin, directories, ctx.cwd)
  const sources = flags.create || flags.append || flags.update
  if (listed.failure !== null && !sources) {
    return [
      null,
      new IOResult({
        exitCode: CREATE_ERROR_EXIT,
        stderr: formatRecords([listed.failure, FATAL_TRAILER]),
      }),
    ]
  }
  let codec = flags.codec
  let unavailable: string | null = null
  if (flags.autoCompress && archive.rawPath !== '-') {
    const [suffixCodec, missing] = codecOf(archive)
    codec = suffixCodec ?? codec
    unavailable = missing
  }
  const config: Record<string, util.JSONType> = {
    archive: byteView(archive.rawPath),
    codec,
    verbose: flags.verbose,
    typed: typedConfig(flags.typed),
    absolute: flags.absolute,
    numeric: flags.numeric,
  }
  const rules = await exclusions(flags, deps.stream, stdin)
  if (typeof rules === 'string' && !sources) {
    return [
      null,
      new IOResult({
        exitCode: CREATE_ERROR_EXIT,
        stderr: formatRecords([rules, FATAL_TRAILER]),
      }),
    ]
  }
  let host: StreamHost
  if (sources) {
    const leading = [...listed.notices]
    let stored: number | null = null
    if (flags.mtime !== null) {
      const found = await storedTime(flags.mtime, deps.stat, ctx)
      if (found instanceof IOResult) return [null, found]
      stored = found[0]
      if (found[1] !== null) leading.push(found[1])
    }
    const named = listed.names.map(([name, base]) => listedOperand(name, base, prefix))
    const mounts = mountView(ctx.vfs) ?? null
    const root = named.find(
      (operand) => mounts !== null && operand.walkError === null && mounts.isRoot(operand.virtual),
    )
    if (root !== undefined) {
      return [
        null,
        new IOResult({
          exitCode: CREATE_ERROR_EXIT,
          stderr: formatRecords([
            `tar: ${root.rawPath}: Cannot open: Device or resource busy`,
            FATAL_TRAILER,
          ]),
        }),
      ]
    }
    const operands = [...named, ...paths]
    const plan = await planCreate(operands, {
      archive,
      exclude: typeof rules === 'string' ? [] : rules,
      dereference: flags.dereference,
      stat: deps.stat,
      walk: deps.walk,
      isDir: deps.isDir,
      directories,
      links: linksOf(ctx) ?? null,
      // Every mount nested under an operand bounds the scan, a relayed run's too.
      mounts: mountView(ctx.vfs) ?? null,
      oneFileSystem: flags.oneFileSystem,
      absolute: flags.absolute,
      allowEmpty: flags.filesFrom.length > 0 || !flags.create,
      leading,
      leadingStatus: listed.status,
    })
    if (!plan.write) {
      const stderr = formatOptionalRecords(plan.notices)
      return [
        null,
        new IOResult({ exitCode: plan.exitCode, ...(stderr !== null ? { stderr } : {}) }),
      ]
    }
    if (archive.walkError !== null) {
      config.unopened = byteView(fsStrerror(walkRefusal(archive)) ?? '')
    }
    const reads: PathSpec[] = [archive]
    const members: util.JSONType[] = []
    for (const member of plan.members) {
      const item: Record<string, util.JSONType> = {
        name: byteView(member.name),
        kind: member.kind,
        target: byteView(member.target),
        spelled: byteView(member.spelled ?? ''),
        size: member.size ?? null,
        mtime: member.mtime ?? null,
        mode: member.mode ?? null,
      }
      if (member.path !== null) {
        reads.push(member.path)
        item.path = byteView(member.path.rawPath)
        item.operand = reads.length
      }
      members.push(item)
    }
    const failure = listed.failure ?? (typeof rules === 'string' ? rules : null)
    if (failure !== null) config.abandon = true
    Object.assign(config, {
      mode: flags.create ? 'create' : flags.append ? 'append' : 'update',
      output: byteView(archive.virtual),
      members,
      notices: (failure !== null ? [failure, FATAL_TRAILER] : plan.notices).map((notice) =>
        byteView(notice),
      ),
      status: failure !== null ? CREATE_ERROR_EXIT : plan.exitCode,
      probe: archive.walkError === null,
      mtime: stored,
      unavailable,
    })
    host = new StreamHost(reads, deps.stream, ctx, false)
  } else if (flags.delete) {
    Object.assign(config, {
      mode: 'delete',
      output: byteView(archive.virtual),
      selectors: selectorViews(listed, texts),
      wildcards: flags.wildcards,
      unanchored: flags.unanchored,
      probe: archive.walkError === null,
    })
    host = new StreamHost([archive], deps.stream, ctx, false)
  } else {
    const refusal = await checkDirectories(directories, deps.isDir, deps.stat)
    Object.assign(config, {
      mode: flags.list ? 'list' : 'extract',
      exclusions: (typeof rules === 'string' ? [] : rules).map((rule) => ({
        pattern: byteView(rule.pattern),
        anchored: rule.anchored,
        wildcards: rule.wildcards,
      })),
      probe: archive.walkError === null,
      selectors: selectorViews(listed, texts),
      wildcards: flags.wildcards,
      unanchored: flags.unanchored,
      preserve: flags.preserve,
      to_stdout: flags.toStdout,
      base: byteView(rstripSlash(extractDest(directories.at(-1) ?? null, ctx.cwd.virtual))),
      refusal: refusal.map((line) => byteView(line)),
    })
    host = new StreamHost([archive], deps.stream, ctx, false)
  }
  const io = new IOResult()
  return [hostedStream('tar', config, host, io, ctx.signal), io]
}

/**
 * A tar line hands a link operand to its planner as given, which reads `-h`
 * itself, reads below what it archives under `-c`, and writes to create or
 * extract, not to list or extract to stdout. Mirrors Python's `facts`.
 */
export function facts(fl: FlagView, _operands: readonly (string | PathSpec)[]): LineFacts {
  const sources = fl.asBool('create') || fl.asBool('append') || fl.asBool('update')
  return new LineFacts({
    follows: Follow.NONE,
    readsSubtree: sources,
    writes: sources || fl.asBool('delete') || (fl.asBool('extract') && !fl.asBool('to_stdout')),
  })
}
