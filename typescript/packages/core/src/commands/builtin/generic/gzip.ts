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
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { LineFacts, PathSpec, type ReaddirFn, type StatFn } from '../../../types.ts'
import { gnuBasename } from '../../../utils/path.ts'
import { gzipCompressStream } from '../../../utils/compress.ts'
import { isoTimestamp } from '../../../utils/dates.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { linkResolver } from '../utils/links.ts'
import { formatRecords } from '../utils/output.ts'
import { STDIN_OPERAND } from '../utils/constants.ts'
import { stdinStream } from '../utils/stream.ts'
import { GZIP_SUFFIX } from '../constants.ts'
import {
  besideLink,
  decompressInputs,
  existsLine,
  gzipRatio,
  gzipSuffix,
  inputInfo,
  keepAttributes,
  listInputs,
  openGzipInput,
  outputTaken,
  removeInput,
  replaceOutput,
  suffixRefusal,
  verboseLine,
  walked,
  type SetAttrsFn,
} from './decompress.ts'
import { ByteSpool } from '../../../io/spool.ts'
import { OutputStream, closeQuietly, drain } from '../../../io/stream.ts'

export interface GzipFlags {
  readonly decompress: boolean
  readonly keep: boolean
  readonly force: boolean
  readonly toStdout: boolean
  readonly quiet: boolean
  readonly verbose: boolean
  readonly test: boolean
  readonly listing: boolean
  readonly recursive: boolean
  readonly named: boolean | null
  readonly suffix: string
  readonly level: number | null
}

// -1..-9, the last one typed, as the reference's option loop keeps it; -1
// and -9 are --fast and --best, keyed by those names. Read off the flag
// tape: an object lists its integer-like keys first and in numeric order, so
// typedOrder cannot rank the digits.
const LEVELS = new Map<string, number>([
  ['fast', 1],
  ...Array.from({ length: 7 }, (_, i): [string, number] => [String(i + 2), i + 2]),
  ['best', 9],
])

function extractLevel(fl: FlagView): number | null {
  const typed = fl.occurrences(...LEVELS.keys()).filter(([, value]) => value === true)
  const last = typed.at(-1)
  return last === undefined ? null : (LEVELS.get(last[0]) ?? null)
}

// Of a family where the last one typed wins, that one's key.
function lastOf(fl: FlagView, ...names: string[]): string | null {
  const typed = fl.occurrences(...names).filter(([, value]) => value === true)
  return typed.at(-1)?.[0] ?? null
}

/** gzip's options for `command`: gunzip always decompresses and zcat also
 * writes to stdout; -q and -v, and -n and -N, are each a pair where the last
 * one typed wins. Mirrors Python's parse_flags. */
export function parseFlags(bag: Record<string, FlagValue>, command = 'gzip'): GzipFlags {
  const fl = new FlagView(bag, specOf(command))
  const loud = lastOf(fl, 'quiet', 'verbose')
  const name = lastOf(fl, 'no_name', 'name')
  return {
    decompress: command !== 'gzip' || fl.asBool('decompress'),
    keep: fl.asBool('keep'),
    force: fl.asBool('force'),
    toStdout: command === 'zcat' || fl.asBool('stdout'),
    quiet: loud === 'quiet',
    verbose: loud === 'verbose',
    test: fl.asBool('test'),
    listing: fl.asBool('list'),
    recursive: fl.asBool('recursive'),
    named: name === null ? null : name === 'name',
    suffix: fl.asStr('suffix') ?? GZIP_SUFFIX,
    level: extractLevel(fl),
  }
}

async function* counted(
  source: AsyncIterable<Uint8Array>,
  count: number[],
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    count[0] = (count[0] ?? 0) + chunk.byteLength
    yield chunk
  }
}

/**
 * gzip, gunzip and zcat over resolved operands, stdin when none.
 *
 * -l lists and -t tests, both decompressing; -d decompresses. In compression
 * each input stores its name and time unless -n, and an in-place output takes
 * the input's mode and times; under -r a directory gives way to the files
 * below it, where one already suffixed is passed over, said only under -v;
 * -v says each input's ratio once done. Mirrors Python's gzip_generic.
 */
