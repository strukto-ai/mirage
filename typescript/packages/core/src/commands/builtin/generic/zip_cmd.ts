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

// Refusal wording from Info-ZIP Zip 3.0 (Info-ZIP license; see
// licenses/third_party/info-zip.txt).

import type { util } from 'zod'
import { type ByteSource, IOResult, materialize } from '../../../io/types.ts'
import { byteView, decodeText } from '../../../shell/bytes.ts'
import { Follow, LineFacts, PathSpec, type StatFn } from '../../../types.ts'
import { respellOne } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { linksOf, mountView } from '../utils/links.ts'
import { formatRecords } from '../utils/output.ts'
import { hostedStream, StreamHost } from '../utils/stream_host.ts'
import { OTHER_FILESYSTEM, recordedStamp, scanOperand, type WalkFn } from './archive/walk.ts'

// What Info-ZIP calls a path it could not reach. It does not distinguish
// absent from unreadable, and a dangling symlink under the default follow
// prints exactly this too.
const NOT_MATCHED = 'name not matched: '

interface ZipFlags {
  readonly recursive: boolean
  readonly junkPaths: boolean
  readonly quiet: boolean
  readonly storeLinks: boolean
  readonly exclude: readonly string[]
  readonly include: readonly string[]
  readonly update: boolean
  readonly freshen: boolean
  readonly delete: boolean
  readonly moveFiles: boolean
  readonly level: number | null
  readonly test: boolean
  readonly verbose: boolean
  readonly lineEnds: string
  readonly noDirectories: boolean
  readonly temp: PathSpec | null
  readonly commentMembers: boolean
  readonly commentArchive: boolean
  readonly namesFromStdin: boolean
}

