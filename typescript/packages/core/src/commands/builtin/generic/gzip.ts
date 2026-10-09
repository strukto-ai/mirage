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
import { flagKwargName } from '../../spec/constants.ts'
import type { FlagValue } from '../../spec/types.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import type { StatFn } from './archive/walk.ts'
import { mountedPath } from '../../../utils/key_prefix.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { gnuBasename } from '../../../utils/path.ts'
import { gzip } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { linkResolver } from '../utils/links.ts'
import { resolveSource, stdinStream } from '../utils/stream.ts'
import { GZIP_SUFFIX } from '../constants.ts'
import {
  besideLink,
  decompressInputs,
  gzipSuffix,
  openGzipInput,
  outputTaken,
  replaceOutput,
  suffixRefusal,
} from './decompress.ts'
import { concat } from '../../../io/cachable_iterator.ts'

interface GzipFlags {
  readonly decompress: boolean
  readonly keep: boolean
  readonly force: boolean
  readonly toStdout: boolean
  readonly quiet: boolean
  readonly suffix: string
  readonly level: number | null
}

// -1..-9, the last one typed, as GNU's option loop keeps it; -1 parses to
// args_1 (AMBIGUOUS_NAMES). Read off the flag tape: an object lists its
// integer-like keys first and in numeric order, so typedOrder cannot rank
// the digits.
function extractLevel(fl: FlagView): number | null {
  const names = new Map<string, number>()
  for (let n = 1; n <= 9; n++) names.set(flagKwargName(String(n)), n)
  const typed = fl.occurrences(...names.keys()).filter(([, value]) => value === true)
  const last = typed.at(-1)
  return last === undefined ? null : (names.get(last[0]) ?? null)
}

function parseFlags(bag: Record<string, FlagValue>): GzipFlags {
  const fl = new FlagView(bag, specOf('gzip'))
  return {
    decompress: fl.asBool('d'),
    keep: fl.asBool('k'),
    force: fl.asBool('f'),
    toStdout: fl.asBool('c'),
    quiet: fl.asBool('q'),
    suffix: fl.asStr('S') ?? GZIP_SUFFIX,
    level: extractLevel(fl),
  }
}

export async function gzipGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  unlink: (p: PathSpec) => Promise<void>,
  stat?: StatFn,
): Promise<CommandFnResult> {
  const {
    decompress,
    keep,
    force,
    toStdout: stdoutMode,
    quiet,
    suffix,
    level,
  } = parseFlags(opts.flags)

  const resolver = linkResolver(opts)

  const refused = suffixRefusal(suffix)
  if (refused !== null) return [null, refused]
  if (decompress)
    return decompressInputs(paths, stream, {
      stdin: opts.stdin,
      keep,
      force,
      quiet,
      suffix,
      toStdout: stdoutMode,
      write,
      unlink,
      ...(stat !== undefined ? { stat } : {}),
      resolver,
    })
  if (paths.length === 0) {
    const result: ByteSource = await gzip(await materialize(resolveSource(opts.stdin)), '', level)
    return [result, new IOResult()]
  }
  const read = stdinStream(stream, opts.stdin)
  const writes: Record<string, Uint8Array> = {}
  const stdout: Uint8Array[] = []
  const lines: string[] = []
  let exitCode = 0
  const report = (line: string, code: number, warning: boolean): void => {
    if (!(warning && quiet)) lines.push(line.replace(/\n$/, ''))
    if (exitCode !== 1) exitCode = code
  }
  for (const p of paths) {
    const inPlace = !(stdoutMode || p.rawPath === '-')
    // An input gzip cannot open is reported and skipped, and the run goes on
    // to the next operand (a directory is a warning, exit 2, silent under
    // -q, and a link without -c or -f is ELOOP); so is an input that already
    // has a suffix, without -f and with no exit code of its own, an output
    // already there without -f, a link standing there included, and a
    // replace -f is refused. An output it cannot create is fatal: gzip's
    // write_error leads with a newline and exits, leaving later operands
    // untouched. Pinned against gzip 1.13 (debian:stable-slim). Mirrors
    // gzip.py.
    let raw: Uint8Array
    let link: string | null = null
    if (p.rawPath === '-') {
      try {
        raw = await materialize(read(p))
      } catch (err) {
        if (!isFsError(err)) throw err
        report(`gzip: ${p.rawPath}: ${String(fsStrerror(err))}`, 1, false)
        continue
      }
    } else {
      const found = await openGzipInput(p, inPlace ? stream : read, report, {
        suffix,
        decompress: false,
        follow: stdoutMode || force,
        resolver,
      })
      if (found === null) continue
      const known = inPlace ? gzipSuffix(p.rawPath, suffix) : null
      if (known !== null && !force) {
        if (!quiet) lines.push(`gzip: ${p.rawPath} already has ${known} suffix -- unchanged`)
        continue
      }
      try {
        raw = await materialize(found.stream)
      } catch (err) {
        if (!isFsError(err)) throw err
        report(`\ngzip: ${p.rawPath}: ${String(fsStrerror(err))}`, 1, false)
        break
      }
      link = found.link
    }
    const data = await gzip(raw, p.rawPath === '-' ? '' : gnuBasename(p.rawPath), level)
    if (!inPlace) {
      stdout.push(data)
      continue
    }
    const outPath = p.mountPath + suffix
    const out = link === null ? mountedPath(p, outPath) : besideLink(link, p.rawPath + suffix)
    const existed = await outputTaken(out, stat, resolver)
    if (existed && !force) {
      lines.push(`gzip: ${p.rawPath}${suffix} already exists;\tnot overwritten`)
      if (exitCode === 0) exitCode = 2
      continue
    }
    try {
      await replaceOutput(out, data, write, resolver, link !== null)
    } catch (err) {
      if (!isFsError(err)) throw err
      lines.push(`${existed ? '' : '\n'}gzip: ${p.rawPath}${suffix}: ${String(fsStrerror(err))}`)
      exitCode = 1
      if (existed) continue
      break
    }
    if (link === null) writes[outPath] = data
    if (!keep) {
      if (link === null || resolver === null) await unlink(p)
      else await resolver.unlink(link)
    }
  }
  const stderr = lines.length > 0 ? new TextEncoder().encode(lines.join('\n') + '\n') : null
  return [
    stdout.length > 0 ? concat(stdout) : null,
    new IOResult({ writes, exitCode, ...(stderr !== null ? { stderr } : {}) }),
  ]
}
