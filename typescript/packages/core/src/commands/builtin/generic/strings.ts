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

import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { operandsIo, readOperands } from '../utils/operands.ts'

const ENC = new TextEncoder()

function extractStrings(data: Uint8Array, minLen: number): string[] {
  const out: string[] = []
  let current: number[] = []
  for (let i = 0; i < data.byteLength; i++) {
    const b = data[i] ?? 0
    if (b >= 0x20 && b <= 0x7e) {
      current.push(b)
    } else {
      if (current.length >= minLen) {
        out.push(String.fromCharCode(...current))
      }
      current = []
    }
  }
  if (current.length >= minLen) {
    out.push(String.fromCharCode(...current))
  }
  return out
}

export async function stringsGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const minLen = typeof opts.flags.n === 'string' ? Number.parseInt(opts.flags.n, 10) : 4
  // Each operand is scanned independently and the matches concatenate in
  // operand order, like GNU strings.
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the remaining operands
    // still scan (GNU strings).
    const [ok, err] = await readOperands(paths, stream, 'strings')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    let output = ''
    for (const o of ok) {
      const matches = extractStrings(o.data, minLen)
      if (matches.length > 0) output += matches.join('\n') + '\n'
    }
    const result: ByteSource = ENC.encode(output)
    return [result, io]
  }
  const stdinData = await readStdinAsync(opts.stdin)
  const matches = extractStrings(stdinData ?? new Uint8Array(0), minLen)
  const output = matches.length > 0 ? matches.join('\n') + '\n' : ''
  const result: ByteSource = ENC.encode(output)
  return [result, new IOResult()]
}