const LEVELS = ['0', 'args_1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

function parseFlags(bag: Record<string, FlagValue>): ZipFlags {
  const fl = new FlagView(bag, specOf('zip'))
  const lastLevel = fl.texts(...LEVELS).at(-1)
  const ends = fl.asInt('args_l', 0)
  return {
    recursive: fl.asBool('r'),
    junkPaths: fl.asBool('j'),
    quiet: fl.asBool('q'),
    storeLinks: fl.asBool('y'),
    exclude: fl.asList('x'),
    include: fl.asList('i'),
    update: fl.asBool('u'),
    freshen: fl.asBool('f'),
    delete: fl.asBool('d'),
    moveFiles: fl.asBool('m'),
    level: lastLevel === undefined ? null : Number(lastLevel[0].slice(-1)),
    test: fl.asBool('T'),
    verbose: fl.asBool('v'),
    lineEnds: ends === 0 ? 'keep' : ends === 1 ? 'to_crlf' : 'to_lf',
    noDirectories: fl.asBool('D'),
    temp: fl.asPath('b') ?? null,
    commentMembers: fl.asBool('c'),
    commentArchive: fl.asBool('z'),
    namesFromStdin: fl.asBool('@'),
  }
}

// Standard input, a line each and no trailing empty one. Mirrors Python's
// `_stdin_lines`.
async function stdinLines(stdin: ByteSource | null): Promise<string[]> {
  const text = decodeText(await materialize(stdin))
  if (text === '') return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

/**
 * Walk the operands and hand what they hold to mirage-rs's zip, which names
 * each member, refuses a name two paths share, deflates them and writes the
 * archive. Info-ZIP's defaults are tar's inverted twice over: a directory
 * operand contributes only itself unless `-r` says to descend, and a symlink
 * is followed unless `-y` says to store the link; both are parameters of the
 * shared scan. Mirrors zip_cmd.py.
 */
export async function zipGeneric(
  paths: PathSpec[],
  ctx: Context,
  // What zip needs from the mount it runs on: a reader for the archive and
  // each member, and the stat and walk that make a directory archivable.
  deps: {
    stream: (p: PathSpec) => AsyncIterable<Uint8Array>
    stat: StatFn
    walk: WalkFn
  },
): Promise<CommandFnResult> {
  const flags = parseFlags(ctx.flags)
  const archive = paths[0]
  if (archive === undefined) {
    const stderr = new TextEncoder().encode('zip: usage: zip archive.zip file1 [file2 ...]\n')
    return [null, new IOResult({ exitCode: 1, stderr })]
  }
  const reads: PathSpec[] = [archive]
  const found: util.JSONType[] = []
  const warnings: string[] = []
  const operands = paths.slice(1)
  let lines: string[] = []
  const stdin = ctx.stdin ?? null
  if (flags.namesFromStdin) {
    for (const line of await stdinLines(stdin)) {
      if (line === '') continue
      const spec = PathSpec.fromStrPath(line, undefined, ctx.cwd)
      const mounts = mountView(ctx.vfs) ?? null
      if (mounts !== null && spec.walkError === null && mounts.isRoot(spec.virtual)) {
        const stderr = formatRecords([`zip: cannot read '${line}': Device or resource busy`])
        return [null, new IOResult({ exitCode: 1, stderr })]
      }
      operands.push(
        new PathSpec({
          virtual: spec.virtual,
          directory: spec.directory,
          vfsPath: spec.vfsPath,
          resolved: spec.resolved,
          rawPath: line,
        }),
      )
    }
  } else if (flags.commentMembers || flags.commentArchive) {
    lines = await stdinLines(stdin)
  }
  for (const path of flags.delete ? [] : operands) {
    const raw = path.rawPath
    if (path.walkError !== null) {
      // The walk refused the operand before zip ran (the empty name, a link
      // loop above the name), which Info-ZIP matches to nothing.
      warnings.push(byteView(NOT_MATCHED + raw))
      continue
    }
    const base = rstripSlash(path.virtual) || '/'
    const scan = await scanOperand(path, {
      stat: deps.stat,
      walk: deps.walk,
      links: linksOf(ctx) ?? null,
      // Every mount nested under an operand bounds the scan, a relayed run's too.
      mounts: mountView(ctx.vfs) ?? null,
      dereference: !flags.storeLinks,
      recurse: flags.recursive,
    })
    for (const problem of scan.problems) {
      // Info-ZIP stores a directory it could not open and says nothing about
      // it (pinned on debian:stable-slim).
      if (problem.unreadable === true) continue
      const shown = respellOne(problem.path, base, raw)
      const text =
        problem.fatal === true ? NOT_MATCHED + shown : `${shown}: ${problem.reason ?? ''}`
      warnings.push(byteView(text))
    }
    if (scan.missing) continue
    for (const crossing of scan.crossings) {
      warnings.push(byteView(`${respellOne(crossing, base, raw)}: ${OTHER_FILESYSTEM}`))
    }
    // Info-ZIP walks a bare `.` with an empty prefix, so what it finds there
    // is named bare.
    const spelling = raw === '.' ? '' : raw
    for (const entry of scan.entries) {
      const read = entry.read ?? null
      // Info-ZIP never stores the archive it is writing.
      if (read !== null && read.virtual === archive.virtual) continue
      const item: Record<string, util.JSONType> = {
        spelled: byteView(respellOne(entry.namePath, base, spelling)),
        kind: entry.kind,
        target: byteView(entry.target ?? ''),
        mtime: (await recordedStamp(deps.stat, read))[0],
        source: byteView(entry.namePath),
      }
      if (read !== null) {
        reads.push(read)
        item.path = byteView(read.rawPath)
        item.operand = reads.length
      }
      found.push(item)
    }
  }
  const config: Record<string, util.JSONType> = {
    archive: byteView(archive.rawPath),
    output: byteView(archive.virtual),
    found,
    warnings,
    exclude: flags.exclude.map((pattern) => byteView(pattern)),
    include: flags.include.map((pattern) => byteView(pattern)),
    junk: flags.junkPaths,
    quiet: flags.quiet,
    update: flags.update,
    freshen: flags.freshen,
    refresh_all: (flags.update || flags.freshen) && operands.length === 0,
    delete: flags.delete,
    patterns: flags.delete ? operands.map((path) => byteView(path.rawPath)) : [],
    move_files: flags.moveFiles,
    level: flags.level,
    test: flags.test,
    verbose: flags.verbose,
    line_ends: flags.lineEnds,
    no_directories: flags.noDirectories,
    temp: flags.temp === null ? null : byteView(flags.temp.virtual),
    comment_members: flags.commentMembers,
    comment_archive: flags.commentArchive,
    stdin_lines: lines.map((line) => byteView(line)),
  }
  const host = new StreamHost(reads, deps.stream, ctx, false)
  const io = new IOResult()
  return [hostedStream('zip', config, host, io, ctx.signal), io]
}

/**
 * A zip line stores a link operand as given, its planner deciding whether to
 * follow it (`-y`), and reads below a directory under `-r`. Mirrors Python's
 * `facts`.
 */
export function facts(fl: FlagView, _operands: readonly (string | PathSpec)[]): LineFacts {
  return new LineFacts({ follows: Follow.NONE, readsSubtree: fl.asBool('r') })
}
