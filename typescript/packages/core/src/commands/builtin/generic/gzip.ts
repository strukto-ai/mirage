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
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { gnuBasename } from '../../../utils/path.ts'
import { gzipCompressStream } from '../../../utils/compress.ts'
import type { CommandFnResult, Context } from '../../config.ts'
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
import { ByteSpool } from '../../../io/spool.ts'
import { OutputStream, closeQuietly, drain } from '../../../io/stream.ts'

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
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: ByteSource) => Promise<void>,
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
  } = parseFlags(ctx.flags)

  const resolver = linkResolver(ctx)

  const refused = suffixRefusal(suffix)
  if (refused !== null) return [null, refused]
  if (decompress)
    return decompressInputs(paths, stream, {
      stdin: ctx.stdin,
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
    const result: ByteSource = gzipCompressStream(resolveSource(ctx.stdin), level)
    return [result, new IOResult()]
  }
  const read = stdinStream(stream, ctx.stdin)
  const io = new IOResult()
  const lines: string[] = []
  const report = (line: string, code: number, warning: boolean): void => {
    if (!(warning && quiet)) {
      lines.push(line.replace(/\n$/, ''))
      io.stderr = new TextEncoder().encode(lines.join('\n') + '\n')
    }
    if (io.exitCode !== 1) io.exitCode = code
  }
  async function* run(): AsyncGenerator<Uint8Array> {
    for (const p of paths) {
      const inPlace = !(stdoutMode || p.rawPath === '-')
      const found =
        p.rawPath === '-'
          ? null
          : await openGzipInput(p, inPlace ? stream : read, report, {
              suffix,
              decompress: false,
              follow: stdoutMode || force,
              resolver,
            })
      if (found === null && p.rawPath !== '-') continue
      const input = found === null ? read(p) : found.stream
      const link = found?.link ?? null
      try {
        const known = inPlace ? gzipSuffix(p.rawPath, suffix) : null
        if (known !== null && !force) {
          report(`gzip: ${p.rawPath} already has ${known} suffix -- unchanged`, io.exitCode, true)
          continue
        }
        const compressed = gzipCompressStream(
          input,
          level,
          p.rawPath === '-' ? '' : gnuBasename(p.rawPath),
        )
        if (!inPlace) {
          try {
            yield* compressed
          } catch (error) {
            if (!isFsError(error)) throw error
            report(`\ngzip: ${p.rawPath}: ${String(fsStrerror(error))}`, 1, false)
            return
          }
          continue
        }
        const spool = new ByteSpool()
        try {
          try {
            await spool.fill(compressed)
          } catch (error) {
            if (!isFsError(error)) throw error
            report(`\ngzip: ${p.rawPath}: ${String(fsStrerror(error))}`, 1, false)
            return
          }
          const out =
            link === null
              ? mountedPath(p, p.mountPath + suffix)
              : besideLink(link, p.rawPath + suffix)
          const existed = await outputTaken(out, stat, resolver)
          if (existed && !force) {
            report(`gzip: ${p.rawPath}${suffix} already exists;\tnot overwritten`, 2, false)
            continue
          }
          try {
            await replaceOutput(out, spool.stream(), write, resolver, link !== null)
          } catch (error) {
            if (!isFsError(error)) throw error
            report(
              `${existed ? '' : '\n'}gzip: ${p.rawPath}${suffix}: ${String(fsStrerror(error))}`,
              1,
              false,
            )
            if (existed) continue
            return
          }
        } finally {
          await spool.close()
        }
        if (!keep) {
          if (link === null || resolver === null) await unlink(p)
          else await resolver.unlink(link)
        }
      } finally {
        await closeQuietly(input)
      }
    }
  }
  const body = new OutputStream(run(), () => closeQuietly(ctx.stdin))
  if (!stdoutMode && paths.every((p) => p.rawPath !== '-')) {
    await drain(body)
    return [null, io]
  }
  return [body, io]
}
