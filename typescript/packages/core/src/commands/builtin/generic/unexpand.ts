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
const DEC = new TextDecoder('utf-8', { fatal: false })

function splitLinesKeepEnds(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

function unexpandLine(line: string, tabsize: number, allSpaces: boolean): string {
  if (allSpaces) {
    const result: string[] = []
    let i = 0
    while (i < line.length) {
      let count = 0
      while (i + count < line.length && line[i + count] === ' ') count += 1
      if (count >= tabsize) {
        const tabs = Math.floor(count / tabsize)
        const remainder = count % tabsize
        result.push('\t'.repeat(tabs) + ' '.repeat(remainder))
        i += count
      } else if (count > 0) {
        result.push(' '.repeat(count))
        i += count
      } else {
        result.push(line[i] ?? '')
        i += 1
      }
    }
    return result.join('')
  }
  let leading = 0
  while (leading < line.length && line[leading] === ' ') leading += 1
  if (leading >= tabsize) {
    const tabs = Math.floor(leading / tabsize)
    const remainder = leading % tabsize
    return '\t'.repeat(tabs) + ' '.repeat(remainder) + line.slice(leading)
  }
  return line
}

export async function unexpandGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const tabsize = typeof opts.flags.t === 'string' ? Number.parseInt(opts.flags.t, 10) : 8
  const allSpaces = opts.flags.a === true
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the remaining operands
    // still unexpand (GNU unexpand).
    const [ok, err] = await readOperands(paths, stream, 'unexpand')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    const parts: string[] = []
    for (const o of ok) {
      const data = DEC.decode(o.data)
      for (const ln of splitLinesKeepEnds(data)) parts.push(unexpandLine(ln, tabsize, allSpaces))
    }
    const result: ByteSource = ENC.encode(parts.join(''))
    return [result, io]
  }
  const stdinData = await readStdinAsync(opts.stdin)
  if (stdinData === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('unexpand: missing operand\n') })]
  }
  const text = DEC.decode(stdinData)
  const lines = splitLinesKeepEnds(text)
  const result: ByteSource = ENC.encode(
    lines.map((ln) => unexpandLine(ln, tabsize, allSpaces)).join(''),
  )
  return [result, new IOResult()]
}
