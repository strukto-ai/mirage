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
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec, StatFn } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { byteView } from '../../../shell/bytes.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { respellOne } from '../../../utils/path.ts'
import { OTHER_FILESYSTEM, scanOperand, type WalkFn } from './archive/walk.ts'
import { linksOf, mountView } from '../utils/links.ts'
import { StreamHost, hostedStream } from '../utils/stream_host.ts'

// What Info-ZIP calls a path it could not reach. It does not distinguish
// absent from unreadable, and a dangling symlink under the default follow
// prints exactly this too.
const NOT_MATCHED = 'name not matched: '

// What zip needs from the mount it runs on: a reader for the archive and
// each member, and the stat and walk that make a directory archivable.
export interface ZipDeps {
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>
  stat: StatFn
  walk: WalkFn
}

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
  deps: ZipDeps,
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
  for (const path of paths.slice(1)) {
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
    junk: flags.junkPaths,
    quiet: flags.quiet,
  }
  const host = new StreamHost(reads, deps.stream, ctx, false)
  const io = new IOResult()
  return [hostedStream('zip', config, host, io, ctx.signal), io]
}
