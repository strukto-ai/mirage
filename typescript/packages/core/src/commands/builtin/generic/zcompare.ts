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

import { isFsError } from '../../../errors/fs.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { utf8Locale } from '../../../shell/bytes.ts'
import { PathSpec, type ReadStreamFn, type ReaddirFn, type StatFn } from '../../../types.ts'
import { gunzipStream } from '../../../utils/compress.ts'
import type { Context } from '../../config.ts'
import { quoteText } from '../../quote.ts'
import { isStdin, resolveSource, stdinStat } from '../utils/stream.ts'
import { cmpGeneric, parseFlags as cmpFlags } from './cmp.ts'
import { diffGeneric, parseFlags as diffFlags } from './diff.ts'

const COMPRESSED_NAME = /(?:[-.]gz[^]*|[-.][zZ]|\.t[ga]z)$/
const STRIPPED_ENDING = /(?:\.t[ga]z|[-.](?:gz|[zZ]))$/
const NOT_A_FILE = 'No such file'
const PROGRAM = '/usr/bin/zdiff'
const FIRST_LINE = 92
const SECOND_LINE = 96

function refusal(line: string): [null, IOResult] {
  return [
    null,
    new IOResult({ exitCode: 2, stderr: new TextEncoder().encode(`${PROGRAM}: ${line}\n`) }),
  ]
}

function unsized(): Promise<number | null> {
  return Promise.resolve(null)
}

function respelled(path: PathSpec, rawPath: string): PathSpec {
  return new PathSpec({
    virtual: path.virtual,
    directory: path.directory,
    resolved: path.resolved,
    vfsPath: path.vfsPath,
    rawPath,
  })
}

/** The file a lone operand is compared with: its name unzipped. */
function partner(path: PathSpec, cwd: string): PathSpec | null {
  const ending = STRIPPED_ENDING.exec(path.rawPath)
  if (ending === null) return null
  const swap = ending[0].startsWith('.t') ? '.tar' : ''
  return PathSpec.fromStrPath(path.rawPath.replace(STRIPPED_ENDING, swap), undefined, cwd)
}

/** Name the sides as the comparison sees them: the second compressed side is
 * standard input, the first `/dev/fd/5`, and with only one compressed, that
 * one is standard input. */
function plan(
  first: PathSpec,
  second: PathSpec,
  lone: boolean,
): { sides: PathSpec[]; decoded: Set<string> } {
  const zippedSecond = !lone && COMPRESSED_NAME.test(second.rawPath)
  const zippedFirst = COMPRESSED_NAME.test(first.rawPath) || (first.rawPath === '-' && zippedSecond)
  const decoded = new Set<string>()
  if (zippedFirst) decoded.add(first.virtual)
  if (zippedSecond) decoded.add(second.virtual)
  if (zippedFirst && zippedSecond) {
    return {
      sides: [respelled(first, '/dev/fd/5'), respelled(second, '-')],
      decoded,
    }
  }
  if (zippedFirst) return { sides: [respelled(first, '-'), second], decoded }
  if (zippedSecond) return { sides: [first, respelled(second, '-')], decoded }
  return { sides: [first, second], decoded }
}

/** Compare files through gzip, `cmp` for zcmp and `diff` for zdiff. */
export async function zcompareGeneric(
  paths: PathSpec[],
  texts: readonly string[],
  ctx: Context,
  read: ReadStreamFn,
  stat: StatFn,
  readdir: ReaddirFn,
  command: 'zcmp' | 'zdiff',
): Promise<[ByteSource | null, IOResult]> {
  const cmpParsed = command === 'zcmp' ? cmpFlags(ctx.flags, texts) : null
  const diffParsed = command === 'zdiff' ? diffFlags(ctx.flags, utf8Locale(ctx.env)) : null
  if (cmpParsed instanceof IOResult) return [null, cmpParsed]
  if (diffParsed instanceof IOResult) return [null, diffParsed]
  const [only, other, extra] = paths
  if (only === undefined) return refusal('missing operand')
  if (extra !== undefined) return refusal(`extra operand '${quoteText(extra.rawPath)}'`)
  let first = only
  let second = other
  const lone = other === undefined
  if (second === undefined) {
    const found = partner(only, ctx.cwd.virtual)
    if (found === null) return refusal(`${only.rawPath}: unknown compressed file extension`)
    second = found
    first = only
  }
  const checks: [PathSpec, number][] = lone
    ? [[first, FIRST_LINE]]
    : [
        [first, FIRST_LINE],
        [second, SECOND_LINE],
      ]
  for (const [operand, line] of checks) {
    if (isStdin(operand)) continue
    try {
      await stat(operand)
    } catch (error) {
      if (!isFsError(error)) throw error
      return refusal(`${String(line)}: cannot open ${operand.rawPath}: ${NOT_A_FILE}`)
    }
  }
  const { sides, decoded } = plan(first, second, lone)
  const isDashSide = (path: PathSpec): boolean =>
    first.rawPath === '-' && path.virtual === first.virtual && decoded.has(path.virtual)
  const reading: ReadStreamFn = (path) => {
    if (!decoded.has(path.virtual)) return read(path)
    if (isDashSide(path)) return gunzipStream(resolveSource(ctx.stdin), false, true)
    return gunzipStream(read(path), false, true)
  }
  const statStdin = stdinStat(stat)
  const statSide: StatFn = (path) => statStdin(isDashSide(path) ? first : path)
  const piped = sides.find((path) => path.rawPath === '-')
  const side: Context =
    piped !== undefined && decoded.has(piped.virtual) ? { ...ctx, stdin: reading(piped) } : ctx
  if (cmpParsed !== null)
    return cmpGeneric(cmpParsed, sides, texts, side, reading, unsized, unsized)
  if (diffParsed !== null)
    return diffGeneric(diffParsed, sides, side, reading, readdir, statSide, unsized)
  throw new Error(`no comparison for ${command}`)
}
