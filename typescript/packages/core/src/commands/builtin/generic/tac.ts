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
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
import { operandsIo, readOperands, singleChunk } from '../utils/operands.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function reverseSource(
  source: AsyncIterable<Uint8Array>,
  separator: string,
  before: boolean,
  regex: boolean,
): Promise<Uint8Array> {
  const text = DEC.decode(await materialize(source))
  const pattern = regex ? separator : escapeRegex(separator)
  const matcher = new RegExp(`(${pattern})`, 'g')
  const parts = text.split(matcher)
  const records: string[] = []
  for (let index = 0; index < parts.length - 1; index += 2) {
    records.push(
      before
        ? (parts[index + 1] ?? '') + (parts[index] ?? '')
        : (parts[index] ?? '') + (parts[index + 1] ?? ''),
    )
  }
  if (parts.length % 2 === 1 && parts.at(-1) !== '') records.push(parts.at(-1) ?? '')
  return ENC.encode(records.reverse().join(''))
}

export async function tacGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const separatorValue = opts.flags.s ?? opts.flags.separator
  const separator = typeof separatorValue === 'string' ? separatorValue : '\n'
  const before = opts.flags.b === true || opts.flags.before === true
  const regex = opts.flags.r === true || opts.flags.regex === true
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the remaining operands
    // still reverse (GNU tac).
    const [ok, err] = await readOperands(paths, stream, 'tac')
    const io = operandsIo(err, { cache: ok.map((o) => o.path.virtual) })
    if (ok.length === 0 && err !== '') return [null, io]
    const parts: Uint8Array[] = []
    let total = 0
    for (const o of ok) {
      const part = await reverseSource(singleChunk(o.data), separator, before, regex)
      parts.push(part)
      total += part.byteLength
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      out.set(part, offset)
      offset += part.byteLength
    }
    const result: ByteSource = out
    return [result, io]
  }
  const result: ByteSource = await reverseSource(
    resolveSource(opts.stdin),
    separator,
    before,
    regex,
  )
  return [result, new IOResult()]
}
