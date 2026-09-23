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

import { stdinStream } from '../utils/stream.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { SortKeyError } from '../errors.ts'
import {
  buildConfig,
  compareLines,
  sortLines,
  type SortConfig,
  type SortGlobals,
} from '../sort_keys.ts'
import { splitLines } from '../utils/lines.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { argmatchError } from '../../spec/usage.ts'
import { argmatch } from '../../spec/argmatch.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

interface SortFlags extends SortGlobals {
  check: boolean
  checkQuiet: boolean
  output: string | null
  zeroTerminated: boolean
}

// `check_args` as gnulib's `argmatch_valid` prints it: `quiet` and
// `silent` map to the same value, so they share one `  - ` line.
const CHECK_ARGS: readonly (readonly string[])[] = [['quiet', 'silent'], ['diagnose-first']]

function parseFlags(bag: Record<string, FlagValue>): SortFlags | string {
  const fl = new FlagView(bag, specOf('sort'))
  const rawCheck = fl.raw('check')
  let checkWord: string | null = null
  if (rawCheck !== undefined && rawCheck !== true) {
    const word = String(rawCheck)
    const match = argmatch(word, CHECK_ARGS)
    if (!match.matched) {
      return argmatchError('sort', '--check', word, CHECK_ARGS, 1, match.kind).message + '\n'
    }
    checkWord = match.word
  }
  return {
    reverse: fl.asBool('reverse'),
    numeric: fl.asBool('numeric_sort'),
    unique: fl.asBool('unique'),
    foldCase: fl.asBool('ignore_case'),
    keyDefs: fl.asList('key'),
    fieldSep: fl.asStr('field_separator') ?? null,
    humanNumeric: fl.asBool('human_numeric_sort'),
    versionSort: fl.asBool('version_sort'),
    monthSort: fl.asBool('month_sort'),
    ignoreBlanks: fl.asBool('ignore_leading_blanks'),
    stable: fl.asBool('stable'),
    generalNumeric: fl.asBool('general_numeric_sort'),
    dictionary: fl.asBool('dictionary_order'),
    ignoreNonprinting: fl.asBool('ignore_nonprinting'),
    check: fl.asBool('c') || rawCheck !== undefined,
    // The canonical word of the ['quiet', 'silent'] value is `quiet`, so
    // `--check=s` and `--check=silent` both land here.
    checkQuiet: checkWord === 'quiet',
    output: fl.asStr('output') ?? null,
    zeroTerminated: fl.asBool('zero_terminated'),
  }
}

function splitRecords(raw: Uint8Array, zeroTerminated: boolean): string[] {
  if (!zeroTerminated) return splitLines(DEC.decode(raw))
  const records: string[] = []
  let start = 0
  for (let index = 0; index < raw.byteLength; index++) {
    if (raw[index] === 0) {
      records.push(DEC.decode(raw.subarray(start, index)))
      start = index + 1
    }
  }
  if (start < raw.byteLength) records.push(DEC.decode(raw.subarray(start)))
  return records
}

function checkRecords(records: readonly string[], cfg: SortConfig, unique: boolean): number | null {
  for (let index = 1; index < records.length; index++) {
    const previous = records[index - 1]
    const current = records[index]
    if (previous === undefined || current === undefined) continue
    const comparison = compareLines(previous, current, cfg)
    if (comparison > 0 || (unique && comparison === 0)) return index
  }
  return null
}

export async function sortGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (path: PathSpec) => AsyncIterable<Uint8Array>,
  write?: (path: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, opts.stdin)
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string') {
    // gnulib's argmatch dies with EXIT_FAILURE, so `--check=x` is 1 where
    // sort's other usage errors are 2.
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(parsed) })]
  }
  let cfg: SortConfig
  try {
    cfg = buildConfig(parsed)
  } catch (error) {
    if (error instanceof SortKeyError) {
      return [
        new Uint8Array(),
        new IOResult({ stderr: ENC.encode(`sort: ${error.message}\n`), exitCode: 2 }),
      ]
    }
    throw error
  }
  if (parsed.check && paths.length > 1) {
    const label = paths[1]?.rawPath ?? ''
    return [
      new Uint8Array(),
      new IOResult({
        stderr: ENC.encode(`sort: extra operand '${label}' not allowed with -c\n`),
        exitCode: 2,
      }),
    ]
  }
  let raw: Uint8Array = new Uint8Array()
  if (paths.length > 0) {
    const parts: Uint8Array[] = []
    for (const path of paths) parts.push(await materialize(stream(path)))
    const size = parts.reduce((total, part) => total + part.byteLength, 0)
    raw = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      raw.set(part, offset)
      offset += part.byteLength
    }
  } else {
    raw = (await readStdinAsync(opts.stdin)) ?? new Uint8Array()
  }
  const records = splitRecords(raw, parsed.zeroTerminated)
  if (parsed.check) {
    const disorder = checkRecords(records, cfg, parsed.unique)
    if (disorder === null) return [new Uint8Array(), new IOResult()]
    if (parsed.checkQuiet) return [new Uint8Array(), new IOResult({ exitCode: 1 })]
    const label = paths[0]?.rawPath ?? '-'
    const line = records[disorder] ?? ''
    return [
      new Uint8Array(),
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode(`sort: ${label}:${String(disorder + 1)}: disorder: ${line}\n`),
      }),
    ]
  }
  const sorted = sortLines(records, cfg)
  const separator = parsed.zeroTerminated ? '\0' : '\n'
  const output: Uint8Array =
    sorted.length === 0 ? new Uint8Array() : ENC.encode(sorted.join(separator) + separator)
  if (parsed.output !== null) {
    if (write === undefined) {
      return [
        new Uint8Array(),
        new IOResult({
          exitCode: 2,
          stderr: ENC.encode('sort: output is not writable on this backend\n'),
        }),
      ]
    }
    const outputPath = PathSpec.fromStrPath(
      parsed.output,
      mountKey(parsed.output, opts.mountPrefix ?? ''),
    )
    await write(outputPath, output)
    return [
      new Uint8Array(),
      new IOResult({ writes: { [outputPath.mountPath]: output }, cache: [outputPath.mountPath] }),
    ]
  }
  const out: ByteSource = output
  return [out, new IOResult()]
}
