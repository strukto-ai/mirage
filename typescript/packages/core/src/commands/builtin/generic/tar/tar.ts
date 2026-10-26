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
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { mountKey } from '../../../../utils/key_prefix.ts'
import { IOResult } from '../../../../io/types.ts'
import { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import { byteView } from '../../../../shell/bytes.ts'
import {
  CREATE_ERROR_EXIT,
  MODE_CONFLICT,
  MULTIPLE_ARCHIVES,
  NO_MODE,
  STRIP_COUNT,
  USAGE_HINT,
} from './constants.ts'
import { C_SPACE, UINTMAX } from '../../constants.ts'
import { UsageError } from '../../../errors.ts'
import type { FlagValue } from '../../../spec/types.ts'
import {
  checkDirectories,
  planCreate,
  type DirProbe,
  type StatFn,
  type WalkFn,
} from './create.ts'
import { fsStrerror, walkRefusal } from '../../../../errors/fs.ts'
import { extractDest } from '../archive/extract.ts'
import { linksOf, mountView, mountRoot } from '../../utils/links.ts'
import { formatOptionalRecords } from '../../utils/output.ts'
import { StreamHost, hostedStream } from '../../utils/stream_host.ts'

// What tar needs from the mount it runs on. `stat` and `walk` are what
// make a directory operand archivable at all; `isDir` answers on two
// channels so a prefix-store directory (no object of its own) is not
// mistaken for an absent one.
export interface TarDeps {
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>
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
  stripComponents: number
  exclude: string | null
  oneFileSystem: boolean
}

const MODES = ['create', 'extract', 'list'] as const
const CODECS = ['gzip', 'bzip2', 'xz'] as const
const STRIP_COUNT_PATTERN = new RegExp(`^${C_SPACE}\\+?([0-9]+)$`)

/**
 * A --strip-components value as tar reads it, or tar's refusal: a decimal
 * count with no suffix, so leading blanks and one `+` pass, a sign, another
 * letter or a count past UINTMAX does not (tar 1.35). Mirrors Python's
 * strip_count.
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
  return {
    create: fl.asBool('create'),
    extract: fl.asBool('extract'),
    list: fl.asBool('list'),
    codec: CODECS.find((codec) => fl.asBool(codec)) ?? null,
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

/**
 * Plan what the host decides and run mirage-rs's tar over it: -c walks its
 * operands and checks every -C here, then the engine encodes; -t and -x
 * check every -C here, and the engine reads the archive and writes what it
 * extracts where the last -C or the working directory says, on whichever
 * mount owns it. Mirrors Python's tar.
 */
export async function tarGeneric(
  paths: PathSpec[],
  texts: readonly string[],
  ctx: Context,
  deps: TarDeps,
  relay = false,
): Promise<CommandFnResult> {
  const flags = parseFlags(ctx.flags)
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
  const config: Record<string, util.JSONType> = {
    archive: byteView(archive.rawPath),
    codec: flags.codec,
    verbose: flags.verbose,
  }
  let host: StreamHost
  if (flags.create) {
    const plan = await planCreate(paths, {
      archive,
      exclude: flags.exclude,
      dereference: flags.dereference,
      stat: deps.stat,
      walk: deps.walk,
      isDir: deps.isDir,
      directories,
      links: linksOf(ctx) ?? null,
      // Every mount nested under an operand bounds the scan, a relayed run's too.
      mounts: mountView(ctx.vfs) ?? null,
      oneFileSystem: flags.oneFileSystem,
    })
    if (!plan.write) {
      const stderr = formatOptionalRecords(plan.notices)
      return [null, new IOResult({ exitCode: plan.exitCode, ...(stderr !== null ? { stderr } : {}) })]
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
      }
      if (member.path !== null) {
        reads.push(member.path)
        item.path = byteView(member.path.rawPath)
        item.operand = reads.length
      }
      members.push(item)
    }
    Object.assign(config, {
      mode: 'create',
      output: byteView(archive.virtual),
      members,
      notices: plan.notices.map((notice) => byteView(notice)),
      status: plan.exitCode,
    })
    host = new StreamHost(reads, deps.stream, ctx, false)
  } else if (flags.list || flags.extract) {
    const refusal = await checkDirectories(directories, deps.isDir, deps.stat)
    Object.assign(config, {
      mode: flags.list ? 'list' : 'extract',
      probe: archive.walkError === null,
      selectors: texts.map((selector) => byteView(selector)),
      strip: flags.stripComponents,
      to_stdout: flags.toStdout,
      base: byteView(rstripSlash(extractDest(directories.at(-1) ?? null, ctx.cwd.virtual))),
      refusal: refusal.map((line) => byteView(line)),
    })
    host = new StreamHost([archive], deps.stream, ctx, false)
  } else {
    throw new UsageError(`${NO_MODE}\n${USAGE_HINT}`, CREATE_ERROR_EXIT)
  }
  const io = new IOResult()
  return [hostedStream('tar', config, host, io, ctx.signal), io]
}
