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
import { wordRefusalError } from '../../spec/usage.ts'
import { matchWord } from '../../spec/word_choice.ts'
import type { FlagValue, ParsedFlagValue } from '../../spec/types.ts'
import { OPERAND } from '../../spec/constants.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { specOf } from '../../spec/builtins.ts'
import { resolveSource } from '../utils/stream.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused } from '../../../rs/scan.ts'
import { openStream, openStreamSync } from '../../../rs/stream.ts'
import { byteView, encodeText } from '../../../shell/bytes.ts'
import type { JsonValue } from '../../../types.ts'

export interface UniqFlags {
  count: boolean
  duplicatesOnly: boolean
  uniqueOnly: boolean
  typed: [string, string][]
  ignoreCase: boolean
  allRepeated: 'none' | 'prepend' | 'separate' | null
  group: 'separate' | 'prepend' | 'append' | 'both' | null
  zeroTerminated: boolean
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
  return {
    count,
    duplicatesOnly,
    uniqueOnly,
    typed: fl.texts(OPERAND, 'skip_fields', 'skip_chars', 'check_chars'),
    ignoreCase: fl.asBool('ignore_case'),
    allRepeated,
    group,
    zeroTerminated: fl.asBool('zero_terminated'),
  }
}

/** The options GNU uniq refuses together once it has read them all. Mirrors
 * Python's `_conflict`. */
function conflict(parsed: UniqFlags): string | null {
  if (
    parsed.group !== null &&
    (parsed.count || parsed.duplicatesOnly || parsed.uniqueOnly || parsed.allRepeated !== null)
  ) {
    return 'uniq: --group is mutually exclusive with -c/-d/-D/-u'
  }
  if (parsed.count && parsed.allRepeated !== null) {
    return 'uniq: printing all duplicated lines and repeat counts is meaningless'
  }
  return null
}

/**
 * uniq's options, its counts and operands refused by the engine in the order
 * typed, before any operand is read: the flags, or uniq's refusal. The flags
 * carry each operand's glob spread over its matches. Mirrors Python's
 * `uniq_flags`.
 */
export function uniqFlags(bag: Record<string, FlagValue>): UniqFlags | IOResult {
  let parsed: UniqFlags
  try {
    parsed = parseFlags(bag)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return new IOResult({ exitCode: 1, stderr: encodeText(`${message}\n`) })
  }
  try {
    openStreamSync('uniq', engineConfig(parsed)).close()
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
  const refusal = conflict(parsed)
  if (refusal !== null) return new IOResult({ exitCode: 1, stderr: encodeText(`${refusal}\n`) })
  return parsed
}

/** The uniq engine's config, the counts and operands as typed. Mirrors Python's
 * `engine_config`. */
export function engineConfig(parsed: UniqFlags): Record<string, JsonValue> {
  return {
    count: parsed.count,
    repeated: parsed.duplicatesOnly,
    unique: parsed.uniqueOnly,
    typed: parsed.typed.map(([name, text]) => [name, byteView(text)]),
    ignore_case: parsed.ignoreCase,
    all_repeated: parsed.allRepeated,
    group: parsed.group,
    zero_terminated: parsed.zeroTerminated,
  }
}

export async function uniqGeneric(
  parsed: UniqFlags,
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write?: (p: PathSpec, data: Uint8Array) => Promise<void>,
  stat?: (p: PathSpec) => Promise<FileStat>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, ctx.stdin)
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
  const output = streamOutput(await openStream('uniq', engineConfig(parsed)), source, ctx.signal)
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
