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

import { IOResult, materialize } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

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

function parseCount(value: string | boolean | string[] | undefined): number | null {
  if (value === undefined || value === false) return null
  if (typeof value !== 'string') throw new Error(`uniq: invalid count: '${String(value)}'`)
  const normalized = value.trim()
  if (!/^[+-]?\d+$/.test(normalized)) throw new Error(`uniq: invalid count: '${value}'`)
  const count = Number(normalized)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`uniq: invalid count: '${value}'`)
  return count
}

function stringAlias(
  flags: Record<string, string | boolean | string[]>,
  short: string,
  long: string,
): string | boolean | string[] | undefined {
  return flags[short] ?? flags[long]
}

function optionalMethod(
  value: string | boolean | string[] | undefined,
  defaultValue: string,
  allowed: string[],
  option: string,
): string | null {
  if (value === undefined || value === false) return null
  const normalized = value === true ? defaultValue : value
  if (typeof normalized !== 'string' || !allowed.includes(normalized)) {
    throw new Error(`uniq: invalid argument '${String(normalized)}' for '--${option}'`)
  }
  return normalized
}

function parseFlags(flags: Record<string, string | boolean | string[]>): UniqFlags {
  const count = flags.c === true || flags.count === true
  const duplicatesOnly = flags.d === true || flags.repeated === true
  const uniqueOnly = flags.u === true || flags.unique === true
  const allRepeated = optionalMethod(
    flags.D === true ? true : flags.all_repeated,
    'none',
    ['none', 'prepend', 'separate'],
    'all-repeated',
  ) as UniqFlags['allRepeated']
  const group = optionalMethod(
    flags.group,
    'separate',
    ['separate', 'prepend', 'append', 'both'],
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
    skipFields: parseCount(stringAlias(flags, 'f', 'skip_fields')) ?? 0,
    skipChars: parseCount(stringAlias(flags, 's', 'skip_chars')) ?? 0,
    checkChars: parseCount(stringAlias(flags, 'w', 'check_chars')),
    ignoreCase: flags.i === true || flags.ignore_case === true,
    allRepeated,
    group,
    zeroTerminated: flags.z === true || flags.zero_terminated === true,
  }
}

function isBlank(char: string | undefined): boolean {
  return char === ' ' || char === '\t'
}

function skipFields(text: string, count: number): string {
  let index = 0
  for (let field = 0; field < count; field += 1) {
    while (index < text.length && isBlank(text[index])) index += 1
    while (index < text.length && !isBlank(text[index])) index += 1
  }
  return text.slice(index)
}

function comparisonKey(line: Uint8Array, flags: UniqFlags): string {
  let characters = Array.from(skipFields(DEC.decode(line), flags.skipFields))
  if (flags.skipChars > 0) characters = characters.slice(flags.skipChars)
  if (flags.checkChars !== null) characters = characters.slice(0, flags.checkChars)
  const text = characters.join('')
  return flags.ignoreCase ? text.toLowerCase() : text
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength)
  output.set(left)
  output.set(right, left.byteLength)
  return output
}

async function* records(
  source: AsyncIterable<Uint8Array>,
  separator: number,
): AsyncIterable<Uint8Array> {
  let buffer: Uint8Array = new Uint8Array()
  for await (const chunk of source) {
    buffer = concatBytes(buffer, chunk)
    let start = 0
    for (let index = 0; index < buffer.byteLength; index += 1) {
      if (buffer[index] !== separator) continue
      yield buffer.slice(start, index)
      start = index + 1
    }
    buffer = buffer.slice(start)
  }
  if (buffer.byteLength > 0) yield buffer
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value
}

function formatRecord(
  line: Uint8Array,
  count: number,
  flags: UniqFlags,
  separator: number,
): Uint8Array {
  const prefix = flags.count ? ENC.encode(`${padLeft(String(count), 7)} `) : new Uint8Array()
  const output = new Uint8Array(prefix.byteLength + line.byteLength + 1)
  output.set(prefix)
  output.set(line, prefix.byteLength)
  output[output.byteLength - 1] = separator
  return output
}

function groupSeparatorBefore(index: number, method: NonNullable<UniqFlags['group']>): boolean {
  if (method === 'prepend' || method === 'both') return true
  return index > 0
}

async function collectGroups(
  source: AsyncIterable<Uint8Array>,
  flags: UniqFlags,
  separator: number,
): Promise<Uint8Array[][]> {
  const groups: Uint8Array[][] = []
  let current: Uint8Array[] = []
  let currentKey: string | null = null
  for await (const line of records(source, separator)) {
    const key = comparisonKey(line, flags)
    if (current.length > 0 && key !== currentKey) {
      groups.push(current)
      current = []
    }
    current.push(line)
    currentKey = key
  }
  if (current.length > 0) groups.push(current)
  return groups
}

async function* uniqStream(
  source: AsyncIterable<Uint8Array>,
  flags: UniqFlags,
): AsyncIterable<Uint8Array> {
  const separator = flags.zeroTerminated ? 0 : 0x0a
  const groups = await collectGroups(source, flags, separator)
  if (flags.group !== null) {
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index] ?? []
      if (groupSeparatorBefore(index, flags.group)) yield Uint8Array.of(separator)
      for (const line of group) yield formatRecord(line, 1, { ...flags, count: false }, separator)
    }
    if (groups.length > 0 && (flags.group === 'append' || flags.group === 'both')) {
      yield Uint8Array.of(separator)
    }
    return
  }
  if (flags.allRepeated !== null) {
    let emitted = 0
    for (const group of groups) {
      if (group.length === 1) continue
      if (flags.allRepeated === 'prepend' || (flags.allRepeated === 'separate' && emitted > 0)) {
        yield Uint8Array.of(separator)
      }
      for (const line of group) yield formatRecord(line, 1, { ...flags, count: false }, separator)
      emitted += 1
    }
    return
  }
  for (const group of groups) {
    const first = group[0]
    if (first === undefined) continue
    if (flags.duplicatesOnly && group.length === 1) continue
    if (flags.uniqueOnly && group.length > 1) continue
    yield formatRecord(first, group.length, flags, separator)
  }
}

export async function uniqGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write?: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  if (paths.length > 2) throw extraOperandError(CommandName.UNIQ, paths[2]?.rawPath ?? '')
  let parsed: UniqFlags
  try {
    parsed = parseFlags(opts.flags)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${message}\n`) })]
  }
  let source: AsyncIterable<Uint8Array>
  const cache: string[] = []
  if (paths.length > 0) {
    const input = paths[0]
    if (input === undefined) return [null, new IOResult()]
    source = stream(input)
    cache.push(input.mountPath)
  } else {
    try {
      source = resolveSource(opts.stdin)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${message}\n`) })]
    }
  }
  const output = uniqStream(source, parsed)
  const outputPath = paths[1]
  if (outputPath !== undefined) {
    if (write === undefined) {
      return [
        null,
        new IOResult({ exitCode: 1, stderr: ENC.encode('uniq: output is not writable\n') }),
      ]
    }
    const data = await materialize(output)
    await write(outputPath, data)
    cache.push(outputPath.mountPath)
    return [new Uint8Array(), new IOResult({ writes: { [outputPath.mountPath]: data }, cache })]
  }
  return [output, new IOResult({ cache })]
}
