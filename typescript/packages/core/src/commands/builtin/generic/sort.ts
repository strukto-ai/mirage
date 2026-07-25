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

import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import {
  buildConfig,
  compareLines,
  SortKeyError,
  sortLines,
  splitSortLines,
  type SortConfig,
} from '../sort_helper.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

interface SortFlags {
  normalized: Record<string, string | boolean | string[]>
  check: boolean
  checkQuiet: boolean
  output: string | null
  zeroTerminated: boolean
}

function boolAlias(
  flags: Record<string, string | boolean | string[]>,
  short: string,
  long: string,
): boolean {
  return flags[short] === true || flags[long] === true
}

function stringAlias(
  flags: Record<string, string | boolean | string[]>,
  short: string,
  long: string,
): string | null {
  const value = typeof flags[short] === 'string' ? flags[short] : flags[long]
  return typeof value === 'string' ? value : null
}

function listAlias(
  flags: Record<string, string | boolean | string[]>,
  short: string,
  long: string,
): string[] {
  const out: string[] = []
  for (const name of [short, long]) {
    const value = flags[name]
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) out.push(...value)
  }
  return out
}

function parseFlags(flags: Record<string, string | boolean | string[]>): SortFlags | string {
  const rawCheck = flags.check
  if (
    rawCheck !== undefined &&
    rawCheck !== true &&
    rawCheck !== 'diagnose-first' &&
    rawCheck !== 'quiet' &&
    rawCheck !== 'silent'
  ) {
    return `sort: invalid argument '${String(rawCheck)}' for '--check'\n`
  }
  const keys = listAlias(flags, 'k', 'key')
  return {
    normalized: {
      r: boolAlias(flags, 'r', 'reverse'),
      n: boolAlias(flags, 'n', 'numeric_sort'),
      u: boolAlias(flags, 'u', 'unique'),
      f: boolAlias(flags, 'f', 'ignore_case'),
      k: keys,
      t: stringAlias(flags, 't', 'field_separator') ?? '',
      h: boolAlias(flags, 'h', 'human_numeric_sort'),
      V: boolAlias(flags, 'V', 'version_sort'),
      s: boolAlias(flags, 's', 'stable'),
      M: boolAlias(flags, 'M', 'month_sort'),
      b: boolAlias(flags, 'b', 'ignore_leading_blanks'),
      d: boolAlias(flags, 'd', 'dictionary_order'),
      g: boolAlias(flags, 'g', 'general_numeric_sort'),
      i: boolAlias(flags, 'i', 'ignore_nonprinting'),
    },
    check: flags.c === true || rawCheck !== undefined,
    checkQuiet: rawCheck === 'quiet' || rawCheck === 'silent',
    output: stringAlias(flags, 'o', 'output'),
    zeroTerminated: boolAlias(flags, 'z', 'zero_terminated'),
  }
}

function splitRecords(raw: Uint8Array, zeroTerminated: boolean): string[] {
  if (!zeroTerminated) return splitSortLines(DEC.decode(raw))
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
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(parsed) })]
  }
  let cfg: SortConfig
  try {
    cfg = buildConfig(parsed.normalized)
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
    const disorder = checkRecords(records, cfg, parsed.normalized.u === true)
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
