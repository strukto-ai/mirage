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

import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

interface UniqOptions {
  count: boolean
  duplicatesOnly: boolean
  uniqueOnly: boolean
  skipFields: number
  skipChars: number
  checkChars: number | null
  ignoreCase: boolean
}

function parseCount(value: string | boolean | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const count = Number.parseInt(value, 10)
  if (Number.isNaN(count) || count < 0) throw new Error(`uniq: invalid count: '${value}'`)
  return count
}

function comparisonKey(line: Uint8Array, opts: UniqOptions): string {
  let text = DEC.decode(line)
  if (opts.skipFields > 0) {
    const parts = text.split(/\s+/).filter((s) => s !== '')
    const remaining = opts.skipFields < parts.length ? parts.slice(opts.skipFields) : []
    text = remaining.join(' ')
  }
  if (opts.skipChars > 0) text = text.slice(opts.skipChars)
  if (opts.checkChars !== null) text = text.slice(0, opts.checkChars)
  if (opts.ignoreCase) text = text.toLowerCase()
  return text
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value
}

function emitLine(line: Uint8Array, count: number, opts: UniqOptions): Uint8Array | null {
  if (opts.duplicatesOnly && count === 1) return null
  if (opts.uniqueOnly && count > 1) return null
  if (opts.count) {
    const prefix = ENC.encode(`${padLeft(String(count), 7)} `)
    const out = new Uint8Array(prefix.byteLength + line.byteLength + 1)
    out.set(prefix, 0)
    out.set(line, prefix.byteLength)
    out[out.byteLength - 1] = 0x0a
    return out
  }
  const out = new Uint8Array(line.byteLength + 1)
  out.set(line, 0)
  out[line.byteLength] = 0x0a
  return out
}

async function* uniqStream(
  source: AsyncIterable<Uint8Array>,
  opts: UniqOptions,
): AsyncIterable<Uint8Array> {
  let prevLine: Uint8Array | null = null
  let prevKey: string | null = null
  let prevCount = 0
  const iter = new AsyncLineIterator(source)
  for await (const rawLine of iter) {
    const key = comparisonKey(rawLine, opts)
    if (key === prevKey) {
      prevCount += 1
    } else {
      if (prevLine !== null) {
        const chunk = emitLine(prevLine, prevCount, opts)
        if (chunk !== null) yield chunk
      }
      prevLine = rawLine
      prevKey = key
      prevCount = 1
    }
  }
  if (prevLine !== null) {
    const chunk = emitLine(prevLine, prevCount, opts)
    if (chunk !== null) yield chunk
  }
}

function parseOptions(flags: Record<string, string | boolean | string[]>): UniqOptions {
  return {
    count: flags.c === true,
    duplicatesOnly: flags.d === true,
    uniqueOnly: flags.u === true,
    skipFields: parseCount(flags.f) ?? 0,
    skipChars: parseCount(flags.s) ?? 0,
    checkChars: parseCount(flags.w),
    ignoreCase: flags.i === true,
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function uniqGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  if (paths.length > 2) throw extraOperandError(CommandName.UNIQ, paths[2]?.rawPath ?? '')
  const uniqOpts = parseOptions(opts.flags)
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    return [uniqStream(stream(first), uniqOpts), new IOResult({ cache: [first.mountPath] })]
  }
  try {
    const source = resolveSource(opts.stdin, 'uniq: missing operand')
    return [uniqStream(source, uniqOpts), new IOResult()]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
}