export async function gzipGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write?: (p: PathSpec, data: ByteSource) => Promise<void>,
  unlink?: (p: PathSpec) => Promise<void>,
  stat?: StatFn,
  readdir?: ReaddirFn,
  setAttrs?: SetAttrsFn,
  command = 'gzip',
): Promise<CommandFnResult> {
  const flags = parseFlags(ctx.flags, command)
  const { keep, force, toStdout, quiet, verbose, recursive, named, suffix, level } = flags
  const resolver = linkResolver(ctx)
  const refused = suffixRefusal(suffix)
  if (refused !== null) return [null, refused]
  const files = {
    ...(stat !== undefined ? { stat } : {}),
    ...(readdir !== undefined ? { readdir } : {}),
  }
  if (flags.listing)
    return listInputs(paths, stream, {
      stdin: ctx.stdin,
      quiet,
      verbose,
      restore: named === true,
      recursive,
      suffix,
      ...files,
      resolver,
    })
  if (flags.decompress || flags.test)
    return decompressInputs(paths, stream, {
      stdin: ctx.stdin,
      keep,
      force,
      quiet,
      verbose,
      restore: named === true,
      recursive,
      suffix,
      toStdout,
      testOnly: flags.test,
      ...(write !== undefined ? { write } : {}),
      ...(unlink !== undefined ? { unlink } : {}),
      ...files,
      ...(setAttrs !== undefined ? { setAttrs } : {}),
      resolver,
    })
  const operands = paths.length > 0 ? paths : [STDIN_OPERAND]
  const read = stdinStream(stream, ctx.stdin)
  const io = new IOResult()
  const lines: string[] = []
  const note = (line: string): void => {
    lines.push(line.replace(/\n$/, ''))
    io.stderr = formatRecords(lines)
  }
  const report = (line: string, code: number, warning: boolean): void => {
    if (!(warning && quiet)) note(line)
    if (io.exitCode !== 1) io.exitCode = code
  }
  async function* run(): AsyncGenerator<Uint8Array> {
    for await (const [p] of walked(operands, report, { recursive, ...files })) {
      const onStdin = p.rawPath === '-'
      const inPlace = !(toStdout || onStdin)
      const found = onStdin
        ? null
        : await openGzipInput(p, inPlace ? stream : read, report, {
            suffix,
            decompress: false,
            follow: toStdout || force,
            resolver,
          })
      if (found === null && !onStdin) continue
      const input = found === null ? read(p) : found.stream
      const link = found?.link ?? null
      try {
        const known = inPlace ? gzipSuffix(p.rawPath, suffix) : null
        if (known !== null && !force) {
          if (verbose || !(recursive || quiet))
            note(`gzip: ${p.rawPath} already has ${known} suffix -- unchanged`)
          continue
        }
        const info = await inputInfo(stat, p)
        const stamp = info === null ? null : isoTimestamp(info.modified)
        const name = onStdin || named === false ? '' : gnuBasename(p.rawPath)
        const readIn = [0]
        const written = [0]
        const compressed = counted(
          gzipCompressStream(
            counted(input, readIn),
            level,
            name,
            stamp === null || named === false ? 0 : Math.trunc(stamp),
          ),
          written,
        )
        const header = 18 + (name === '' ? 0 : new TextEncoder().encode(name).byteLength + 1)
        const ratio = (): string => gzipRatio(readIn[0] ?? 0, written[0] ?? 0, header)
        if (!inPlace) {
          try {
            yield* compressed
          } catch (error) {
            if (!isFsError(error)) throw error
            report(`\ngzip: ${p.rawPath}: ${String(fsStrerror(error))}`, 1, false)
            return
          }
          if (verbose) note(onStdin ? ratio() : verboseLine(p.rawPath, ratio(), keep, 'stdout'))
          continue
        }
        if (write === undefined || unlink === undefined)
          throw new Error('in-place compression requires write and unlink')
        const spool = new ByteSpool()
        const out =
          link === null
            ? PathSpec.fromStrPath(`/${stripSlash(p.virtual)}${suffix}`)
            : besideLink(link, p.rawPath + suffix)
        try {
          try {
            await spool.fill(compressed)
          } catch (error) {
            if (!isFsError(error)) throw error
            report(`\ngzip: ${p.rawPath}: ${String(fsStrerror(error))}`, 1, false)
            return
          }
          const existed = await outputTaken(out, stat, resolver)
          if (existed && !force) {
            report(existsLine(p.rawPath + suffix), 2, false)
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
        await keepAttributes(setAttrs, out, info)
        if (verbose) note(verboseLine(p.rawPath, ratio(), keep, p.rawPath + suffix))
        if (!keep) await removeInput(p, link, unlink, resolver)
      } finally {
        await closeQuietly(input)
      }
    }
  }
  const body = new OutputStream(run(), () => closeQuietly(ctx.stdin))
  if (!toStdout && operands.every((p) => p.rawPath !== '-')) {
    await drain(body)
    return [null, io]
  }
  return [body, io]
}

/** A gzip line replaces its file operands unless `-c`, `-t` or `-l`. Mirrors
 * Python's `facts`. */
export function facts(fl: FlagView, operands: readonly (string | PathSpec)[]): LineFacts {
  return new LineFacts({
    writes: operands.length > 0 && !['stdout', 'test', 'list'].some((n) => fl.asBool(n)),
  })
}
