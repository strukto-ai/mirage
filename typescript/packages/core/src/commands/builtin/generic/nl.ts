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
import { operandsIo, readOperands, singleChunk } from '../utils/operands.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function shouldNumber(line: string, bodyNumbering: string, pattern: RegExp | null): boolean {
  if (bodyNumbering === 'n') return false
  if (bodyNumbering === 'a') return true
  if (bodyNumbering === 'p' && pattern !== null) return pattern.test(line)
  return line.trim() !== ''
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value
}

interface NlOptions {
  bodyNumbering: string
  start: number
  increment: number
  width: number
  separator: string
  pattern: RegExp | null
}

async function* nlStream(
  source: AsyncIterable<Uint8Array>,
  opts: NlOptions,
): AsyncIterable<Uint8Array> {
  let num = opts.start
  const iter = new AsyncLineIterator(source)
  for await (const raw of iter) {
    const line = DEC.decode(raw)
    if (shouldNumber(line, opts.bodyNumbering, opts.pattern)) {
      yield ENC.encode(`${padLeft(String(num), opts.width)}${opts.separator}${line}\n`)
      num += opts.increment
    } else {
      yield ENC.encode(`${' '.repeat(opts.width)}${opts.separator}${line}\n`)
    }
  }
}

async function* nlMulti(
  buffers: readonly Uint8Array[],
  opts: NlOptions,
): AsyncIterable<Uint8Array> {
  // One counter across every operand: GNU nl numbering continues from
  // file to file (it resets per logical page, never per file).
  let num = opts.start
  for (const data of buffers) {
    const iter = new AsyncLineIterator(singleChunk(data))
    for await (const raw of iter) {
      const line = DEC.decode(raw)
      if (shouldNumber(line, opts.bodyNumbering, opts.pattern)) {
        yield ENC.encode(`${padLeft(String(num), opts.width)}${opts.separator}${line}\n`)
        num += opts.increment
      } else {
        yield ENC.encode(`${' '.repeat(opts.width)}${opts.separator}${line}\n`)
      }
    }
  }
}

function parseOptions(flags: Record<string, string | boolean | string[]>): NlOptions {
  const b = typeof flags.b === 'string' ? flags.b : 't'
  let bodyNumbering = b
  let pattern: RegExp | null = null
  if (b.startsWith('p')) {
    bodyNumbering = 'p'
    pattern = new RegExp(b.slice(1))
  }
  const parseIntFlag = (key: 'v' | 'i' | 'w', fallback: number): number =>
    typeof flags[key] === 'string' ? Number.parseInt(flags[key], 10) : fallback
  return {
    bodyNumbering,
    start: parseIntFlag('v', 1),
    increment: parseIntFlag('i', 1),
    width: parseIntFlag('w', 6),
    separator: typeof flags.s === 'string' ? flags.s : '\t',
    pattern,
  }
}

export async function nlGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const nlOpts = parseOptions(opts.flags)
  if (paths.length > 0) {
    // Operands read eagerly so a missing one is reported up front and the
    // remaining operands still number (GNU); the IOResult is sealed before
    // the output stream is handed back.
    const [ok, err] = await readOperands(paths, stream, 'nl')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    return [
      nlMulti(
        ok.map((o) => o.data),
        nlOpts,
      ),
      io,
    ]
  }
  try {
    const source = resolveSource(opts.stdin, 'nl: missing operand')
    return [nlStream(source, nlOpts), new IOResult()]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
}
