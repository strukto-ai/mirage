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

import { stdinStat, stdinStream, streamOutput } from '../utils/stream.ts'
import { splitReadable } from '../utils/operands.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { wordRefusalError, extraOperandError } from '../../spec/usage.ts'
import { matchWord } from '../../spec/word_choice.ts'
import { CommandName, type FlagValue, type ParsedFlagValue } from '../../spec/types.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { specOf } from '../../spec/builtins.ts'
import { resolveSource } from '../utils/stream.ts'
import { openStream } from '../../../rs/stream.ts'
import { encodeText } from '../../../shell/bytes.ts'

interface UniqFlags {
  count: boolean
  duplicatesOnly: boolean
  uniqueOnly: boolean
  skipFields: number
  skipChars: number
  checkChars: number | null
  ignoreCase: boolean
  allRepeated: 'none' | 'prepend' | 'separate' | null
  group: 'separate' | 'prepend' | 'append' | 'both' | null
  zeroTerminated: boolean
}

// How GNU reads a -f, -s or -w count: leading C whitespace, a sign and
// decimal digits, nothing after them.
const COUNT_WORD = /^[ \t\n\v\f\r]*[+-]?[0-9]+$/
const SKIP_FIELDS = 'fields to skip'
const SKIP_CHARS = 'bytes to skip'
const CHECK_CHARS = 'bytes to compare'

// A -f, -s or -w count: decimal, never negative, any size (a huge one is
// clamped, as GNU clamps it to SIZE_MAX).
function parseCount(value: ParsedFlagValue | undefined, what: string): number | null {
  if (value === undefined || value === false) return null
  const text = String(value)
  const count = COUNT_WORD.test(text) ? Number(text.trim()) : Number.NaN
  if (!(count >= 0)) throw new Error(`uniq: ${text}: invalid number of ${what}`)
  return Math.min(count, Number.MAX_SAFE_INTEGER)
}

// The --all-repeated and --group words, in the order GNU lists each back. No
// aliases in either, so one candidate per line.
const ALL_REPEATED_ARGS = ['none', 'prepend', 'separate'] as const
const GROUP_ARGS = ['prepend', 'append', 'separate', 'both'] as const

function optionalMethod(
  value: ParsedFlagValue | undefined,
  defaultValue: string,
  allowed: readonly string[],
  option: string,
): string | null {
  if (value === undefined || value === false) return null
  const normalized = value === true ? defaultValue : value
  const word = String(normalized)
  // A non-string bag value (a number, a list) is not a candidate word at
  // all, so it never reaches the matcher and reads as invalid.
  const match = typeof normalized === 'string' ? matchWord(word, allowed) : null
  if (match?.matched !== true) {
    const kind = match === null ? 'invalid' : match.kind
    throw wordRefusalError('uniq', `--${option}`, word, allowed, undefined, kind)
  }
  return match.word
}

function parseFlags(bag: Record<string, FlagValue>): UniqFlags {
  const fl = new FlagView(bag, specOf('uniq'))
  const count = fl.asBool('count')
  const duplicatesOnly = fl.asBool('repeated')
  const uniqueOnly = fl.asBool('unique')
  const allRepeated = optionalMethod(
    fl.asBool('D') ? true : (fl.raw('all_repeated') as ParsedFlagValue | undefined),
    'none',
    ALL_REPEATED_ARGS,
    'all-repeated',
  ) as UniqFlags['allRepeated']
  const group = optionalMethod(
    fl.raw('group') as ParsedFlagValue | undefined,
    'separate',
    GROUP_ARGS,
    'group',
  ) as UniqFlags['group']
  if (group !== null && (count || duplicatesOnly || uniqueOnly || allRepeated !== null)) {
    throw new Error('uniq: --group is mutually exclusive with -c/-d/-D/-u')
  }
  if (count && allRepeated !== null) {
    throw new Error('uniq: printing all duplicated lines and repeat counts is meaningless')
  }
  return {
    count,
    duplicatesOnly,
    uniqueOnly,
    skipFields: parseCount(fl.asStr('skip_fields'), SKIP_FIELDS) ?? 0,
    skipChars: parseCount(fl.asStr('skip_chars'), SKIP_CHARS) ?? 0,
    checkChars: parseCount(fl.asStr('check_chars'), CHECK_CHARS),
    ignoreCase: fl.asBool('ignore_case'),
    allRepeated,
    group,
    zeroTerminated: fl.asBool('zero_terminated'),
  }
}

export async function uniqGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write?: (p: PathSpec, data: Uint8Array) => Promise<void>,
  stat?: (p: PathSpec) => Promise<FileStat>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, ctx.stdin)
  if (paths.length > 2) throw extraOperandError(CommandName.UNIQ, paths[2]?.rawPath ?? '')
  let parsed: UniqFlags
  try {
    parsed = parseFlags(ctx.flags)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(`${message}\n`) })]
  }
  if (paths.length > 0 && stat !== undefined) {
    // The input is stat'ed before the lazy stream starts, so a missing or
    // unreadable one is reported in uniq's own words rather than
    // surfacing mid-drain.
    const [, err] = await splitReadable(paths.slice(0, 1), stdinStat(stat), 'uniq')
    if (err !== '') return [null, new IOResult({ exitCode: 1, stderr: encodeText(err) })]
  }
  let source: AsyncIterable<Uint8Array>
  if (paths.length > 0) {
    const input = paths[0]
    if (input === undefined) return [null, new IOResult()]
    source = stream(input)
  } else {
    try {
      source = resolveSource(ctx.stdin)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 1, stderr: encodeText(`${message}\n`) })]
    }
  }
  const output = streamOutput(
    await openStream('uniq', {
      count: parsed.count,
      repeated: parsed.duplicatesOnly,
      unique: parsed.uniqueOnly,
      skip_fields: parsed.skipFields,
      skip_chars: parsed.skipChars,
      check_chars: parsed.checkChars,
      ignore_case: parsed.ignoreCase,
      all_repeated: parsed.allRepeated,
      group: parsed.group,
      zero_terminated: parsed.zeroTerminated,
    }),
    source,
    ctx.signal,
  )
  const outputPath = paths[1]
  if (outputPath !== undefined && outputPath.rawPath !== '-') {
    if (write === undefined) {
      return [
        null,
        new IOResult({ exitCode: 1, stderr: encodeText('uniq: output is not writable\n') }),
      ]
    }
    const data = await materialize(output)
    await write(outputPath, data)
    return [new Uint8Array(), new IOResult()]
  }
  return [output, new IOResult()]
}
